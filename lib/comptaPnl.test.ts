import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ajustementsDepuisStocks } from "./pastAdjustments";
import {
  affecterCompte,
  erreurRegle,
  estCompteDeResultat,
  HORS_PERIMETRE,
  indexerRegles,
  MODELE_CORRESPONDANCE,
  normaliserCompte,
  regleDuCompte,
  RegleCorrespondance,
} from "./comptaCorrespondance";
import { COMPTES_FIXTURES, LIGNES_FIXTURES } from "./comptaFixtures";
import { calculerPnlComptable, deciderStock, estSignificatif, LigneEcriture, periodeEnMoisEntiers, SoldeCompte, soldesDeLaPeriode, soldesDepuisLignes } from "./comptaPnl";

const ANNEE = { debut: "2026-01-01", fin: "2026-12-31" };
const R = (prefixe: string, destination: RegleCorrespondance["destination"], categorie = prefixe): RegleCorrespondance => ({ prefixe, destination, categorie });
const L = (compte: string, debit: number, credit: number, date = "2026-03-15", exclue?: boolean): LigneEcriture => ({ compte, date, debit, credit, exclue });
const pnlDe = (lignes: LigneEcriture[], regles: RegleCorrespondance[], periode = ANNEE, reste = {}) =>
  calculerPnlComptable({ soldes: soldesDepuisLignes(lignes, periode), regles, ...reste });

const REGLES = [
  R("70", "revenue", "Ventes"),
  R("60", "direct_costs", "Achats"),
  R("603", "inventory_variation", "Stock"),
  R("62", "other_variable_costs", "Variables"),
  R("61", "structure_costs", "Structure"),
  R("64", "structure_costs", "RH"),
  R("68", "depreciation", "Dotations"),
  R("66", "financial", "Fin"),
  R("76", "financial", "Fin"),
  R("67", "other_items", "Exc"),
  R("69", "income_tax", "IS"),
];

describe("Racines de comptes", () => {
  const index = indexerRegles([R("6", "structure_costs"), R("60", "direct_costs"), R("604", "other_variable_costs"), R("6041", "direct_costs", "Fabrication")]);

  test("la racine la plus longue l'emporte", () => {
    assert.equal(regleDuCompte("604100", index)?.prefixe, "6041");
    assert.equal(regleDuCompte("604200", index)?.prefixe, "604");
    assert.equal(regleDuCompte("601000", index)?.prefixe, "60");
    assert.equal(regleDuCompte("640000", index)?.prefixe, "6");
  });

  test("une racine courte seule suffit, un compte égal à la racine aussi", () => {
    assert.equal(regleDuCompte("6041", index)?.prefixe, "6041");
    assert.equal(regleDuCompte("6", index)?.prefixe, "6");
    assert.equal(regleDuCompte("70", index), null);
  });

  test("statuts : affecté, hors périmètre explicite, non affecté, bilan", () => {
    const i = indexerRegles([R("70", "revenue"), R("791", HORS_PERIMETRE)]);
    assert.equal(affecterCompte("706000", i).statut, "affecte");
    assert.equal(affecterCompte("791000", i).statut, "hors_perimetre");
    assert.equal(affecterCompte("601000", i).statut, "non_affecte");
    assert.equal(affecterCompte("411000", i).statut, "bilan");
    assert.equal(affecterCompte("890000", i).statut, "bilan");
  });

  test("un compte de bilan ne peut pas être forcé dans le P&L", () => {
    assert.match(erreurRegle(R("411", "revenue"))!, /comptes de résultat/);
    assert.match(erreurRegle(R("1", HORS_PERIMETRE))!, /comptes de résultat/);
    assert.equal(erreurRegle(R("706", "revenue")), null);
  });

  test("règles invalides refusées", () => {
    assert.ok(erreurRegle(R("7a", "revenue")));
    assert.ok(erreurRegle(R("70", "revenue", "   ")));
    assert.ok(erreurRegle(R("70", "inconnue" as never)));
    assert.ok(erreurRegle(R("70", "revenue", "x".repeat(81))));
  });

  test("numéros normalisés, jamais devinés", () => {
    assert.equal(normaliserCompte("706 000"), "706000");
    assert.equal(normaliserCompte("ABC"), "");
    assert.equal(normaliserCompte("401ABCDEF"), "401ABCDEF");
    assert.equal(normaliserCompte("401-A"), "");
    assert.equal(estCompteDeResultat("512000"), false);
  });

  test("le modèle ne contient aucun doublon de racine et reste dans les classes 6 et 7", () => {
    const prefixes = MODELE_CORRESPONDANCE.map((r) => r.prefixe);
    assert.equal(new Set(prefixes).size, prefixes.length);
    for (const regle of MODELE_CORRESPONDANCE) assert.equal(erreurRegle(regle), null, regle.prefixe);
  });

  test("le modèle reprend le principe du fichier : 6041 en coûts directs, 604 en coûts variables, 61 en structure", () => {
    const index = indexerRegles([...MODELE_CORRESPONDANCE]);
    assert.equal(regleDuCompte("604100", index)?.destination, "direct_costs");
    assert.equal(regleDuCompte("604000", index)?.destination, "other_variable_costs");
    assert.equal(regleDuCompte("613200", index)?.destination, "structure_costs");
    assert.equal(regleDuCompte("621000", index)?.destination, "structure_costs");
    assert.equal(regleDuCompte("768000", index)?.destination, "financial");
    assert.equal(regleDuCompte("706000", index)?.destination, "revenue");
  });
});

describe("Signes débit / crédit", () => {
  test("produit au crédit positif, charge au débit négative", () => {
    const pnl = pnlDe([L("706000", 0, 1000), L("601000", 400, 0)], REGLES);
    assert.equal(pnl.chiffreAffaires, 1000);
    assert.equal(pnl.coutsDirects, -400);
    assert.equal(pnl.margeBrute, 600);
  });

  test("avoir client : débit d'un produit, en déduction du CA", () => {
    assert.equal(pnlDe([L("706000", 0, 1000), L("706000", 150, 0)], REGLES).chiffreAffaires, 850);
  });

  test("avoir fournisseur : crédit d'une charge, en déduction de la charge", () => {
    assert.equal(pnlDe([L("601000", 400, 0), L("601000", 0, 50)], REGLES).coutsDirects, -350);
  });

  test("écriture et extourne s'annulent sur une période qui couvre les deux", () => {
    const lignes = [L("613000", 1000, 0, "2026-02-28"), L("613000", 0, 1000, "2026-03-01")];
    assert.equal(pnlDe(lignes, REGLES).coutsStructure, 0);
  });

  test("une extourne se lit sur son mois : période partielle fidèle à la date d'écriture", () => {
    const lignes = [L("613000", 1000, 0, "2026-02-28"), L("613000", 0, 1000, "2026-03-01")];
    assert.equal(pnlDe(lignes, REGLES, { debut: "2026-02-01", fin: "2026-02-28" }).coutsStructure, -1000);
    assert.equal(pnlDe(lignes, REGLES, { debut: "2026-03-01", fin: "2026-03-31" }).coutsStructure, 1000);
  });

  test("le crédit et le débit d'une même ligne se compensent", () => {
    assert.equal(pnlDe([L("706000", 10, 15)], REGLES).chiffreAffaires, 5);
  });
});

describe("Cascade", () => {
  const lignes = [
    L("706000", 0, 10_000),
    L("601000", 3_000, 0),
    L("603000", 0, 500),
    L("623000", 1_000, 0),
    L("613000", 800, 0),
    L("641000", 2_000, 0),
    L("681000", 300, 0),
    L("661000", 100, 0),
    L("768000", 0, 40),
    L("671000", 60, 0),
    L("695000", 700, 0),
  ];
  const pnl = pnlDe(lignes, REGLES);

  test("niveaux calculés depuis les catégories élémentaires", () => {
    assert.equal(pnl.margeBrute, 10_000 - 3_000 + 500);
    assert.equal(pnl.margeContributive, 7_500 - 1_000);
    assert.equal(pnl.ebitda, 6_500 - 2_800);
    assert.equal(pnl.resultatExploitation, 3_700 - 300);
    assert.equal(pnl.elementsFinanciers, -60);
    assert.equal(pnl.autresElements, -60);
    assert.equal(pnl.impots, -700);
    assert.equal(pnl.resultatNet, 3_400 - 60 - 60 - 700);
  });

  test("résultat net = produits − charges de tous les comptes de résultat", () => {
    const produitsMoinsCharges = lignes.filter((l) => /^[67]/.test(l.compte)).reduce((total, l) => total + l.credit - l.debit, 0);
    assert.equal(pnl.resultatNet, produitsMoinsCharges);
    assert.equal(pnl.controle.equilibre, true);
  });

  test("pas de double compte : la somme des catégories égale le résultat net", () => {
    const somme = pnl.categories.reduce((total, c) => total + c.montant, 0);
    assert.equal(Math.round(somme * 100) / 100, pnl.resultatNet);
    const comptes = pnl.categories.flatMap((c) => c.comptes);
    assert.equal(new Set(comptes).size, comptes.length);
  });

  test("ratios rapportés au CA ; CA nul : pas de ratio", () => {
    assert.equal(pnl.ratios.margeBrute, 0.75);
    assert.equal(pnlDe([L("601000", 10, 0)], REGLES).ratios.margeBrute, null);
  });

  test("comptes de bilan exclus du P&L, conservés dans l'analyse des comptes", () => {
    const avecBilan = pnlDe([...lignes, L("411000", 9_999, 0), L("512000", 0, 9_999), L("445710", 0, 1_000)], REGLES);
    assert.equal(avecBilan.resultatNet, pnl.resultatNet);
    assert.equal(avecBilan.comptes.find((c) => c.compte === "411000")?.statut, "bilan");
    assert.equal(avecBilan.controle.equilibre, true);
  });

  test("compte hors périmètre explicite : écarté sans être une anomalie", () => {
    const p = pnlDe([L("706000", 0, 100), L("791000", 0, 25)], [...REGLES, R("791", HORS_PERIMETRE)]);
    assert.equal(p.resultatNet, 100);
    assert.equal(p.nonAffectes.comptes.length, 0);
    assert.equal(p.controle.totalHorsPerimetre, 25);
    assert.equal(p.complet, true);
  });

  test("période partielle : seules les dates de la période comptent, bornes incluses", () => {
    const p = pnlDe([L("706000", 0, 1, "2026-02-28"), L("706000", 0, 10, "2026-03-01"), L("706000", 0, 100, "2026-03-31"), L("706000", 0, 1000, "2026-04-01")], REGLES, { debut: "2026-03-01", fin: "2026-03-31" });
    assert.equal(p.chiffreAffaires, 110);
  });

  test("écritures annulées ou provisoires : exclues si (et seulement si) la source le dit", () => {
    assert.equal(pnlDe([L("706000", 0, 100), L("706000", 0, 999, "2026-03-15", true)], REGLES).chiffreAffaires, 100);
  });

  test("société sans écriture : P&L vide, reconnu comme tel", () => {
    const vide = pnlDe([], REGLES);
    assert.equal(vide.aDesEcritures, false);
    assert.equal(vide.resultatNet, 0);
    assert.equal(vide.ratios.resultatNet, null);
  });

  test("changer une règle reclasse sans modifier le résultat net", () => {
    const autre = pnlDe(lignes, REGLES.map((r) => (r.prefixe === "62" ? R("62", "structure_costs", "Autre") : r)));
    assert.equal(autre.resultatNet, pnl.resultatNet);
    assert.equal(autre.margeContributive, pnl.margeContributive + 1_000);
    assert.equal(autre.ebitda, pnl.ebitda);
  });
});

describe("Exhaustivité", () => {
  test("compte sans affectation listé avec son montant, absent des niveaux", () => {
    const p = pnlDe([L("706000", 0, 100_000), L("658000", 300, 0)], REGLES);
    assert.deepEqual(p.nonAffectes.comptes.map((c) => [c.compte, c.montant]), [["658000", -300]]);
    assert.equal(p.resultatNet, 100_000);
    assert.equal(p.controle.totalNonAffecte, -300);
    assert.equal(p.controle.equilibre, true);
  });

  test("significatif : le résultat n'est plus présenté comme complet", () => {
    const p = pnlDe([L("706000", 0, 10_000), L("658000", 5_000, 0)], REGLES);
    assert.equal(p.nonAffectes.significatif, true);
    assert.equal(p.complet, false);
  });

  test("deux comptes qui se compensent restent significatifs : pas de masquage par le net", () => {
    const p = pnlDe([L("706000", 0, 10_000), L("658000", 5_000, 0), L("758000", 0, 5_000)], REGLES);
    assert.equal(p.nonAffectes.montant, 0);
    assert.equal(p.nonAffectes.significatif, true);
    assert.equal(p.complet, false);
  });

  test("faible montant : présenté, avec l'alerte", () => {
    const p = pnlDe([L("706000", 0, 100_000), L("658000", 80, 0)], REGLES);
    assert.equal(p.nonAffectes.comptes.length, 1);
    assert.equal(p.nonAffectes.significatif, false);
    assert.equal(p.complet, true);
  });

  test("seuil : le plus grand de 100 € ou 0,5 % du CA", () => {
    assert.equal(estSignificatif(100, 0), false);
    assert.equal(estSignificatif(100.01, 0), true);
    assert.equal(estSignificatif(500, 100_000), false);
    assert.equal(estSignificatif(500.01, 100_000), true);
  });

  test("un nouveau compte couvert par une racine existante est affecté sans action", () => {
    assert.equal(pnlDe([L("613999", 10, 0)], REGLES).coutsStructure, -10);
  });

  test("un nouveau compte sans racine apparaît immédiatement comme non affecté", () => {
    assert.equal(pnlDe([L("654321", 10, 0)], REGLES).nonAffectes.comptes[0].compte, "654321");
  });
});

describe("Lecture par balance mensuelle", () => {
  const solde = (compte: string, mois: string, debit: number, credit: number): SoldeCompte => ({ compte, mois, debit, credit, nombreLignes: 0 });

  test("les soldes de plusieurs mois se cumulent par numéro, sans nombre de lignes", () => {
    const p = calculerPnlComptable({ soldes: [solde("706000", "2026-01", 0, 100), solde("706000", "2026-02", 10, 50)], regles: REGLES });
    assert.equal(p.chiffreAffaires, 140);
    assert.equal(p.aDesEcritures, true);
  });

  test("balance et lignes donnent le même P&L", () => {
    const parLignes = pnlDe([L("706000", 0, 100, "2026-03-05"), L("706000", 10, 0, "2026-03-20"), L("601000", 40, 0, "2026-03-07")], REGLES);
    const parBalance = calculerPnlComptable({ soldes: [solde("706000", "2026-03", 10, 100), solde("601000", "2026-03", 40, 0)], regles: REGLES });
    assert.equal(parBalance.resultatNet, parLignes.resultatNet);
    assert.equal(parBalance.margeBrute, parLignes.margeBrute);
  });

  test("compte non affecté à solde nul mais mouvementé : encore listé", () => {
    const p = calculerPnlComptable({ soldes: [solde("658000", "2026-03", 25, 25)], regles: REGLES });
    assert.deepEqual(p.nonAffectes.comptes.map((c) => c.compte), ["658000"]);
  });

  test("compte de résultat à numéro alphanumérique : suit sa racine, ne disparaît pas", () => {
    const p = calculerPnlComptable({ soldes: [solde("613ABC", "2026-03", 25, 0)], regles: REGLES });
    assert.equal(p.coutsStructure, -25);
  });

  test("numéro illisible : compté, et le résultat n'est plus présenté comme complet", () => {
    const p = calculerPnlComptable({ soldes: [solde("706000", "2026-03", 0, 100), solde("???", "2026-03", 5, 0)], regles: REGLES });
    assert.equal(p.comptesIllisibles, 1);
    assert.equal(p.complet, false);
    assert.equal(p.chiffreAffaires, 100);
  });

  test("période partielle : élargie à ses mois entiers", () => {
    assert.deepEqual(periodeEnMoisEntiers({ debut: "2026-03-10", fin: "2026-04-05" }), { debut: "2026-03-01", fin: "2026-04-30" });
    assert.deepEqual(periodeEnMoisEntiers({ debut: "2024-02-01", fin: "2024-02-29" }), { debut: "2024-02-01", fin: "2024-02-29" });
  });
});

describe("Stocks du P&L comptable", () => {
  const novanta = ajustementsDepuisStocks([{ mois: "2026-02", valeur: 1_000 }, { mois: "2026-03", valeur: 1_400 }]);
  const lignes = [L("706000", 0, 10_000), L("601000", 2_000, 0)];

  test("source Pennylane seule", () => {
    const p = pnlDe([...lignes, L("603000", 0, 500)], REGLES);
    assert.equal(p.stock.source, "pennylane");
    assert.equal(p.variationStocks, 500);
    assert.equal(p.margeBrute, 8_500);
    assert.equal(p.stock.conflit, false);
  });

  test("source Novanta seule : la variation saisie, en ajustement de gestion", () => {
    const p = pnlDe(lignes, REGLES, ANNEE, { variationsStockNovanta: novanta });
    assert.equal(p.stock.source, "novanta");
    assert.equal(p.variationStocks, 400);
    assert.equal(p.margeBrute, 8_400);
  });

  test("société sans stock : aucune source, aucune ligne", () => {
    const p = pnlDe(lignes, REGLES);
    assert.equal(p.stock.source, "aucune");
    assert.equal(p.variationStocks, 0);
    assert.equal(p.complet, true);
  });

  test("conflit sans arbitrage : à demander, jamais additionné, résultat non présenté comme complet", () => {
    const p = pnlDe([...lignes, L("603000", 0, 500)], REGLES, ANNEE, { variationsStockNovanta: novanta });
    assert.equal(p.stock.conflit, true);
    assert.equal(p.variationStocks, 500);
    assert.equal(p.margeBrute, 8_500);
    assert.equal(p.complet, false);
  });

  test("arbitrage Novanta : les écritures de stock sortent, un seul montant reste", () => {
    const p = pnlDe([...lignes, L("603000", 0, 500)], REGLES, ANNEE, { variationsStockNovanta: novanta, sourceStockChoisie: "novanta" });
    assert.equal(p.variationStocks, 400);
    assert.equal(p.margeBrute, 8_400);
    assert.equal(p.stock.conflit, false);
    assert.ok(!p.categories.some((c) => c.ligne === "inventory_variation"));
  });

  test("arbitrage Pennylane : la variation Novanta reste hors calcul", () => {
    const p = pnlDe([...lignes, L("603000", 0, 500)], REGLES, ANNEE, { variationsStockNovanta: novanta, sourceStockChoisie: "pennylane" });
    assert.equal(p.variationStocks, 500);
    assert.equal(p.stock.montantNovanta, 400);
  });

  test("un choix enregistré n'invente pas une source absente", () => {
    assert.equal(deciderStock(false, 0, [], "novanta").source, "aucune");
    assert.equal(deciderStock(true, 10, [], "novanta").source, "pennylane");
    assert.equal(deciderStock(false, 0, novanta, "pennylane").source, "novanta");
  });

  test("écriture de stock nulle mais présente : la source Pennylane existe quand même", () => {
    const p = pnlDe([...lignes, L("603000", 100, 100)], REGLES, ANNEE, { variationsStockNovanta: novanta });
    assert.equal(p.stock.conflit, true);
  });

  test("le contrôle d'exhaustivité reste vrai quel que soit l'arbitrage", () => {
    const p = pnlDe([...lignes, L("603000", 0, 500)], REGLES, ANNEE, { variationsStockNovanta: novanta, sourceStockChoisie: "novanta" });
    assert.equal(p.controle.equilibre, true);
  });
});

describe("Données simulées et volumes", () => {
  const libelles = new Map(COMPTES_FIXTURES.map((c) => [c.numero, c.libelle]));

  test("scénario complet sur le modèle de correspondance", () => {
    const p = calculerPnlComptable({ soldes: soldesDepuisLignes(LIGNES_FIXTURES, { debut: "2026-01-01", fin: "2026-03-31" }), regles: [...MODELE_CORRESPONDANCE], libellesComptes: libelles });
    assert.equal(p.chiffreAffaires, 60_000 + 40_000 + 70_000 + 30_000 - 2_500 + 80_000 + 35_000);
    assert.equal(p.variationStocks, 3_000);
    assert.equal(p.nonAffectes.comptes[0]?.compte, "780000");
    assert.equal(p.nonAffectes.comptes[0]?.libelle, "Reprises diverses");
    assert.equal(p.comptes.find((c) => c.compte === "489000")?.statut, "bilan");
    assert.equal(p.controle.equilibre, true);
  });

  test("soldes de la période : par mois de solde", () => {
    const soldes = soldesDepuisLignes(LIGNES_FIXTURES, ANNEE);
    assert.ok(soldesDeLaPeriode(soldes, { debut: "2026-02-01", fin: "2026-02-28" }).every((s) => s.mois === "2026-02"));
  });

  test("500 000 lignes : totaux exacts au centime, sans dérive flottante", () => {
    function* lignes(): Generator<LigneEcriture> {
      for (let i = 0; i < 500_000; i++) yield { compte: i % 2 ? "706000" : "601000", date: `2026-${String((i % 12) + 1).padStart(2, "0")}-15`, debit: i % 2 ? 0 : 0.1, credit: i % 2 ? 0.2 : 0 };
    }
    const debut = Date.now();
    const p = calculerPnlComptable({ soldes: soldesDepuisLignes(lignes(), ANNEE), regles: REGLES });
    assert.equal(p.chiffreAffaires, 50_000);
    assert.equal(p.coutsDirects, -25_000);
    assert.equal(p.resultatNet, 25_000);
    assert.ok(Date.now() - debut < 5_000, "calcul trop lent");
  });

  test("5 000 comptes distincts : un seul passage par compte", () => {
    const lignesComptes = Array.from({ length: 5_000 }, (_, i) => L(`70${String(i).padStart(4, "0")}`, 0, 1));
    assert.equal(pnlDe(lignesComptes, REGLES).comptes.length, 5_000);
  });
});
