import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AjustementGestion } from "./pastAdjustments";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { trierTransactions } from "./pastDetail";
import { dureeDeLaSelection, normaliserDurees, selectionDuPreset } from "./fiscalPeriods";
import { calculerPnl } from "./pastPnl";
import { PastTransactionStockee } from "./pastTransactions";
import { categoriesDeLEtage, comparerPeriodes, donneesPeriode, groupesDeLibelles, transactionsDuGroupe } from "./pastVariance";

const AXE = "229";
const AOUT = { debut: "2026-08-01", fin: "2026-08-31" };
const SEPTEMBRE = { debut: "2026-09-01", fin: "2026-09-30" };

const mapping = (id: string, pnlStage: MappingCategorie["pnlStage"]): MappingCategorie => ({
  sourceCategoryId: id,
  sourceCategoryName: id,
  sourceGroupId: AXE,
  pnlStage,
});
const mappings = indexerMappings([
  mapping("Ventes", "revenue"),
  mapping("Achats", "gross_margin"),
  mapping("Publicité", "contribution_margin"),
  mapping("Structure", "ebitda"),
  mapping("Bureaux", "ebitda"),
  mapping("TVA", "extra_pnl"),
  mapping("Nouvelle", null),
]);

let compteur = 0;
const tx = (date: string, amount: number, categorie: string, label: string, parts?: [string, number][]): PastTransactionStockee => ({
  id: `t${String(++compteur).padStart(3, "0")}`,
  sourceType: "pennylane",
  transactionDate: date,
  label,
  amount,
  currency: "EUR",
  affectations: (parts ?? [[categorie, 1]]).map(([categoryId, weight]) => ({ groupId: AXE, categoryId, categoryName: categoryId, weight })),
});

// Jeu de la spécification : Cash flow 120 k€ en août, 72 k€ en septembre.
const aout = [
  tx("2026-08-05", 300_000, "Ventes", "Stripe août 26"),
  tx("2026-08-06", -100_000, "Achats", "Fournisseur X"),
  tx("2026-08-07", -40_000, "Publicité", "Meta Ads"),
  tx("2026-08-08", -4_200, "Structure", "Amazon"),
  tx("2026-08-09", -4_000, "Bureaux", "Ancien bureau"),
  tx("2026-08-10", -11_800, "Structure", "Loyer"),
  tx("2026-08-11", -20_000, "TVA", "TVA"),
];
const septembre = [
  tx("2026-09-05", 280_000, "Ventes", "Stripe septembre 26"),
  tx("2026-09-06", -95_000, "Achats", "Fournisseur X"),
  tx("2026-09-07", -52_000, "Publicité", "Meta Ads"),
  tx("2026-09-08", -7_500, "Structure", "amazon"),
  tx("2026-09-09", -6_000, "Structure", "Agence RH"),
  tx("2026-09-10", -11_800, "Structure", "Loyer"),
  tx("2026-09-10", -2_700, "Structure", "Divers"),
  tx("2026-09-11", -33_000, "TVA", "TVA"),
];
const donnees = (transactions: PastTransactionStockee[], periode: typeof AOUT, ajustements: AjustementGestion[] = []) =>
  donneesPeriode(transactions, AXE, mappings, ajustements, periode);
const A = donnees(aout, AOUT);
const B = donnees(septembre, SEPTEMBRE);

describe("waterfall — du Cash flow de A à celui de B", () => {
  const comparaison = comparerPeriodes(A, B);

  test("Cash flow, écart en € et en %", () => {
    assert.equal(comparaison.cashFlowA, 120_000);
    assert.equal(comparaison.cashFlowB, 72_000);
    assert.equal(comparaison.ecart, -48_000);
    assert.equal(comparaison.ecartRelatif, -0.4);
  });

  test("le Cash flow est celui du P&L du module, pas un calcul à part", () => {
    assert.equal(comparaison.cashFlowA, calculerPnl(aout, AXE, mappings).cashFlow);
    assert.equal(comparaison.cashFlowB, calculerPnl(septembre, AXE, mappings).cashFlow);
  });

  test("chaque étage contribue en impact sur le Cash flow", () => {
    assert.deepEqual(comparaison.etages.map((e) => [e.libelle, e.contribution]), [
      ["CA", -20_000], // un revenu qui baisse dégrade le Cash flow
      ["Coûts directs", 5_000], // une charge qui diminue l'améliore
      ["Autres coûts variables", -12_000], // une charge qui augmente le dégrade
      ["Coûts de structure", -8_000],
      ["Extra P&L", -13_000],
    ]);
  });

  test("la somme des contributions réconcilie exactement A et B", () => {
    const somme = comparaison.etages.reduce((s, e) => s + e.contribution, 0);
    assert.equal(somme, comparaison.ecart);
    assert.equal(comparaison.cashFlowA + somme, comparaison.cashFlowB);
  });

  test("l'EBITDA et l'Extra P&L ne se mélangent pas", () => {
    assert.equal(comparaison.variationEbitda, -35_000);
    assert.equal(comparaison.variationExtraPnl, -13_000);
    assert.equal(comparaison.variationEbitda + comparaison.variationExtraPnl, comparaison.ecart);
  });

  test("Cash flow de A nul : pas de pourcentage plutôt qu'une division par zéro", () => {
    assert.equal(comparerPeriodes(donnees([], AOUT), B).ecartRelatif, null);
  });

  test("A négatif : le pourcentage garde le sens de l'écart", () => {
    const negatif = donnees([tx("2026-08-01", -1_000, "Structure", "x")], AOUT);
    const meilleur = donnees([tx("2026-09-01", -500, "Structure", "x")], SEPTEMBRE);
    assert.equal(comparerPeriodes(negatif, meilleur).ecartRelatif, 0.5);
  });

  test("les catégories non mappées et les transactions non catégorisées n'entrent pas dans l'écart", () => {
    const avecBruit = donnees([...septembre, tx("2026-09-20", -9_999, "Nouvelle", "?"), tx("2026-09-21", -8_888, "", "?", [])], SEPTEMBRE);
    assert.equal(comparerPeriodes(A, avecBruit).ecart, -48_000);
  });
});

describe("ajustements de gestion dans la waterfall", () => {
  const stock = (date: string, montant: number): AjustementGestion => ({
    id: date,
    date,
    label: "Variation de stock",
    montant,
    etage: "gross_margin",
    type: "inventory_variation",
    notes: null,
  });
  const ajustements = [stock("2026-08-31", 10_000), stock("2026-09-30", -30_000), stock("2026-07-31", 99_999)];
  const a = donnees(aout, AOUT, ajustements);
  const b = donnees(septembre, SEPTEMBRE, ajustements);

  test("chaque période ne prend que ses propres ajustements, dans leur étage", () => {
    const comparaison = comparerPeriodes(a, b);
    assert.equal(comparaison.cashFlowA, 130_000);
    assert.equal(comparaison.cashFlowB, 42_000);
    assert.equal(comparaison.etages.find((e) => e.etage === "gross_margin")!.contribution, 5_000 - 40_000);
    assert.equal(comparaison.etages.reduce((s, e) => s + e.contribution, 0), comparaison.ecart);
  });

  test("au niveau catégorie, l'ajustement a sa propre ligne, identifiée hors banque", () => {
    const lignes = categoriesDeLEtage(a, b, "gross_margin");
    assert.deepEqual(lignes.map((l) => [l.nom, l.horsBanque, l.contribution]), [
      ["Variation de stock", true, -40_000],
      ["Achats", false, 5_000],
    ]);
  });
});

describe("niveau catégorie", () => {
  test("classées par |contribution| décroissante, pas par montant de la période B", () => {
    const lignes = categoriesDeLEtage(A, B, "ebitda");
    assert.deepEqual(lignes.map((l) => [l.nom, l.montantA, l.montantB, l.contribution]), [
      ["Structure", -16_000, -28_000, -12_000],
      ["Bureaux", -4_000, 0, 4_000],
    ]);
  });

  test("la somme des catégories est la contribution de l'étage", () => {
    for (const { etage, contribution } of comparerPeriodes(A, B).etages) {
      assert.equal(categoriesDeLEtage(A, B, etage).reduce((s, l) => s + l.contribution, 0), contribution);
    }
  });
});

describe("ce qui change — groupes de libellés comparables", () => {
  const groupes = groupesDeLibelles(A, B, "ebitda");
  const parLibelle = (libelle: string) => groupes.find((g) => g.libelle.toLowerCase() === libelle.toLowerCase())!;

  test("présent dans les deux périodes : A, B et écart", () => {
    const amazon = parLibelle("amazon");
    assert.deepEqual([amazon.montantA, amazon.montantB, amazon.contribution, amazon.statut], [-4_200, -7_500, -3_300, "change"]);
  });

  test("flux présent d'un seul côté : un montant, rien en face, écart = B − A — sans badge", () => {
    const agence = parLibelle("Agence RH");
    assert.deepEqual([agence.nombreA, agence.montantA, agence.montantB, agence.contribution], [0, 0, -6_000, -6_000]);
    // Une charge qui n'existe plus en B améliore le Cash flow.
    const bureau = parLibelle("Ancien bureau");
    assert.deepEqual([bureau.nombreB, bureau.montantA, bureau.montantB, bureau.contribution], [0, -4_000, 0, 4_000]);
    assert.ok(groupes.every((g) => g.statut === "change" || g.statut === "stable"));
  });

  test("le sens A / B est libre : inverser les périodes inverse seulement le signe des écarts", () => {
    const inverse = groupesDeLibelles(B, A, "ebitda");
    for (const g of groupes) {
      const miroir = inverse.find((x) => x.cle === g.cle)!;
      assert.equal(miroir.contribution + g.contribution, 0);
      assert.equal(miroir.statut, g.statut);
    }
  });

  test("montant identique des deux côtés : stable", () => {
    assert.equal(parLibelle("Loyer").statut, "stable");
  });

  test("stable = même montant à 1 € près, jamais un seuil relatif", () => {
    const cas = (montantA: number, montantB: number) =>
      groupesDeLibelles(
        donnees([tx("2026-08-01", montantA, "Structure", "Abonnement")], AOUT),
        donnees([tx("2026-09-01", montantB, "Structure", "Abonnement")], SEPTEMBRE),
        "ebitda"
      )[0].statut;
    assert.equal(cas(-20, -21), "stable");
    assert.equal(cas(-20, -21.5), "change");
    assert.equal(cas(-1_000, -1_009), "change");
    // 0,9 % d'un million reste 9 000 € : jamais masqué.
    assert.equal(cas(1_000_000, 1_009_000), "change");
  });

  test("libellés rapprochés malgré le mois et l'année, dans la même catégorie seulement", () => {
    const a = donnees([tx("2026-08-08", -4_200, "Structure", "Amazon août 26"), tx("2026-08-09", -900, "Bureaux", "Amazon août 26")], AOUT);
    const b = donnees([tx("2026-09-08", -7_500, "Structure", "Amazon septembre 26")], SEPTEMBRE);
    assert.deepEqual(groupesDeLibelles(a, b, "ebitda").map((g) => [g.categorie, g.libelle, g.contribution, g.nombreLibelles]), [
      ["Structure", "Amazon", -3_300, 2],
      ["Bureaux", "Amazon", 900, 1],
    ]);
  });

  test("deux libellés purement temporels ne forment jamais un groupe", () => {
    const a = donnees([tx("2026-08-01", -100, "Structure", "Août 2026")], AOUT);
    const b = donnees([tx("2026-09-01", -100, "Structure", "Septembre 2026")], SEPTEMBRE);
    assert.deepEqual(groupesDeLibelles(a, b, "ebitda").map((g) => [g.nombreA, g.nombreB]).sort(), [[0, 1], [1, 0]]);
  });

  test("classés par |contribution| décroissante", () => {
    assert.deepEqual(groupes.map((g) => g.contribution), [-6_000, 4_000, -3_300, -2_700, 0]);
  });

  test("la somme des groupes est la contribution de l'étage (hors ajustements)", () => {
    assert.equal(groupes.reduce((s, g) => s + g.contribution, 0), -8_000);
  });

  test("le filtre catégorie restreint les groupes ; un même libellé dans deux catégories reste séparé", () => {
    assert.deepEqual(groupesDeLibelles(A, B, "ebitda", "Bureaux").map((g) => g.libelle), ["Ancien Bureau"]);
    const a = donnees([tx("2026-08-01", -100, "Structure", "Orange"), tx("2026-08-01", -50, "Bureaux", "Orange")], AOUT);
    const b = donnees([tx("2026-09-01", -100, "Structure", "Orange")], SEPTEMBRE);
    assert.deepEqual(groupesDeLibelles(a, b, "ebitda").map((g) => [g.categorie, g.nombreA, g.nombreB, g.statut]), [
      ["Bureaux", 1, 0, "change"],
      ["Structure", 1, 1, "stable"],
    ]);
  });

  test("le titre d'un flux est sa partie stable, lisible ; les libellés d'origine restent dans le détail", () => {
    assert.deepEqual(groupes.map((g) => g.libelle), ["Agence Rh", "Ancien Bureau", "Amazon", "Divers", "Loyer"]);
    const amazon = parLibelle("Amazon");
    assert.deepEqual(transactionsDuGroupe(A, B, "ebitda", amazon.cle).map((p) => p.label).sort(), ["Amazon", "amazon"]);
  });

  test("transaction ventilée : seule la part de la catégorie entre dans le groupe", () => {
    const a = donnees([tx("2026-08-01", -10_000, "", "Agence", [["Structure", 0.7], ["Publicité", 0.3]])], AOUT);
    const b = donnees([], SEPTEMBRE);
    assert.deepEqual(groupesDeLibelles(a, b, "ebitda").map((g) => [g.montantA, g.contribution]), [[-7_000, 7_000]]);
    assert.deepEqual(groupesDeLibelles(a, b, "contribution_margin").map((g) => g.montantA), [-3_000]);
  });
});

describe("transactions d'un groupe", () => {
  test("celles des deux périodes, marquées A ou B, triables comme ailleurs dans le module", () => {
    const amazon = groupesDeLibelles(A, B, "ebitda").find((g) => g.libelle.toLowerCase() === "amazon")!;
    const lignes = transactionsDuGroupe(A, B, "ebitda", amazon.cle);
    assert.deepEqual(trierTransactions(lignes, "montant").map((p) => [(p as typeof lignes[number]).cote, p.label, p.montant]), [
      ["B", "amazon", -7_500],
      ["A", "Amazon", -4_200],
    ]);
    assert.deepEqual(trierTransactions(lignes, "date").map((p) => p.transactionDate), ["2026-09-08", "2026-08-08"]);
  });

  test("un libellé vide n'est rapproché d'aucun autre", () => {
    const a = donnees([tx("2026-08-01", -10, "Structure", ""), tx("2026-08-02", -20, "Structure", "  ")], AOUT);
    const b = donnees([tx("2026-09-01", -30, "Structure", "")], SEPTEMBRE);
    assert.equal(groupesDeLibelles(a, b, "ebitda").length, 3);
  });
});

describe("périodes de durées différentes — la plus longue est ramenée à la plus courte", () => {
  const preset = (mois: number, jours: number) => ({ mois, jours });
  const libre = (jours: number) => ({ mois: null, jours });

  test("exercice contre mois : coefficient 1/12 sur l'exercice, en mois", () => {
    assert.deepEqual(normaliserDurees(preset(12, 365), preset(1, 30)), {
      coefficientA: 1 / 12,
      coefficientB: 1,
      detail: { cote: "A", duree: "1 mois" },
    });
    assert.deepEqual(normaliserDurees(preset(3, 92), preset(6, 181)).detail, { cote: "B", duree: "3 mois" });
    assert.equal(normaliserDurees(preset(3, 92), preset(6, 181)).coefficientB, 0.5);
  });

  test("même durée fiscale : aucune normalisation, même si les mois n'ont pas le même nombre de jours", () => {
    for (const [a, b] of [[preset(1, 31), preset(1, 30)], [preset(3, 92), preset(3, 90)], [preset(6, 184), preset(6, 181)], [preset(12, 365), preset(12, 366)]]) {
      assert.deepEqual(normaliserDurees(a, b), { coefficientA: 1, coefficientB: 1, detail: null });
    }
  });

  test("dès qu'une période est faite de dates libres, la durée se compte en jours exacts", () => {
    assert.deepEqual(normaliserDurees(libre(45), preset(1, 30)), {
      coefficientA: 30 / 45,
      coefficientB: 1,
      detail: { cote: "A", duree: "30 jours" },
    });
    assert.deepEqual(normaliserDurees(libre(10), libre(10)).detail, null);
    assert.deepEqual(normaliserDurees(libre(1), libre(7)).detail, { cote: "B", duree: "1 jour" });
  });

  test("durée d'une sélection : mois naturels pour un preset, jours pour des dates libres", () => {
    const config = { mois: 11, jour: 1 };
    const jour = "2026-10-08";
    assert.deepEqual(dureeDeLaSelection(selectionDuPreset("exercice", jour, config), jour, config), { mois: 12, jours: 365 });
    assert.deepEqual(dureeDeLaSelection(selectionDuPreset("mois_m1", jour, config), jour, config), { mois: 1, jours: 30 });
    assert.deepEqual(dureeDeLaSelection(selectionDuPreset("q3", jour, config), jour, config), { mois: 3, jours: 92 });
    assert.deepEqual(
      dureeDeLaSelection({ choix: "personnalise", personnalisee: { debut: "2026-02-01", fin: "2026-03-15" } }, jour, config),
      { mois: null, jours: 43 }
    );
  });

  // Exercice de 12 mois à 1 200 000 € de Cash flow, comparé à un mois à 80 000 €.
  const exercice = Array.from({ length: 12 }, (_, i) => [
    tx(`2025-${String(i + 1).padStart(2, "0")}-10`, 150_000, "Ventes", "Stripe"),
    tx(`2025-${String(i + 1).padStart(2, "0")}-11`, -45_000, "Structure", "Loyer"),
    tx(`2025-${String(i + 1).padStart(2, "0")}-12`, -5_000, "Structure", `Amazon ${i + 1}/2025`),
  ]).flat();
  const mois = [tx("2026-09-10", 140_000, "Ventes", "Stripe"), tx("2026-09-11", -45_000, "Structure", "Loyer"), tx("2026-09-12", -15_000, "Structure", "Amazon 09/2026")];
  const stock = [{ id: "s", date: "2025-06-30", label: "Variation de stock", montant: -24_000, etage: "gross_margin" as const, type: "inventory_variation", notes: null }];
  const a = donneesPeriode(exercice, AXE, mappings, stock, { debut: "2025-01-01", fin: "2025-12-31" }, 1 / 12);
  const b = donneesPeriode(mois, AXE, mappings, stock, SEPTEMBRE);
  const proche = (reel: number, attendu: number) => assert.ok(Math.abs(reel - attendu) < 1e-6, `${reel} ≠ ${attendu}`);

  test("le Cash flow de la période longue est ramené à la durée courte", () => {
    const comparaison = comparerPeriodes(a, b);
    proche(comparaison.cashFlowA, (1_200_000 - 24_000) / 12);
    proche(comparaison.cashFlowB, 80_000);
    proche(comparaison.ecart, 80_000 - 98_000);
  });

  test("la waterfall normalisée réconcilie toujours A et B, ajustements compris", () => {
    const comparaison = comparerPeriodes(a, b);
    proche(comparaison.cashFlowA + comparaison.etages.reduce((s, e) => s + e.contribution, 0), comparaison.cashFlowB);
    proche(comparaison.etages.find((e) => e.etage === "gross_margin")!.contribution, 2_000);
    proche(comparaison.variationEbitda + comparaison.variationExtraPnl, comparaison.ecart);
  });

  test("catégories et groupes de libellés : référence normalisée contre montant réel de la période courte", () => {
    const structure = categoriesDeLEtage(a, b, "ebitda").find((l) => l.nom === "Structure")!;
    proche(structure.montantA, -50_000);
    proche(structure.montantB, -60_000);
    proche(structure.contribution, -10_000);
    const amazon = groupesDeLibelles(a, b, "ebitda").find((g) => g.libelle.startsWith("Amazon"))!;
    proche(amazon.montantA, -5_000);
    proche(amazon.contribution, -10_000);
    assert.equal(amazon.nombreA, 12);
  });

  test("les transactions restent à leur montant réel : aucune n'est divisée", () => {
    const amazon = groupesDeLibelles(a, b, "ebitda").find((g) => g.libelle.startsWith("Amazon"))!;
    const lignes = transactionsDuGroupe(a, b, "ebitda", amazon.cle);
    assert.equal(lignes.length, 13);
    assert.deepEqual([...new Set(lignes.filter((l) => l.cote === "A").map((l) => l.montant))], [-5_000]);
    assert.ok(a.parts.every((p) => Number.isInteger(p.montant)));
  });

  test("sans coefficient, rien ne change : même durée = valeurs réelles", () => {
    assert.equal(A.coefficient, 1);
    assert.equal(comparerPeriodes(A, B).ecart, -48_000);
  });
});

describe("flux comparable — un prélèvement récurrent est un seul bloc", () => {
  const meta = (ech: string, ref: string) =>
    `PRLV SEPA META PLATFORMS IRELAND ECH/${ech} ID EMETTEUR/IE63ZZZ307358 MDT/FBEUX7L00D76 REF/${ref} LIB/FACEBOOK ADS ${ref}`;
  const mapPub = indexerMappings([mapping("Publicité & marketing", "contribution_margin"), mapping("Logistique", "contribution_margin")]);
  const d = (transactions: PastTransactionStockee[], periode: typeof AOUT) => donneesPeriode(transactions, AXE, mapPub, [], periode);
  const a = d(
    [
      tx("2026-08-26", -581, "Publicité & marketing", meta("260826", "BW6UVZ4AOC")),
      tx("2026-08-27", -554, "Publicité & marketing", meta("270826", "BW6UW1KA7O")),
      tx("2026-08-28", -551, "Publicité & marketing", meta("280826", "BW6UX2KB8P")),
      tx("2026-08-05", -900, "Logistique", "PRLV SEPA BIGBLUE ECH/050826 ID EMETTEUR/FR12ZZZ123456 MDT/BB-2024-001 REF/INV20260805 LIB/BIGBLUE INV20260805"),
    ],
    AOUT
  );
  const b = d(
    [
      tx("2026-09-08", -595, "Publicité & marketing", meta("080926", "BW70UN8DE4")),
      tx("2026-09-28", -549, "Publicité & marketing", meta("280926", "BW74UAHZIE")),
      tx("2026-09-29", -610, "Publicité & marketing", meta("290926", "BW72V4VLS1")),
      tx("2026-09-05", -1_250, "Logistique", "PRLV SEPA BIGBLUE ECH/050926 ID EMETTEUR/FR12ZZZ123456 MDT/BB-2024-001 REF/INV20260905 LIB/BIGBLUE INV20260905"),
    ],
    SEPTEMBRE
  );
  const groupes = groupesDeLibelles(a, b, "contribution_margin");

  test("six prélèvements Meta aux ECH et REF différents : UN bloc, agrégé par période", () => {
    assert.deepEqual(
      groupes.map((g) => [g.libelle, g.categorie, g.nombreA, g.nombreB, g.montantA, g.montantB, g.contribution]),
      [
        ["Bigblue", "Logistique", 1, 1, -900, -1_250, -350],
        ["Facebook Ads", "Publicité & marketing", 3, 3, -1_686, -1_754, -68],
      ]
    );
  });

  test("le classement suit l'écart AGRÉGÉ du flux, pas le montant d'une transaction", () => {
    // Bigblue (−350 € d'écart) passe devant Meta (−68 €), alors que Meta pèse plus en montant.
    assert.deepEqual(groupes.map((g) => g.libelle), ["Bigblue", "Facebook Ads"]);
  });

  test("au clic : toutes les transactions brutes du flux, des deux périodes, à leur montant réel", () => {
    const facebook = groupes.find((g) => g.libelle === "Facebook Ads")!;
    const lignes = transactionsDuGroupe(a, b, "contribution_margin", facebook.cle);
    assert.deepEqual(lignes.map((l) => [l.cote, l.montant]), [["A", -581], ["A", -554], ["A", -551], ["B", -595], ["B", -549], ["B", -610]]);
    assert.ok(lignes.every((l) => l.label.startsWith("PRLV SEPA META")));
  });

  test("même émetteur et même mandat dans deux catégories : deux flux distincts", () => {
    const croise = d([tx("2026-08-01", -10, "Publicité & marketing", meta("010826", "AAAAAA1111")), tx("2026-08-02", -20, "Logistique", meta("020826", "BBBBBB2222"))], AOUT);
    assert.equal(groupesDeLibelles(croise, d([], SEPTEMBRE), "contribution_margin").length, 2);
  });
});

describe("alias de flux — le nom donné par l'organisation", () => {
  const OCTOBRE = { debut: "2026-10-01", fin: "2026-10-31" };
  const a = donnees([tx("2026-08-04", -1_000, "Structure", "PRELEVEMENT CREANCE 021618 RECLAMEE")], AOUT);
  const b = donnees([tx("2026-09-04", -1_400, "Structure", "PRLV CREANCE 030426")], SEPTEMBRE);
  const alias = new Map([["tiers:creance", "Remboursement Dailly"]]);

  test("sans alias : nom détecté, et la clé sous laquelle un alias s'enregistrera", () => {
    const [g] = groupesDeLibelles(a, b, "ebitda");
    assert.equal(g.libelle, "Creance");
    assert.equal(g.alias, null);
    assert.deepEqual(g.clesAlias, [{ cle: "tiers:creance", exemple: "PRELEVEMENT CREANCE 021618 RECLAMEE" }]);
  });

  test("avec alias : il est affiché, le nom détecté reste disponible", () => {
    const [g] = groupesDeLibelles(a, b, "ebitda", null, alias);
    assert.equal(g.libelle, "Remboursement Dailly");
    assert.equal(g.alias, "Remboursement Dailly");
    assert.equal(g.libelleDetecte, "Creance");
  });

  test("nouvelle période, libellé différent, même flux : l'alias est repris sans nouvelle action", () => {
    const octobre = donnees([tx("2026-10-06", -1_250, "Structure", "PRELEVEMENT CREANCE 070912 RECLAMEE")], OCTOBRE);
    const [g] = groupesDeLibelles(b, octobre, "ebitda", null, alias);
    assert.equal(g.libelle, "Remboursement Dailly");
    assert.equal(g.nombreA + g.nombreB, 2);
  });

  test("même flux dans une autre catégorie : même nom, sans fusionner les deux catégories", () => {
    const recategorise = donnees([tx("2026-09-04", -1_400, "Bureaux", "PRLV CREANCE 030426")], SEPTEMBRE);
    const groupes = groupesDeLibelles(a, recategorise, "ebitda", null, alias);
    assert.deepEqual(groupes.map((g) => [g.categorie, g.libelle]).sort(), [["Bureaux", "Remboursement Dailly"], ["Structure", "Remboursement Dailly"]]);
  });

  test("modifier l'alias change le nom ; le retirer rend le nom détecté", () => {
    assert.equal(groupesDeLibelles(a, b, "ebitda", null, new Map([["tiers:creance", "Remboursement cession Dailly"]]))[0].libelle, "Remboursement cession Dailly");
    assert.equal(groupesDeLibelles(a, b, "ebitda", null, new Map())[0].libelle, "Creance");
  });

  test("un alias ne change ni les groupes, ni les montants, ni leur ordre", () => {
    const periodeA = donnees([...aout, tx("2026-08-04", -1_000, "Structure", "PRELEVEMENT CREANCE 021618 RECLAMEE")], AOUT);
    const periodeB = donnees([...septembre, tx("2026-09-04", -1_400, "Structure", "PRLV CREANCE 030426")], SEPTEMBRE);
    const sansNom = ({ libelle: _libelle, alias: _alias, ...reste }: ReturnType<typeof groupesDeLibelles>[number]) => reste;
    for (const etage of ["revenue", "gross_margin", "contribution_margin", "ebitda", "extra_pnl"] as const) {
      assert.deepEqual(groupesDeLibelles(periodeA, periodeB, etage, null, alias).map(sansNom), groupesDeLibelles(periodeA, periodeB, etage).map(sansNom));
    }
    assert.deepEqual(comparerPeriodes(periodeA, periodeB), comparerPeriodes(periodeA, periodeB));
  });

  test("le détail du groupe montre toujours les libellés bancaires d'origine", () => {
    const [g] = groupesDeLibelles(a, b, "ebitda", null, alias);
    assert.deepEqual(transactionsDuGroupe(a, b, "ebitda", g.cle).map((p) => p.label).sort(), [
      "PRELEVEMENT CREANCE 021618 RECLAMEE",
      "PRLV CREANCE 030426",
    ]);
  });

  test("contreparties voisines réunies : le renommage couvre chaque identité propre du groupe", () => {
    const voisinesA = donnees([tx("2026-08-04", -300, "Structure", "PAIEMENT PAR CARTE X3026 EUROPCAM ST GERMAIN 27/05")], AOUT);
    const voisinesB = donnees([tx("2026-09-04", -500, "Structure", "VIREMENT EMIS VIR INST vers SARL EUROPCAM commande 000066266")], SEPTEMBRE);
    const [g, ...autres] = groupesDeLibelles(voisinesA, voisinesB, "ebitda");
    assert.equal(autres.length, 0);
    assert.equal(g.clesAlias.length, 2);
    // Dans une comparaison où la contrepartie de référence est absente, l'autre garde le nom.
    const cleVoisine = g.clesAlias.map((c) => c.cle).find((cle) => cle !== "tiers:europcam")!;
    const seule = groupesDeLibelles(voisinesA, donnees([], SEPTEMBRE), "ebitda", null, new Map([[cleVoisine, "Europcam"]]));
    assert.equal(seule[0].libelle, "Europcam");
  });
});
