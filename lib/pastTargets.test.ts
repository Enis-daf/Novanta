import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AjustementGestion } from "./pastAdjustments";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { calculerDetail, partsMappees } from "./pastDetail";
import { calculerPnl } from "./pastPnl";
import {
  Cible,
  cibleDeCoutsDeStructure,
  cibleDeMarge,
  cibleEnVigueur,
  COUVERTURE_MIN_VERDICT,
  ecartDeCouts,
  ecartDeMarge,
  ecartsVsCibles,
  historiqueDesCibles,
  libellePoints,
  libellesEcartCouts,
  libellesEcartMarge,
  TypeCible,
  valeurCibleValide,
} from "./pastTargets";
import { PastTransactionStockee } from "./pastTransactions";

let compteur = 0;
const cible = (type: TypeCible, validFrom: string, valeur: number, dimension = ""): Cible => ({ id: `c${++compteur}`, type, dimension, validFrom, valeur });
const mb = (categorie: string, valeur: number, validFrom = "2026-01-01") => cible("gross_margin_pct", validFrom, valeur, categorie);
const mc = (categorie: string, valeur: number, validFrom = "2026-01-01") => cible("contribution_margin_pct", validFrom, valeur, categorie);
const revenu = (categorie: string | null, montant: number, date = "2026-03-10") => ({ date, montant, categorie });
const proche = (a: number, b: number, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} ≠ ${b}`);

describe("cibles datées", () => {
  const cibles = [cible("structure_cost_monthly", "2026-07-01", 100_000), cible("structure_cost_monthly", "2026-01-01", 80_000), mb("abo", 75), mb("abo", 80, "2026-07-01"), mb("projets", 55)];

  test("la cible en vigueur est la dernière dont la date d'effet est atteinte", () => {
    assert.equal(cibleEnVigueur(cibles, "structure_cost_monthly", "2026-03-15"), 80_000);
    assert.equal(cibleEnVigueur(cibles, "structure_cost_monthly", "2026-07-01"), 100_000);
    assert.equal(cibleEnVigueur(cibles, "gross_margin_pct", "2026-06-30", "abo"), 75);
    assert.equal(cibleEnVigueur(cibles, "gross_margin_pct", "2026-07-01", "abo"), 80);
  });

  test("chaque catégorie de CA a sa propre cible ; une catégorie sans cible n'en reçoit aucune", () => {
    assert.equal(cibleEnVigueur(cibles, "gross_margin_pct", "2026-03-15", "projets"), 55);
    assert.equal(cibleEnVigueur(cibles, "gross_margin_pct", "2026-03-15", "services"), null);
    assert.equal(cibleEnVigueur(cibles, "contribution_margin_pct", "2026-03-15", "abo"), null);
    assert.equal(cibleEnVigueur(cibles, "gross_margin_pct", "2025-12-31", "abo"), null);
    assert.equal(cibleEnVigueur(cibles, "gross_margin_pct", "2026-03-15"), null);
  });

  test("ajouter une cible aujourd'hui ne réécrit pas la lecture du passé", () => {
    const avecNouvelle = [...cibles, mb("abo", 90, "2026-10-01")];
    assert.equal(cibleEnVigueur(avecNouvelle, "gross_margin_pct", "2026-03-15", "abo"), 75);
    assert.equal(cibleEnVigueur(avecNouvelle, "gross_margin_pct", "2026-09-30", "abo"), 80);
    assert.equal(cibleEnVigueur(avecNouvelle, "gross_margin_pct", "2026-10-01", "abo"), 90);
  });

  test("historique par catégorie, trié par date d'effet", () => {
    assert.deepEqual(historiqueDesCibles(cibles, "gross_margin_pct", "abo").map((c) => [c.validFrom, c.valeur]), [["2026-01-01", 75], ["2026-07-01", 80]]);
    assert.deepEqual(historiqueDesCibles(cibles, "structure_cost_monthly").map((c) => c.validFrom), ["2026-01-01", "2026-07-01"]);
  });

  test("valeurs saisies : un pourcentage plausible, un montant positif", () => {
    assert.equal(valeurCibleValide("gross_margin_pct", 44), true);
    assert.equal(valeurCibleValide("gross_margin_pct", 140), false);
    assert.equal(valeurCibleValide("structure_cost_monthly", 85_000), true);
    assert.equal(valeurCibleValide("structure_cost_monthly", -1), false);
    assert.equal(valeurCibleValide("contribution_margin_pct", Number.NaN), false);
  });
});

describe("cible de marge pondérée par le mix de CA réel", () => {
  const cibles = [mb("a", 70), mb("b", 99), mb("c", 50)];

  test("cas de référence : 100 à 70 %, 50 à 99 %, 150 à 50 % -> 64,83 %, jamais la moyenne simple de 73 %", () => {
    const resultat = cibleDeMarge(cibles, "gross_margin_pct", [revenu("a", 100), revenu("b", 50), revenu("c", 150)])!;
    proche(resultat.valeur, 194.5 / 300);
    proche(resultat.valeur, 0.648333333, 1e-8);
    assert.equal(resultat.couverture, 1);
    assert.notEqual(Math.round(resultat.valeur * 1000), 730);
    assert.equal(libellesEcartMarge(ecartDeMarge(0.61, 300, resultat)).cible, "Cible 64,8 %");
  });

  test("le poids est le CA réel : plusieurs encaissements d'une catégorie s'additionnent", () => {
    const fractionne = cibleDeMarge(cibles, "gross_margin_pct", [revenu("a", 60), revenu("a", 40), revenu("b", 50), revenu("c", 100), revenu("c", 50)])!;
    proche(fractionne.valeur, 194.5 / 300);
  });

  test("le mix change, la cible globale change — sans que personne ne la modifie", () => {
    const plusDeC = cibleDeMarge(cibles, "gross_margin_pct", [revenu("a", 100), revenu("b", 50), revenu("c", 450)])!;
    proche(plusDeC.valeur, (70 + 49.5 + 225) / 600);
    const plusDeB = cibleDeMarge(cibles, "gross_margin_pct", [revenu("a", 100), revenu("b", 350), revenu("c", 150)])!;
    assert.ok(plusDeB.valeur > 0.648 && plusDeC.valeur < 0.648);
  });

  test("cible changée en cours de période : chaque revenu prend la cible en vigueur à sa date", () => {
    const datees = [mb("a", 75, "2026-01-01"), mb("a", 80, "2026-07-01")];
    const resultat = cibleDeMarge(datees, "gross_margin_pct", [revenu("a", 100, "2026-06-15"), revenu("a", 300, "2026-07-15")])!;
    proche(resultat.valeur, (75 + 240) / 400);
  });

  test("catégorie sans cible : exclue du calcul (ni 0 %, ni moyenne des autres), couverture réduite", () => {
    const resultat = cibleDeMarge(cibles, "gross_margin_pct", [revenu("a", 100), revenu("c", 150), revenu("nouvelle", 250)])!;
    proche(resultat.valeur, (70 + 75) / 250);
    assert.equal(resultat.couverture, 0.5);
  });

  test("couverture = CA couvert / CA total ; un ajustement de gestion du CA n'a pas de catégorie", () => {
    const resultat = cibleDeMarge(cibles, "gross_margin_pct", [revenu("a", 410), revenu("nouvelle", 50), revenu(null, 40)])!;
    proche(resultat.couverture, 0.82);
  });

  test("Marge brute et Marge contributive se calculent séparément", () => {
    const deux = [mb("a", 70), mc("a", 40), mb("b", 99)];
    const revenus = [revenu("a", 100), revenu("b", 100)];
    proche(cibleDeMarge(deux, "gross_margin_pct", revenus)!.valeur, 0.845);
    const contributive = cibleDeMarge(deux, "contribution_margin_pct", revenus)!;
    proche(contributive.valeur, 0.4);
    assert.equal(contributive.couverture, 0.5);
  });

  test("aucune cible applicable, ou aucun CA : pas de cible", () => {
    assert.equal(cibleDeMarge([], "gross_margin_pct", [revenu("a", 100)]), null);
    assert.equal(cibleDeMarge(cibles, "gross_margin_pct", [revenu("nouvelle", 100)]), null);
    assert.equal(cibleDeMarge(cibles, "gross_margin_pct", []), null);
    assert.equal(cibleDeMarge([mb("a", 70, "2026-04-01")], "gross_margin_pct", [revenu("a", 100, "2026-03-10")]), null);
  });

  test("une ancienne cible globale (sans catégorie) n'est jamais appliquée à une catégorie", () => {
    assert.equal(cibleDeMarge([cible("gross_margin_pct", "2026-01-01", 44)], "gross_margin_pct", [revenu("a", 100)]), null);
  });
});

describe("cible de coûts de structure d'une période — inchangée : globale, mensuelle, datée", () => {
  const cibles = [cible("structure_cost_monthly", "2026-01-01", 85_000)];

  test("un mois entier : la cible mensuelle ; trois mois entiers : trois fois", () => {
    proche(cibleDeCoutsDeStructure(cibles, { debut: "2026-03-01", fin: "2026-03-31" })!.valeur, 85_000);
    const trimestre = cibleDeCoutsDeStructure(cibles, { debut: "2026-01-01", fin: "2026-03-31" })!;
    proche(trimestre.valeur, 255_000);
    assert.equal(trimestre.couverture, 1);
  });

  test("mois partiel : au prorata des jours du mois", () => {
    proche(cibleDeCoutsDeStructure(cibles, { debut: "2026-04-01", fin: "2026-04-15" })!.valeur, 85_000 / 2);
  });

  test("cible qui change en cours de période : chaque sous-période à sa cible", () => {
    const deux = [cible("structure_cost_monthly", "2026-01-01", 80_000), cible("structure_cost_monthly", "2026-07-01", 100_000)];
    proche(cibleDeCoutsDeStructure(deux, { debut: "2026-05-01", fin: "2026-08-31" })!.valeur, 80_000 * 2 + 100_000 * 2);
    proche(cibleDeCoutsDeStructure(deux, { debut: "2026-03-01", fin: "2026-03-31" })!.valeur, 80_000);
    proche(cibleDeCoutsDeStructure(deux, { debut: "2026-09-01", fin: "2026-09-30" })!.valeur, 100_000);
  });

  test("période en partie antérieure à la première cible : couverture partielle, rien d'inventé", () => {
    const partielle = cibleDeCoutsDeStructure(cibles, { debut: "2025-12-01", fin: "2026-01-31" })!;
    proche(partielle.valeur, 85_000);
    assert.equal(partielle.couverture, 0.5);
    assert.equal(cibleDeCoutsDeStructure(cibles, { debut: "2025-10-01", fin: "2025-12-31" }), null);
    assert.equal(cibleDeCoutsDeStructure([], { debut: "2026-01-01", fin: "2026-01-31" }), null);
  });

  test("les cibles de marge par catégorie n'ont aucun effet sur les coûts de structure", () => {
    assert.deepEqual(cibleDeCoutsDeStructure([...cibles, mb("a", 70), mc("a", 40)], { debut: "2026-03-01", fin: "2026-03-31" }), cibleDeCoutsDeStructure(cibles, { debut: "2026-03-01", fin: "2026-03-31" }));
  });
});

describe("écart d'une marge à sa cible pondérée", () => {
  const complete = { valeur: 0.648333, couverture: 1 };

  test("61,0 % réalisés contre 64,8 % : -3,8 pts, défavorable, et l'écart en euros au CA réel", () => {
    const ecart = ecartDeMarge(0.61, 300_000, complete);
    proche(ecart.ecartPoints, -0.038333);
    proche(ecart.ecartEuros!, -11_499.9, 0.01);
    assert.equal(ecart.statut, "defavorable");
    assert.deepEqual(libellesEcartMarge(ecart), { cible: "Cible 64,8 %", ecart: "-3,8 pts · -11 k€ vs cible", reserve: null });
  });

  test("au-dessus de la cible : favorable ; à 0,2 point près : dans la cible", () => {
    assert.equal(ecartDeMarge(0.68, 100_000, complete).statut, "favorable");
    assert.equal(ecartDeMarge(0.6495, 100_000, complete).statut, "neutre");
    assert.equal(ecartDeMarge(0.645, 100_000, complete).statut, "defavorable");
  });

  test("couverture incomplète (≥ 80 %) : verdict gardé, couverture dite, écart en euros masqué", () => {
    const ecart = ecartDeMarge(0.61, 300_000, { valeur: 0.648333, couverture: 0.82 });
    assert.equal(ecart.statut, "defavorable");
    assert.equal(ecart.ecartEuros, null);
    assert.deepEqual(libellesEcartMarge(ecart), { cible: "Cible 64,8 %", ecart: "-3,8 pts vs cible", reserve: "Cible calculée sur 82 % du CA" });
  });

  test("couverture trop faible : cible incomplète, écart seulement indicatif, aucun verdict", () => {
    assert.equal(COUVERTURE_MIN_VERDICT, 0.8);
    const ecart = ecartDeMarge(0.61, 300_000, { valeur: 0.648333, couverture: 0.64 });
    assert.equal(ecart.statut, "incomplet");
    assert.equal(ecart.ecartEuros, null);
    assert.deepEqual(libellesEcartMarge(ecart), { cible: "Cible 64,8 %", ecart: "-3,8 pts (indicatif)", reserve: "Cible incomplète — 64 % du CA couvert" });
    assert.equal(ecartDeMarge(0.61, 300_000, { valeur: 0.648333, couverture: 0.8 }).statut, "defavorable");
  });
});

describe("écart des coûts de structure à leur cible", () => {
  const cible85 = { valeur: 85_000, couverture: 1 };

  test("coûts au-dessus de la cible : défavorable, écart positif lisible en coûts", () => {
    const ecart = ecartDeCouts(-94_000, cible85);
    assert.deepEqual([ecart.realise, ecart.cible, ecart.ecart, ecart.statut], [94_000, 85_000, 9_000, "defavorable"]);
    assert.deepEqual(libellesEcartCouts(ecart), { cible: "Cible 85 k€", ecart: "+9 k€ vs cible", reserve: null });
  });

  test("coûts sous la cible : favorable", () => {
    const ecart = ecartDeCouts(-70_000, cible85);
    assert.deepEqual([ecart.ecart, ecart.statut], [-15_000, "favorable"]);
    assert.equal(libellesEcartCouts(ecart).ecart, "-15 k€ vs cible");
  });

  test("à 1 % de la cible près (et jamais moins de 100 €) : dans la cible", () => {
    assert.equal(ecartDeCouts(-85_800, cible85).statut, "neutre");
    assert.equal(ecartDeCouts(-85_900, cible85).statut, "defavorable");
    assert.equal(ecartDeCouts(-1_080, { valeur: 1_000, couverture: 1 }).statut, "neutre");
    assert.equal(ecartDeCouts(-1_150, { valeur: 1_000, couverture: 1 }).statut, "defavorable");
  });

  test("couverture partielle : dite", () => {
    assert.equal(libellesEcartCouts(ecartDeCouts(-90_000, { valeur: 85_000, couverture: 0.5 })).reserve, "Cible définie sur 50 % de la période");
  });
});

describe("écarts vs cibles — Général et écrans de détail, même calcul", () => {
  const AXE = "229";
  const mapping = (id: string, pnlStage: MappingCategorie["pnlStage"]): MappingCategorie => ({ sourceCategoryId: id, sourceCategoryName: id, sourceGroupId: AXE, pnlStage });
  const mappings = indexerMappings([mapping("a", "revenue"), mapping("b", "revenue"), mapping("c", "revenue"), mapping("achats", "gross_margin"), mapping("pub", "contribution_margin"), mapping("salaires", "ebitda")]);
  let n = 0;
  const tx = (date: string, amount: number, categorie: string): PastTransactionStockee => ({
    id: `t${++n}`,
    sourceType: "pennylane",
    transactionDate: date,
    label: `${categorie} ${n}`,
    amount,
    currency: "EUR",
    affectations: [{ groupId: AXE, categoryId: categorie, categoryName: categorie, weight: 1 }],
  });
  const transactions = [
    tx("2026-02-10", 100_000, "a"), tx("2026-02-12", 50_000, "b"), tx("2026-02-14", 150_000, "c"), tx("2026-02-16", -117_000, "achats"), tx("2026-02-18", -30_000, "pub"), tx("2026-02-28", -94_000, "salaires"),
    tx("2026-03-10", 300_000, "a"), tx("2026-03-16", -90_000, "achats"), tx("2026-03-18", -30_000, "pub"), tx("2026-03-28", -80_000, "salaires"),
  ];
  const periode = { debut: "2026-02-01", fin: "2026-03-31" };
  const parts = (liste = transactions, index = mappings) => partsMappees(liste, AXE, index);
  const cibles = [mb("a", 70), mb("b", 99), mb("c", 50), mc("a", 60), mc("b", 80), mc("c", 40), cible("structure_cost_monthly", "2026-01-01", 85_000)];
  const sansAjustement: AjustementGestion[] = [];

  test("période entière : réalisé identique au P&L, cible pondérée sur tout le CA", () => {
    const ecarts = ecartsVsCibles(cibles, parts(), sansAjustement, periode);
    const pnl = calculerPnl(transactions, AXE, mappings);
    proche(ecarts.margeBrute!.realise, pnl.ratios.margeBrute!);
    proche(ecarts.margeContributive!.realise, pnl.ratios.margeContributive!);
    proche(ecarts.margeBrute!.cible, (400_000 * 0.7 + 50_000 * 0.99 + 150_000 * 0.5) / 600_000);
    assert.equal(ecarts.montantCoutsStructure, pnl.ebitda - pnl.margeContributive);
    proche(ecarts.coutsStructure!.cible, 170_000);
    proche(ecarts.coutsStructure!.ecart, 4_000);
  });

  test("mois sélectionné : cible recalculée avec le CA et le réalisé de ce mois — le cas de référence en février", () => {
    const fevrier = ecartsVsCibles(cibles, parts(), sansAjustement, periode, "2026-02");
    proche(fevrier.margeBrute!.cible, 194.5 / 300);
    proche(fevrier.margeBrute!.realise, 0.61);
    assert.equal(libellesEcartMarge(fevrier.margeBrute!).ecart, "-3,8 pts · -11 k€ vs cible");
    proche(fevrier.margeBrute!.realise, calculerDetail(parts(), "marge_brute", { categorie: null, mois: "2026-02" }, periode).kpi.ratio!);
    proche(fevrier.coutsStructure!.cible, 85_000);
    assert.deepEqual([fevrier.coutsStructure!.realise, fevrier.coutsStructure!.statut], [94_000, "defavorable"]);
    const mars = ecartsVsCibles(cibles, parts(), sansAjustement, periode, "2026-03");
    proche(mars.margeBrute!.cible, 0.7);
    assert.equal(mars.coutsStructure!.statut, "favorable");
  });

  test("nouvelle catégorie de CA sans cible : aucune valeur inventée, couverture réduite", () => {
    const avecNouvelle = [...transactions, tx("2026-03-20", 200_000, "nouvelle")];
    const index = indexerMappings([...mappings.values(), mapping("nouvelle", "revenue")]);
    const ecarts = ecartsVsCibles(cibles, parts(avecNouvelle, index), sansAjustement, periode);
    proche(ecarts.margeBrute!.cible, (400_000 * 0.7 + 50_000 * 0.99 + 150_000 * 0.5) / 600_000);
    assert.equal(ecarts.margeBrute!.couverture, 0.75);
    assert.equal(ecarts.margeBrute!.statut, "incomplet");
    assert.equal(ecarts.margeBrute!.ecartEuros, null);
  });

  test("catégorie remappée hors du CA : elle ne pondère plus la cible, même si sa cible reste enregistrée", () => {
    const index = indexerMappings([...mappings.values()].map((m) => (m.sourceCategoryId === "c" ? { ...m, pnlStage: "extra_pnl" as const } : m)));
    const ecarts = ecartsVsCibles(cibles, parts(transactions, index), sansAjustement, periode);
    proche(ecarts.margeBrute!.cible, (400_000 * 0.7 + 50_000 * 0.99) / 450_000);
    assert.equal(ecarts.margeBrute!.couverture, 1);
  });

  test("aucune cible configurée : rien, jamais un 0 % ou un 0 € artificiel", () => {
    const ecarts = ecartsVsCibles([], parts(), sansAjustement, periode);
    assert.deepEqual([ecarts.margeBrute, ecarts.margeContributive, ecarts.coutsStructure], [null, null, null]);
  });

  test("seule la cible de coûts de structure est posée : les marges restent sans cible", () => {
    const ecarts = ecartsVsCibles([cible("structure_cost_monthly", "2026-01-01", 85_000)], parts(), sansAjustement, periode);
    assert.equal(ecarts.margeBrute, null);
    assert.ok(ecarts.coutsStructure);
  });

  test("période sans CA : pas d'écart de marge", () => {
    assert.equal(ecartsVsCibles(cibles, parts(), sansAjustement, periode, "2026-01").margeBrute, null);
  });
});

describe("libellés", () => {
  test("points : singulier sous 2, zéro sans signe", () => {
    assert.equal(libellePoints(0.011), "+1,1 pt");
    assert.equal(libellePoints(-0.02), "-2,0 pts");
    assert.equal(libellePoints(0), "0,0 pt");
  });
});
