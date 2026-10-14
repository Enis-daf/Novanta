import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AjustementGestion } from "./pastAdjustments";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { calculerDetail, partsMappees } from "./pastDetail";
import { calculerPnl } from "./pastPnl";
import {
  Cible,
  cibleEnConflit,
  commenterCible,
  corrigerCible,
  LONGUEUR_MAX_COMMENTAIRE,
  normaliserCommentaire,
  poserCible,
  remplacerCible,
  cibleDeCoutsDeStructure,
  cibleDeMarge,
  cibleEnVigueur,
  COUVERTURE_MIN_VERDICT,
  ecartDEbitda,
  ecartDeCouts,
  ecartDeMarge,
  enK,
  LIBELLE_EBITDA_INCOMPLET,
  libellesEcartEbitda,
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
    assert.deepEqual(libellesEcartMarge(ecart), { cible: "Cible 64,8 %", ecart: "-11,5 k€ vs cible", reserve: null });
    assert.equal(libellePoints(ecart.ecartPoints), "-3,8 pts");
  });

  test("écart principal en k€ : marge réelle − CA réel × cible pondérée", () => {
    // CA 2 475 k€, cible 52,2 % (soit 1 292 k€), marge réelle 970 k€ : -322 k€.
    const ecart = ecartDeMarge(970_000 / 2_475_000, 2_475_000, { valeur: 0.522, couverture: 1 });
    proche(ecart.ecartEuros!, 970_000 - 2_475_000 * 0.522, 0.01);
    assert.equal(ecart.statut, "defavorable");
    // Même format k€ que l'EBITDA : une décimale au plus, donc -321 950 € se lit « -321,9 k€ ».
    assert.deepEqual(libellesEcartMarge(ecart), { cible: "Cible 52,2 %", ecart: "-321,9 k€ vs cible", reserve: null });
    assert.equal(libellesEcartMarge(ecartDeMarge(969_950 / 2_475_000, 2_475_000, { valeur: 0.522, couverture: 1 })).ecart, "-322 k€ vs cible");
  });

  test("cible dépassée : écart positif, favorable ; k€ sans décimale inutile", () => {
    const dessus = ecartDeMarge(0.6, 650_000, { valeur: 0.47, couverture: 1 });
    assert.equal(dessus.statut, "favorable");
    assert.equal(libellesEcartMarge(dessus).ecart, "+84,5 k€ vs cible");
    assert.equal(libellesEcartMarge(ecartDeMarge(0.513, 100_000, { valeur: 0.5, couverture: 1 })).ecart, "+1,3 k€ vs cible");
    assert.equal(libellesEcartMarge(ecartDeMarge(0.4, 1_000_000, { valeur: 0.5, couverture: 1 })).ecart, "-100 k€ vs cible");
  });

  test("couverture 99 % : écart en k€ gardé, couverture dite en infobulle seulement", () => {
    const ecart = ecartDeMarge(970_000 / 2_475_000, 2_475_000, { valeur: 0.522, couverture: 0.99 });
    assert.deepEqual(libellesEcartMarge(ecart), { cible: "Cible 52,2 %", ecart: "-321,9 k€ vs cible", reserve: "Cible calculée sur 99 % des encaissements" });
    // Jamais « 100 % » tant que la couverture n'est pas complète.
    assert.equal(libellesEcartMarge(ecartDeMarge(0.4, 100_000, { valeur: 0.5, couverture: 0.996 })).reserve, "Cible calculée sur 99 % des encaissements");
    assert.equal(libellesEcartMarge(ecartDeMarge(0.4, 100_000, { valeur: 0.5, couverture: 0.9995 })).reserve, null);
  });

  test("au-dessus de la cible : favorable ; à 0,2 point près : dans la cible", () => {
    assert.equal(ecartDeMarge(0.68, 100_000, complete).statut, "favorable");
    assert.equal(ecartDeMarge(0.6495, 100_000, complete).statut, "neutre");
    assert.equal(ecartDeMarge(0.645, 100_000, complete).statut, "defavorable");
  });

  test("couverture incomplète (≥ 80 %) : verdict et écart en euros gardés, couverture dite", () => {
    const ecart = ecartDeMarge(0.61, 300_000, { valeur: 0.648333, couverture: 0.82 });
    assert.equal(ecart.statut, "defavorable");
    proche(ecart.ecartEuros!, -11_499.9, 0.01);
    assert.deepEqual(libellesEcartMarge(ecart), { cible: "Cible 64,8 %", ecart: "-11,5 k€ vs cible", reserve: "Cible calculée sur 82 % des encaissements" });
  });

  test("couverture trop faible : cible gardée, aucun écart en euros, aucun verdict", () => {
    assert.equal(COUVERTURE_MIN_VERDICT, 0.8);
    const ecart = ecartDeMarge(0.61, 300_000, { valeur: 0.648333, couverture: 0.64 });
    assert.equal(ecart.statut, "incomplet");
    assert.equal(ecart.ecartEuros, null);
    assert.deepEqual(libellesEcartMarge(ecart), { cible: "Cible 64,8 %", ecart: "cible incomplète", reserve: "Cible calculée sur 64 % des encaissements" });
    proche(ecart.ecartPoints, -0.038333);
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
    assert.equal(libellesEcartMarge(fevrier.margeBrute!).ecart, "-11,5 k€ vs cible");
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

describe("enregistrer une cible — l'utilisateur ne choisit pas entre créer et modifier", () => {
  const brute = (dimension: string, validFrom: string, valeur: number, id: string): Cible => ({ id, type: "gross_margin_pct", dimension, validFrom, valeur });
  const depart: Cible[] = [
    brute("abo", "2026-01-01", 70, "mb-abo-1"),
    brute("abo", "2026-07-01", 75, "mb-abo-2"),
    brute("projets", "2026-01-01", 55, "mb-projets"),
    { id: "mc-abo", type: "contribution_margin_pct", dimension: "abo", validFrom: "2026-01-01", valeur: 60 },
    { id: "structure", type: "structure_cost_monthly", dimension: "", validFrom: "2026-01-01", valeur: 85_000 },
  ];
  const parId = (cibles: Cible[], id: string) => cibles.find((c) => c.id === id)!;
  const sansDoublon = (cibles: Cible[]) => new Set(cibles.map((c) => `${c.type}|${c.dimension}|${c.validFrom}`)).size === cibles.length;

  test("édition, 70 % -> 72 % au même 01/01/2026 : la ligne est mise à jour, une seule ligne, aucune erreur", () => {
    const resultat = corrigerCible(depart, "mb-abo-1", { valeur: 72, validFrom: "2026-01-01" });
    assert.equal(resultat.conflit, null);
    assert.deepEqual(resultat.operations, [{ type: "update", id: "mb-abo-1", valeur: 72, validFrom: "2026-01-01" }]);
    assert.equal(resultat.cibles!.length, depart.length);
    assert.deepEqual(resultat.cibles!.filter((c) => c.dimension === "abo" && c.type === "gross_margin_pct" && c.validFrom === "2026-01-01"), [brute("abo", "2026-01-01", 72, "mb-abo-1")]);
  });

  test("édition d'une Marge contributive ou des Coûts de structure : la ligne visée, et elle seule", () => {
    const contributive = corrigerCible(depart, "mc-abo", { valeur: 62, validFrom: "2026-01-01" });
    assert.deepEqual(contributive.operations, [{ type: "update", id: "mc-abo", valeur: 62, validFrom: "2026-01-01" }]);
    const structure = corrigerCible(depart, "structure", { valeur: 90_000, validFrom: "2026-01-01" });
    assert.deepEqual([parId(structure.cibles!, "structure").valeur, parId(structure.cibles!, "structure").dimension], [90_000, ""]);
    for (const resultat of [contributive, structure]) {
      assert.equal(resultat.cibles!.length, depart.length);
      assert.deepEqual(resultat.cibles!.filter((c) => c.type === "gross_margin_pct"), depart.filter((c) => c.type === "gross_margin_pct"));
    }
  });

  test("la catégorie A éditée, la catégorie B est intacte ; type et catégorie de la ligne ne changent pas", () => {
    const { cibles } = corrigerCible(depart, "mb-abo-1", { valeur: 72, validFrom: "2026-01-01" });
    assert.deepEqual(cibles!.filter((c) => c.id !== "mb-abo-1"), depart.filter((c) => c.id !== "mb-abo-1"));
    assert.deepEqual([parId(cibles!, "mb-abo-1").type, parId(cibles!, "mb-abo-1").dimension], ["gross_margin_pct", "abo"]);
  });

  test("édition sans changement : aucune écriture", () => {
    assert.deepEqual(corrigerCible(depart, "mb-abo-1", { valeur: 70, validFrom: "2026-01-01" }).operations, []);
  });

  test("édition de la date vers une date libre : la même ligne se déplace dans l'historique", () => {
    const resultat = corrigerCible(depart, "mb-abo-1", { valeur: 70, validFrom: "2026-02-01" });
    assert.deepEqual(resultat.operations, [{ type: "update", id: "mb-abo-1", valeur: 70, validFrom: "2026-02-01" }]);
    assert.equal(resultat.cibles!.length, depart.length);
    assert.equal(cibleEnVigueur(resultat.cibles!, "gross_margin_pct", "2026-01-15", "abo"), null);
    assert.equal(cibleEnVigueur(resultat.cibles!, "gross_margin_pct", "2026-02-15", "abo"), 70);
  });

  test("édition de la date vers une date déjà occupée : conflit signalé, rien n'est écrit ni écrasé", () => {
    const resultat = corrigerCible(depart, "mb-abo-2", { valeur: 80, validFrom: "2026-01-01" });
    assert.equal(resultat.cibles, null);
    assert.equal(resultat.operations, null);
    assert.equal(resultat.conflit!.id, "mb-abo-1");
  });

  test("remplacement confirmé : la cible en place prend la valeur, la ligne déplacée disparaît, aucun doublon", () => {
    const { cibles, operations } = remplacerCible(depart, "mb-abo-2", { valeur: 80, validFrom: "2026-01-01" });
    assert.deepEqual(operations, [
      { type: "update", id: "mb-abo-1", valeur: 80, validFrom: "2026-01-01" },
      { type: "delete", id: "mb-abo-2" },
    ]);
    assert.equal(cibles.length, depart.length - 1);
    assert.ok(sansDoublon(cibles));
    assert.deepEqual(historiqueDesCibles(cibles, "gross_margin_pct", "abo").map((c) => [c.validFrom, c.valeur]), [["2026-01-01", 80]]);
    assert.deepEqual(cibles.filter((c) => c.dimension !== "abo" || c.type !== "gross_margin_pct"), depart.filter((c) => c.dimension !== "abo" || c.type !== "gross_margin_pct"));
  });

  test("remplacement sans conflit : une simple correction", () => {
    assert.deepEqual(remplacerCible(depart, "mb-abo-1", { valeur: 72, validFrom: "2026-01-01" }).operations, [{ type: "update", id: "mb-abo-1", valeur: 72, validFrom: "2026-01-01" }]);
  });

  test("création à une date d'effet déjà occupée : la cible existante est mise à jour, sans erreur ni seconde ligne", () => {
    const { cibles, operations } = poserCible(depart, { type: "gross_margin_pct", dimension: "abo", validFrom: "2026-01-01" }, 72, "nouvelle");
    assert.deepEqual(operations, [{ type: "update", id: "mb-abo-1", valeur: 72, validFrom: "2026-01-01" }]);
    assert.equal(cibles.length, depart.length);
    assert.ok(sansDoublon(cibles));
    assert.equal(parId(cibles, "mb-abo-1").valeur, 72);
  });

  test("création à une nouvelle date d'effet : une nouvelle version, l'historique antérieur intact", () => {
    const { cibles, operations } = poserCible(depart, { type: "gross_margin_pct", dimension: "abo", validFrom: "2026-10-01" }, 80, "nouvelle");
    assert.deepEqual(operations, [{ type: "insert", cible: { ...brute("abo", "2026-10-01", 80, "nouvelle"), commentaire: null } }]);
    assert.equal(cibles.length, depart.length + 1);
    assert.deepEqual(cibles.slice(0, depart.length), depart);
    assert.deepEqual(["2026-03-15", "2026-08-15", "2026-10-15"].map((date) => cibleEnVigueur(cibles, "gross_margin_pct", date, "abo")), [70, 75, 80]);
  });

  test("première cible d'une catégorie, et cible de coûts de structure à une nouvelle date", () => {
    const services = poserCible(depart, { type: "contribution_margin_pct", dimension: "services", validFrom: "2026-01-01" }, 65, "n1");
    assert.equal(services.operations[0].type, "insert");
    const structure = poserCible(depart, { type: "structure_cost_monthly", dimension: "", validFrom: "2026-07-01" }, 100_000, "n2");
    assert.deepEqual(historiqueDesCibles(structure.cibles, "structure_cost_monthly").map((c) => c.valeur), [85_000, 100_000]);
    const memeDate = poserCible(depart, { type: "structure_cost_monthly", dimension: "", validFrom: "2026-01-01" }, 90_000, "n3");
    assert.deepEqual(memeDate.operations, [{ type: "update", id: "structure", valeur: 90_000, validFrom: "2026-01-01" }]);
  });

  test("même date d'effet dans une autre catégorie ou pour l'autre marge : pas la même cible", () => {
    assert.equal(cibleEnConflit(depart, "gross_margin_pct", "abo", "2026-01-01", "mb-abo-1"), null);
    assert.equal(cibleEnConflit(depart, "gross_margin_pct", "services", "2026-01-01"), null);
    assert.equal(cibleEnConflit(depart, "contribution_margin_pct", "projets", "2026-01-01"), null);
    assert.equal(cibleEnConflit(depart, "gross_margin_pct", "projets", "2026-01-01")!.id, "mb-projets");
  });

  test("quelle que soit la suite d'enregistrements, jamais deux cibles pour la même clé et la même date", () => {
    let cibles = depart;
    cibles = poserCible(cibles, { type: "gross_margin_pct", dimension: "abo", validFrom: "2026-07-01" }, 77, "x1").cibles;
    cibles = poserCible(cibles, { type: "gross_margin_pct", dimension: "abo", validFrom: "2026-09-01" }, 78, "x2").cibles;
    cibles = remplacerCible(cibles, "x2", { valeur: 79, validFrom: "2026-07-01" }).cibles;
    cibles = corrigerCible(cibles, "mb-projets", { valeur: 56, validFrom: "2026-03-01" }).cibles!;
    assert.ok(sansDoublon(cibles));
    assert.deepEqual(historiqueDesCibles(cibles, "gross_margin_pct", "abo").map((c) => [c.validFrom, c.valeur]), [["2026-01-01", 70], ["2026-07-01", 79]]);
  });

  test("cible introuvable : aucun changement", () => {
    assert.deepEqual(corrigerCible(depart, "inconnue", { valeur: 1, validFrom: "2026-01-01" }), { cibles: depart, operations: [], conflit: null });
  });
});

describe("EBITDA cible — dérivé de la Marge contributive cible et des Coûts de structure cibles", () => {
  const complete = (valeur: number) => ({ valeur, couverture: 1 });

  test("CA 1 000 k€, MC cible 40 %, structure cible 250 k€ -> EBITDA cible 150 k€", () => {
    const ecart = ecartDEbitda(130_000, 1_000_000, complete(0.4), complete(250_000));
    assert.equal(ecart.cible, 150_000);
  });

  test("EBITDA réel 130 k€ : -20 k€ vs cible, défavorable ; 170 k€ : +20 k€, favorable", () => {
    const dessous = ecartDEbitda(130_000, 1_000_000, complete(0.4), complete(250_000));
    assert.deepEqual([dessous.ecart, dessous.statut], [-20_000, "defavorable"]);
    assert.deepEqual(libellesEcartEbitda(dessous), { cible: "Cible 150 k€", ecart: "-20 k€ vs cible", reserve: null });
    const dessus = ecartDEbitda(170_000, 1_000_000, complete(0.4), complete(250_000));
    assert.deepEqual([dessus.ecart, dessus.statut], [20_000, "favorable"]);
    assert.equal(libellesEcartEbitda(dessus).ecart, "+20 k€ vs cible");
  });

  test("EBITDA cible négatif, et micro-écart dans la cible", () => {
    const perte = ecartDEbitda(-60_000, 500_000, complete(0.4), complete(250_000));
    assert.deepEqual([perte.cible, perte.ecart, perte.statut], [-50_000, -10_000, "defavorable"]);
    assert.equal(ecartDEbitda(150_900, 1_000_000, complete(0.4), complete(250_000)).statut, "neutre");
  });

  test("couverture partielle de la Marge contributive : propagée, écart seulement indicatif", () => {
    const ecart = ecartDEbitda(130_000, 1_000_000, { valeur: 0.4, couverture: 0.82 }, complete(250_000));
    assert.equal(ecart.statut, "incomplet");
    assert.deepEqual(libellesEcartEbitda(ecart), { cible: "Cible 150 k€", ecart: "-20 k€ (indicatif)", reserve: "Cible EBITDA calculée sur 82 % des encaissements" });
  });

  test("cible de coûts de structure ne couvrant qu'une partie de la période : dite aussi", () => {
    const ecart = ecartDEbitda(130_000, 1_000_000, complete(0.4), { valeur: 125_000, couverture: 0.5 });
    assert.equal(ecart.statut, "incomplet");
    assert.equal(libellesEcartEbitda(ecart).reserve, "Cible de coûts de structure définie sur 50 % de la période");
  });

  test("écart nul à l'arrondi : « 0 k€ », sans signe", () => {
    assert.equal(libellesEcartEbitda(ecartDEbitda(150_000.00001, 1_000_000, complete(0.4), complete(250_000))).ecart, "0 k€ vs cible");
    assert.equal(libellesEcartEbitda(ecartDEbitda(149_999.99999, 1_000_000, complete(0.4), complete(250_000))).ecart, "0 k€ vs cible");
    assert.equal(libellesEcartCouts(ecartDeCouts(-250_000.00001, complete(250_000))).ecart, "0 k€ vs cible");
  });

  test("format k€ : une décimale au plus, jamais d'euros détaillés", () => {
    assert.deepEqual([130_000, 125_500, -20_000, 9_400, 0].map(enK), ["130 k€", "125,5 k€", "-20 k€", "9,4 k€", "0 k€"]);
  });
});

describe("EBITDA cible dans les écarts d'une période — même calcul pour Général et l'écran EBITDA", () => {
  const AXE = "229";
  const mapping = (id: string, pnlStage: MappingCategorie["pnlStage"]): MappingCategorie => ({ sourceCategoryId: id, sourceCategoryName: id, sourceGroupId: AXE, pnlStage });
  const mappings = indexerMappings([mapping("a", "revenue"), mapping("b", "revenue"), mapping("achats", "gross_margin"), mapping("pub", "contribution_margin"), mapping("salaires", "ebitda")]);
  let n = 0;
  const tx = (date: string, amount: number, categorie: string): PastTransactionStockee => ({
    id: `e${++n}`,
    sourceType: "pennylane",
    transactionDate: date,
    label: `${categorie} ${n}`,
    amount,
    currency: "EUR",
    affectations: [{ groupId: AXE, categoryId: categorie, categoryName: categorie, weight: 1 }],
  });
  // Deux mois : CA 1 000 k€, MC réelle 380 k€, structure 250 k€ -> EBITDA 130 k€.
  const transactions = [
    tx("2026-02-10", 400_000, "a"), tx("2026-02-12", 100_000, "b"), tx("2026-02-16", -250_000, "achats"), tx("2026-02-18", -60_000, "pub"), tx("2026-02-28", -120_000, "salaires"),
    tx("2026-03-10", 500_000, "a"), tx("2026-03-16", -250_000, "achats"), tx("2026-03-18", -60_000, "pub"), tx("2026-03-28", -130_000, "salaires"),
  ];
  const periode = { debut: "2026-02-01", fin: "2026-03-31" };
  const parts = partsMappees(transactions, AXE, mappings);
  const mcA = cible("contribution_margin_pct", "2026-01-01", 40, "a");
  const mcB = cible("contribution_margin_pct", "2026-01-01", 40, "b");
  const structure = cible("structure_cost_monthly", "2026-01-01", 125_000);
  const ecarts = (cibles: Cible[], mois: string | null = null) => ecartsVsCibles(cibles, parts, [], periode, mois);

  test("les deux briques définies : EBITDA cible = CA × MC cible − structure cible, sur toute la période", () => {
    const { ebitda, ebitdaIncomplet, coutsStructure } = ecarts([mcA, mcB, structure]);
    assert.equal(ebitdaIncomplet, false);
    assert.equal(ebitda!.realise, calculerPnl(transactions, AXE, mappings).ebitda);
    proche(ebitda!.cible, 1_000_000 * 0.4 - 250_000);
    proche(ebitda!.ecart, -20_000);
    assert.equal(libellesEcartEbitda(ebitda!).cible, "Cible 150 k€");
    // La brique « coûts de structure » reste lisible à part, pour le diagnostic.
    proche(coutsStructure!.cible, 250_000);
    proche(coutsStructure!.ecart, 0);
  });

  test("un mois sélectionné : un mois de structure cible, le CA et l'EBITDA de ce mois", () => {
    const fevrier = ecarts([mcA, mcB, structure], "2026-02").ebitda!;
    proche(fevrier.cible, 500_000 * 0.4 - 125_000);
    proche(fevrier.realise, 500_000 - 250_000 - 60_000 - 120_000);
    proche(fevrier.ecart, -5_000);
  });

  test("cibles qui changent en cours de période : chaque brique suit ses dates d'effet", () => {
    const mcMars = cible("contribution_margin_pct", "2026-03-01", 50, "a");
    const structureMars = cible("structure_cost_monthly", "2026-03-01", 150_000);
    const { ebitda } = ecarts([mcA, mcB, mcMars, structure, structureMars]);
    // Février : 500 k€ à 40 %, 125 k€ de structure. Mars : 500 k€ à 50 %, 150 k€ de structure.
    proche(ebitda!.cible, 500_000 * 0.4 + 500_000 * 0.5 - (125_000 + 150_000));
  });

  test("une brique manquante : pas de faux EBITDA cible, l'objectif est dit incomplet", () => {
    const sansStructure = ecarts([mcA, mcB]);
    assert.deepEqual([sansStructure.ebitda, sansStructure.ebitdaIncomplet], [null, true]);
    const sansMarge = ecarts([structure]);
    assert.deepEqual([sansMarge.ebitda, sansMarge.ebitdaIncomplet], [null, true]);
    assert.equal(LIBELLE_EBITDA_INCOMPLET, "Objectif EBITDA incomplet");
  });

  test("aucune des deux briques : ni cible ni état incomplet", () => {
    const aucune = ecarts([cible("gross_margin_pct", "2026-01-01", 70, "a")]);
    assert.deepEqual([aucune.ebitda, aucune.ebitdaIncomplet], [null, false]);
  });

  test("Marge contributive cible définie sur une partie du CA : couverture propagée à l'EBITDA", () => {
    const { ebitda } = ecarts([mcA, structure]);
    assert.equal(ebitda!.couvertureCa, 0.9);
    assert.equal(ebitda!.statut, "incomplet");
    assert.equal(libellesEcartEbitda(ebitda!).reserve, "Cible EBITDA calculée sur 90 % des encaissements");
  });

  test("la cible de Marge brute n'entre pas dans l'EBITDA cible", () => {
    const avec = ecarts([mcA, mcB, structure, cible("gross_margin_pct", "2026-01-01", 99, "a")]);
    proche(avec.ebitda!.cible, 150_000);
  });
});

describe("commentaire d'un objectif daté — une note par version, jamais par catégorie", () => {
  const v1: Cible = { id: "v1", type: "gross_margin_pct", dimension: "abo", validFrom: "2026-01-01", valeur: 40, commentaire: null };
  const v2: Cible = { id: "v2", type: "gross_margin_pct", dimension: "abo", validFrom: "2026-07-01", valeur: 45, commentaire: null };
  const autre: Cible = { id: "p1", type: "gross_margin_pct", dimension: "projets", validFrom: "2026-01-01", valeur: 55 };
  const depart = [v1, v2, autre];
  const parId = (cibles: Cible[], id: string) => cibles.find((c) => c.id === id)!;
  const HYPOTHESE = "Vente 20 k€, matière première 12 k€";

  test("ajout d'un commentaire : une seule écriture, sur cette version, sans toucher à la valeur ni à la date", () => {
    const { cibles, operations } = commenterCible(depart, "v1", HYPOTHESE);
    assert.deepEqual(operations, [{ type: "comment", id: "v1", commentaire: HYPOTHESE }]);
    assert.deepEqual(parId(cibles, "v1"), { ...v1, commentaire: HYPOTHESE });
    assert.equal(cibles.length, depart.length);
    assert.deepEqual([parId(cibles, "v2"), parId(cibles, "p1")], [v2, autre]);
  });

  test("deux versions datées : deux commentaires indépendants", () => {
    let cibles = commenterCible(depart, "v1", HYPOTHESE).cibles;
    cibles = commenterCible(cibles, "v2", "Nouveau tarif + baisse du coût matière").cibles;
    assert.deepEqual(historiqueDesCibles(cibles, "gross_margin_pct", "abo").map((c) => [c.validFrom, c.commentaire]), [
      ["2026-01-01", HYPOTHESE],
      ["2026-07-01", "Nouveau tarif + baisse du coût matière"],
    ]);
  });

  test("modifier le commentaire : même ligne, aucune nouvelle version d'objectif", () => {
    const avec = commenterCible(depart, "v1", HYPOTHESE).cibles;
    const { cibles, operations } = commenterCible(avec, "v1", "Vente 22 k€, matière première 12 k€");
    assert.deepEqual(operations, [{ type: "comment", id: "v1", commentaire: "Vente 22 k€, matière première 12 k€" }]);
    assert.equal(cibles.length, depart.length);
    assert.equal(cibleEnVigueur(cibles, "gross_margin_pct", "2026-03-15", "abo"), 40);
  });

  test("commentaire inchangé (ou Annuler) : aucune écriture", () => {
    const avec = commenterCible(depart, "v1", HYPOTHESE).cibles;
    assert.deepEqual(commenterCible(avec, "v1", `  ${HYPOTHESE}  `).operations, []);
    assert.deepEqual(commenterCible(depart, "v1", "   ").operations, []);
    assert.deepEqual(commenterCible(depart, "inconnue", "x"), { cibles: depart, operations: [] });
  });

  test("commentaire vidé : il est effacé", () => {
    const avec = commenterCible(depart, "v1", HYPOTHESE).cibles;
    const { cibles, operations } = commenterCible(avec, "v1", "");
    assert.deepEqual(operations, [{ type: "comment", id: "v1", commentaire: null }]);
    assert.equal(parId(cibles, "v1").commentaire, null);
  });

  test("corriger la valeur à la même date : le commentaire reste attaché à la ligne", () => {
    const avec = commenterCible(depart, "v1", HYPOTHESE).cibles;
    const corrigee = corrigerCible(avec, "v1", { valeur: 42, validFrom: "2026-01-01" });
    assert.deepEqual(parId(corrigee.cibles!, "v1"), { ...v1, valeur: 42, commentaire: HYPOTHESE });
    assert.deepEqual(corrigee.operations, [{ type: "update", id: "v1", valeur: 42, validFrom: "2026-01-01" }]);
    const reposee = poserCible(avec, { type: "gross_margin_pct", dimension: "abo", validFrom: "2026-01-01" }, 43, "n");
    assert.equal(parId(reposee.cibles, "v1").commentaire, HYPOTHESE);
    const deplacee = corrigerCible(avec, "v1", { valeur: 40, validFrom: "2026-02-01" });
    assert.equal(parId(deplacee.cibles!, "v1").commentaire, HYPOTHESE);
  });

  test("nouvelle version à une nouvelle date : elle commence sans commentaire, celui de la précédente n'est pas recopié", () => {
    const avec = commenterCible(depart, "v2", "Nouveau tarif").cibles;
    const { cibles, operations } = poserCible(avec, { type: "gross_margin_pct", dimension: "abo", validFrom: "2026-10-01" }, 48, "v3");
    assert.equal(parId(cibles, "v3").commentaire, null);
    assert.equal(parId(cibles, "v2").commentaire, "Nouveau tarif");
    assert.deepEqual(operations, [{ type: "insert", cible: { id: "v3", type: "gross_margin_pct", dimension: "abo", validFrom: "2026-10-01", valeur: 48, commentaire: null } }]);
  });

  test("le commentaire n'entre dans aucun calcul d'objectif", () => {
    const avec = commenterCible(depart, "v1", HYPOTHESE).cibles;
    const revenus = [{ date: "2026-03-10", montant: 100, categorie: "abo" }, { date: "2026-03-11", montant: 100, categorie: "projets" }];
    assert.deepEqual(cibleDeMarge(avec, "gross_margin_pct", revenus), cibleDeMarge(depart, "gross_margin_pct", revenus));
  });

  test("saisie nettoyée : espaces de bord retirés, retours à la ligne gardés, longueur plafonnée", () => {
    assert.equal(normaliserCommentaire("  Ligne 1\nLigne 2  "), "Ligne 1\nLigne 2");
    assert.equal(normaliserCommentaire(" \n "), null);
    assert.equal(normaliserCommentaire("x".repeat(LONGUEUR_MAX_COMMENTAIRE + 50))!.length, LONGUEUR_MAX_COMMENTAIRE);
  });
});
