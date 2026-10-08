import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AjustementGestion } from "./pastAdjustments";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { trierTransactions } from "./pastDetail";
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
      ["Coûts commerciaux & opérationnels", -12_000], // une charge qui augmente le dégrade
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

  test("présent uniquement en B : Nouveau", () => {
    const agence = parLibelle("Agence RH");
    assert.deepEqual([agence.statut, agence.nombreA, agence.montantB, agence.contribution], ["nouveau", 0, -6_000, -6_000]);
  });

  test("présent uniquement en A : Absent, avec un impact positif pour une charge qui disparaît", () => {
    const bureau = parLibelle("Ancien bureau");
    assert.deepEqual([bureau.statut, bureau.nombreB, bureau.montantA, bureau.contribution], ["absent", 0, -4_000, 4_000]);
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
    assert.deepEqual(groupesDeLibelles(a, b, "ebitda").map((g) => [g.categorie, g.statut, g.contribution, g.nombreLibelles]), [
      ["Structure", "change", -3_300, 2],
      ["Bureaux", "absent", 900, 1],
    ]);
  });

  test("deux libellés purement temporels ne forment jamais un groupe", () => {
    const a = donnees([tx("2026-08-01", -100, "Structure", "Août 2026")], AOUT);
    const b = donnees([tx("2026-09-01", -100, "Structure", "Septembre 2026")], SEPTEMBRE);
    assert.deepEqual(groupesDeLibelles(a, b, "ebitda").map((g) => g.statut).sort(), ["absent", "nouveau"]);
  });

  test("classés par |contribution| décroissante", () => {
    assert.deepEqual(groupes.map((g) => g.contribution), [-6_000, 4_000, -3_300, -2_700, 0]);
  });

  test("la somme des groupes est la contribution de l'étage (hors ajustements)", () => {
    assert.equal(groupes.reduce((s, g) => s + g.contribution, 0), -8_000);
  });

  test("le filtre catégorie restreint les groupes ; un même libellé dans deux catégories reste séparé", () => {
    assert.deepEqual(groupesDeLibelles(A, B, "ebitda", "Bureaux").map((g) => g.libelle), ["Ancien bureau"]);
    const a = donnees([tx("2026-08-01", -100, "Structure", "Orange"), tx("2026-08-01", -50, "Bureaux", "Orange")], AOUT);
    const b = donnees([tx("2026-09-01", -100, "Structure", "Orange")], SEPTEMBRE);
    assert.deepEqual(groupesDeLibelles(a, b, "ebitda").map((g) => [g.categorie, g.statut]), [
      ["Bureaux", "absent"],
      ["Structure", "stable"],
    ]);
  });

  test("le libellé affiché est toujours un libellé source réel", () => {
    const sources = new Set([...aout, ...septembre].map((t) => t.label));
    assert.ok(groupes.every((g) => sources.has(g.libelle)));
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
