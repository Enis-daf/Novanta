import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RegleCorrespondance } from "./comptaCorrespondance";
import { perimetresStock } from "./comptaExercices";
import { calculerPnlComptable, SoldeCompte, soldesDeLaPeriode } from "./comptaPnl";
import { AjustementComptable, arbitrageParMois, ChoixStock, deciderStockParExercice, trierAjustements } from "./comptaStocks";
import { ajustementsDepuisStocks, StockFinDeMois } from "./pastAdjustments";
import { calculerPnlCashEstime } from "./pastPnlCashEstime";
import { indexerMappings } from "./pastCategoryMapping";

const REGLES: RegleCorrespondance[] = [
  { prefixe: "70", destination: "revenue", categorie: "Ventes" },
  { prefixe: "60", destination: "direct_costs", categorie: "Achats" },
  { prefixe: "603", destination: "inventory_variation", categorie: "Stock" },
  { prefixe: "68", destination: "depreciation", categorie: "Dotations" },
  { prefixe: "64", destination: "structure_costs", categorie: "RH" },
];
const S = (compte: string, mois: string, debit: number, credit: number): SoldeCompte => ({ compte, mois, debit, credit, nombreLignes: 0 });
const EXERCICE = { idSource: "26", debut: "2026-01-01", fin: "2026-12-31", statut: "open" };
const ANNEE = { debut: "2026-01-01", fin: "2026-12-31" };
const PERIMETRES = perimetresStock(ANNEE, [EXERCICE]);
const BASE = [S("706000", "2026-01", 0, 1000), S("706000", "2026-12", 0, 1000), S("607000", "2026-01", 300, 0)];
const ECRITURE_ANNUELLE = S("603700", "2026-12", 0, 900);
// Stocks mensuels : janvier sert de départ ; variation de février à décembre, 100 par mois, soit +1 100.
const STOCKS: StockFinDeMois[] = Array.from({ length: 12 }, (_, i) => ({ mois: `2026-${String(i + 1).padStart(2, "0")}`, valeur: 1000 + i * 100 }));
const VARIATIONS = ajustementsDepuisStocks(STOCKS);

function pnl(soldes: SoldeCompte[], variations = VARIATIONS, choix: ReadonlyMap<string, ChoixStock> = new Map(), periode = ANNEE) {
  const decisions = deciderStockParExercice({ perimetres: PERIMETRES, soldes, regles: REGLES, variationsNovanta: variations, choix });
  return {
    decision: decisions[0],
    pnl: calculerPnlComptable({ soldes: soldesDeLaPeriode(soldes, periode), regles: REGLES, variationsStockNovanta: variations.filter((a) => a.date >= periode.debut && a.date <= periode.fin), arbitrageStockParMois: arbitrageParMois(decisions), conflitStock: decisions.some((d) => d.conflit) }),
  };
}
const choixDe = (source: ChoixStock["source"], montantPennylane: number | null = 900, montantNovanta: number | null = 1100) => new Map([["2026-01-01", { source, montantPennylane, montantNovanta, choisiLe: "2027-03-01T00:00:00Z" }]]);

describe("Une seule source par exercice", () => {
  test("variation uniquement dans Novanta : la saisie s'applique, sans conflit", () => {
    const { decision, pnl: p } = pnl(BASE);
    assert.equal(decision.source, "novanta");
    assert.equal(decision.conflit, false);
    assert.equal(p.variationStocks, 1100);
    assert.equal(p.stock.source, "novanta");
  });

  test("variation uniquement dans Pennylane : l'écriture s'applique", () => {
    const { decision, pnl: p } = pnl([...BASE, ECRITURE_ANNUELLE], []);
    assert.equal(decision.source, "pennylane");
    assert.equal(p.variationStocks, 900);
  });

  test("société sans stock : aucune source", () => {
    const { decision, pnl: p } = pnl(BASE, []);
    assert.equal(decision.source, "aucune");
    assert.equal(p.variationStocks, 0);
  });

  test("les deux dans le même mois : conflit, jamais additionnées", () => {
    const { decision, pnl: p } = pnl([...BASE, S("603700", "2026-06", 0, 900)]);
    assert.equal(decision.conflit, true);
    assert.equal(p.variationStocks, 900);
    assert.equal(p.complet, false);
  });

  test("écriture annuelle en décembre et saisies mensuelles : conflit sur tout l'exercice", () => {
    const { decision, pnl: p } = pnl([...BASE, ECRITURE_ANNUELLE]);
    assert.equal(decision.conflit, true);
    assert.deepEqual(decision.moisPennylane, ["2026-12"]);
    assert.equal(decision.moisNovanta.length, 11);
    assert.equal(p.variationStocks, 900);
    assert.notEqual(p.variationStocks, 900 + 1100);
  });

  test("saisies sur un mois sans écriture, écriture sur un autre : conflit quand même", () => {
    const { decision } = pnl([...BASE, S("603700", "2026-12", 0, 900)], ajustementsDepuisStocks([{ mois: "2026-02", valeur: 10 }, { mois: "2026-03", valeur: 20 }]));
    assert.equal(decision.conflit, true);
  });

  test("le conflit se voit depuis un mois sans aucune écriture de stock", () => {
    const { pnl: p } = pnl([...BASE, ECRITURE_ANNUELLE], VARIATIONS, new Map(), { debut: "2026-03-01", fin: "2026-03-31" });
    assert.equal(p.stock.conflit, true);
  });

  test("en cours d'exercice, avant toute écriture annuelle : le mensuel Novanta s'applique", () => {
    const { pnl: p } = pnl(BASE, VARIATIONS, new Map(), { debut: "2026-03-01", fin: "2026-03-31" });
    assert.equal(p.variationStocks, 100);
    assert.equal(p.stock.conflit, false);
  });

  test("une écriture à débit et crédit nuls n'est pas une écriture de stock", () => {
    assert.equal(pnl([...BASE, S("603700", "2026-12", 0, 0)]).decision.conflit, false);
  });
});

describe("Arbitrage de l'utilisateur", () => {
  const soldes = [...BASE, ECRITURE_ANNUELLE];

  test("choix Novanta : l'écriture sort, un seul montant reste, sur l'année comme sur un mois", () => {
    assert.equal(pnl(soldes, VARIATIONS, choixDe("novanta")).pnl.variationStocks, 1100);
    assert.equal(pnl(soldes, VARIATIONS, choixDe("novanta"), { debut: "2026-12-01", fin: "2026-12-31" }).pnl.variationStocks, 100);
  });

  test("choix Pennylane : les saisies sortent, y compris les mois sans écriture", () => {
    assert.equal(pnl(soldes, VARIATIONS, choixDe("pennylane")).pnl.variationStocks, 900);
    assert.equal(pnl(soldes, VARIATIONS, choixDe("pennylane"), { debut: "2026-03-01", fin: "2026-03-31" }).pnl.variationStocks, 0);
  });

  test("le choix est conservé : plus de conflit, ni de question", () => {
    const { decision, pnl: p } = pnl(soldes, VARIATIONS, choixDe("novanta"));
    assert.equal(decision.conflit, false);
    assert.equal(p.stock.conflit, false);
  });

  test("source modifiée après le choix : source inchangée, et signalé", () => {
    const { decision } = pnl([...BASE, S("603700", "2026-12", 0, 950)], VARIATIONS, choixDe("pennylane"));
    assert.equal(decision.source, "pennylane");
    assert.equal(decision.conflit, false);
    assert.equal(decision.sourceModifieeDepuisChoix, true);
  });

  test("montants inconnus au moment du choix : aucune fausse alerte", () => {
    assert.equal(pnl(soldes, VARIATIONS, choixDe("novanta", null, null)).decision.sourceModifieeDepuisChoix, false);
  });

  test("source inchangée : rien à signaler", () => {
    assert.equal(pnl(soldes, VARIATIONS, choixDe("novanta")).decision.sourceModifieeDepuisChoix, false);
  });

  test("source retenue qui disparaît : l'autre s'applique seule, sans double comptage", () => {
    const { decision, pnl: p } = pnl(BASE, VARIATIONS, choixDe("pennylane"));
    assert.equal(decision.source, "novanta");
    assert.equal(p.variationStocks, 1100);
  });

  test("retirer le choix rouvre le conflit", () => {
    assert.equal(pnl(soldes, VARIATIONS, choixDe(null)).decision.conflit, true);
  });

  test("le choix d'un exercice ne touche pas le suivant", () => {
    const perimetres = perimetresStock({ debut: "2026-01-01", fin: "2027-12-31" }, [EXERCICE, { idSource: "27", debut: "2027-01-01", fin: "2027-12-31", statut: "open" }]);
    const variations = ajustementsDepuisStocks([{ mois: "2026-11", valeur: 1 }, { mois: "2026-12", valeur: 2 }, { mois: "2027-01", valeur: 3 }]);
    const decisions = deciderStockParExercice({ perimetres, soldes: [ECRITURE_ANNUELLE, S("603700", "2027-06", 0, 5)], regles: REGLES, variationsNovanta: variations, choix: choixDe("novanta") });
    assert.equal(decisions[0].conflit, false);
    assert.equal(decisions[1].conflit, true);
  });

  test("période à cheval, exercices arbitrés différemment : source mixte, sans addition sur un même mois", () => {
    const perimetres = perimetresStock({ debut: "2026-11-01", fin: "2027-02-28" }, [EXERCICE, { idSource: "27", debut: "2027-01-01", fin: "2027-12-31", statut: "open" }]);
    const variations = ajustementsDepuisStocks([{ mois: "2026-11", valeur: 100 }, { mois: "2026-12", valeur: 150 }, { mois: "2027-01", valeur: 170 }]);
    const soldes2 = [S("603700", "2027-01", 0, 9)];
    const decisions = deciderStockParExercice({ perimetres, soldes: soldes2, regles: REGLES, variationsNovanta: variations, choix: new Map() });
    const p = calculerPnlComptable({ soldes: soldes2, regles: REGLES, variationsStockNovanta: variations, arbitrageStockParMois: arbitrageParMois(decisions) });
    // 2026 : Novanta seule (+50). 2027 : conflit, l'écriture seule (+9).
    assert.equal(p.variationStocks, 59);
    assert.equal(p.stock.source, "mixte");
  });
});

describe("Données historiques", () => {
  const mapping = indexerMappings([{ sourceCategoryId: "v", sourceCategoryName: "V", sourceGroupId: "a", pnlStage: "revenue", vatRate: 20 }]);
  const transaction = { id: "t", sourceType: "pennylane" as const, transactionDate: "2026-03-10", label: "x", amount: 1200, currency: "EUR", affectations: [{ groupId: "a", categoryId: "v", categoryName: "V", weight: 1 }] };

  test("le P&L cash estimé ne dépend d'aucune donnée comptable : arbitrage ou pas, même chiffre", () => {
    const cash = calculerPnlCashEstime([transaction], "a", mapping, VARIATIONS);
    pnl([...BASE, ECRITURE_ANNUELLE], VARIATIONS, choixDe("pennylane"));
    assert.deepEqual(calculerPnlCashEstime([transaction], "a", mapping, VARIATIONS), cash);
    assert.equal(cash.margeBrute, 1000 + 1100);
  });

  test("la série des stocks saisis n'est pas modifiée par un arbitrage", () => {
    const avant = JSON.stringify(VARIATIONS);
    pnl([...BASE, ECRITURE_ANNUELLE], VARIATIONS, choixDe("pennylane"));
    assert.equal(JSON.stringify(VARIATIONS), avant);
  });
});

describe("Ajustements de gestion du P&L comptable", () => {
  const A = (date: string, montant: number, ligne: AjustementComptable["ligne"] = "depreciation"): AjustementComptable => ({ id: date, date, ligne, libelle: "Amortissement mensuel", montant, notes: null });

  test("sans dotation en comptabilité : l'ajustement s'applique, à sa ligne, identifiable", () => {
    const { appliques, ecartes } = trierAjustements({ ajustements: [A("2026-03-31", -100)], perimetres: PERIMETRES, soldes: BASE, regles: REGLES });
    assert.equal(ecartes.length, 0);
    const p = calculerPnlComptable({ soldes: BASE, regles: REGLES, ajustements: appliques });
    assert.equal(p.amortissements, -100);
    assert.equal(p.resultatExploitation, p.ebitda - 100);
    assert.equal(p.ajustementsGestion[0].libelle, "Amortissement mensuel");
  });

  test("dotation annuelle comptabilisée dans l'exercice : les ajustements de cet exercice sont écartés, même d'un autre mois", () => {
    const soldes = [...BASE, S("681120", "2026-12", 1200, 0)];
    const { appliques, ecartes } = trierAjustements({ ajustements: [A("2026-03-31", -100)], perimetres: PERIMETRES, soldes, regles: REGLES });
    assert.equal(appliques.length, 0);
    assert.equal(ecartes.length, 1);
    assert.equal(calculerPnlComptable({ soldes, regles: REGLES, ajustements: appliques }).amortissements, -1200);
  });

  test("le contrôle d'exhaustivité des comptes n'est pas faussé par un ajustement", () => {
    const p = calculerPnlComptable({ soldes: BASE, regles: REGLES, ajustements: [A("2026-03-31", -100)] });
    assert.equal(p.controle.equilibre, true);
    assert.equal(p.controle.totalAffecte, 1700);
    assert.equal(p.resultatNet, 1600);
  });

  test("Aucun calcul d'amortissement : seules les valeurs saisies comptent", () => {
    assert.equal(calculerPnlComptable({ soldes: BASE, regles: REGLES }).amortissements, 0);
  });
});
