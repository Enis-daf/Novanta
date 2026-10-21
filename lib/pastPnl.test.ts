import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { PastTransactionStockee } from "./pastTransactions";
import { calculerCashFlowOperationnel, calculerPnl, calculerVariationTresorerie, CLE_AUTRES, ETAGES_COUTS, ETAGES_REVENUS, structureParCategorie } from "./pastPnl";

const AXE = "229";

function mapping(id: string, nom: string, pnlStage: MappingCategorie["pnlStage"]): MappingCategorie {
  return { sourceCategoryId: id, sourceCategoryName: nom, sourceGroupId: AXE, pnlStage };
}

function tx(amount: number, parts: [string, string, number][], groupId = AXE): PastTransactionStockee {
  return {
    id: `t${Math.random()}`,
    sourceType: "pennylane",
    transactionDate: "2026-03-01",
    label: "",
    amount,
    currency: "EUR",
    affectations: parts.map(([categoryId, categoryName, weight]) => ({ groupId, categoryId, categoryName, weight })),
  };
}

const mappings = indexerMappings([
  mapping("ca", "Stripe", "revenue"),
  mapping("mat", "Achats matières", "gross_margin"),
  mapping("ads", "Meta Ads", "contribution_margin"),
  mapping("loyer", "Loyer", "ebitda"),
  mapping("tva", "TVA", "extra_pnl"),
  mapping("new", "Nouvelle catégorie", null),
]);

// Jeu de données de la spécification.
const transactions = [
  tx(1_250_000, [["ca", "Stripe", 1]]),
  tx(-530_000, [["mat", "Achats matières", 1]]),
  tx(-210_000, [["ads", "Meta Ads", 1]]),
  tx(-320_000, [["loyer", "Loyer", 1]]),
  tx(-85_000, [["tva", "TVA", 1]]),
];

describe("P&L synthétique — additions successives de montants signés", () => {
  const pnl = calculerPnl(transactions, AXE, mappings);

  test("CA, coûts et soldes intermédiaires", () => {
    assert.equal(pnl.ca, 1_250_000);
    assert.equal(pnl.coutsDirects, -530_000);
    assert.equal(pnl.margeBrute, 720_000);
    assert.equal(pnl.coutsCommerciaux, -210_000);
    assert.equal(pnl.margeContributive, 510_000);
    assert.equal(pnl.coutsStructure, -320_000);
    assert.equal(pnl.ebitda, 190_000);
    assert.equal(pnl.extraPnl, -85_000);
  });

  test("ratios rapportés au CA", () => {
    assert.equal(pnl.ratios.margeBrute, 0.576);
    assert.equal(pnl.ratios.margeContributive, 0.408);
    assert.equal(pnl.ratios.ebitda, 0.152);
  });

  test("CA nul : pas de ratio plutôt qu'une division par zéro", () => {
    const sansCa = calculerPnl([tx(-100, [["loyer", "Loyer", 1]])], AXE, mappings);
    assert.deepEqual(sansCa.ratios, { margeBrute: null, margeContributive: null, ebitda: null });
    assert.equal(sansCa.ebitda, -100);
  });

  test("Cash flow opérationnel = EBITDA + Extra P&L (+ TVA), dérivé et distinct de l'Extra P&L", () => {
    assert.equal(calculerCashFlowOperationnel(190_000, -85_000, 0), 105_000);
    assert.equal(pnl.cashFlowOperationnel, 105_000);
    assert.notEqual(pnl.cashFlowOperationnel, pnl.extraPnl);
  });

  test("Cash flow opérationnel négatif = consommation nette de trésorerie", () => {
    assert.equal(calculerCashFlowOperationnel(-40_000, -85_000, 0), -125_000);
    assert.equal(calculerCashFlowOperationnel(-40_000, 60_000, 0), 20_000);
  });

  test("aucune période sans transaction ne casse le calcul", () => {
    const vide = calculerPnl([], AXE, mappings);
    assert.equal(vide.ca, 0);
    assert.equal(vide.variationTresorerie, 0);
    assert.deepEqual(vide.categories, []);
  });
});

describe("P&L — ce qui est exclu ou réparti", () => {
  test("une catégorie non mappée est exclue des calculs et signalée", () => {
    const pnl = calculerPnl([...transactions, tx(-820, [["new", "Nouvelle catégorie", 1]]), tx(-80, [["inconnue", "Jamais vue", 1]])], AXE, mappings);
    assert.equal(pnl.ebitda, 190_000);
    assert.deepEqual(pnl.nonMappees, { nombreCategories: 2, montant: -900 });
  });

  test("une transaction non catégorisée n'entre dans aucun étage et n'est pas « à mapper »", () => {
    const pnl = calculerPnl([...transactions, tx(-400, [])], AXE, mappings);
    assert.equal(pnl.ebitda, 190_000);
    assert.equal(pnl.nonMappees.nombreCategories, 0);
  });

  test("une transaction ventilée est répartie selon ses pondérations, entre étages", () => {
    const pnl = calculerPnl([tx(-1000, [["ads", "Meta Ads", 0.7], ["loyer", "Loyer", 0.3]])], AXE, mappings);
    assert.equal(pnl.coutsCommerciaux, -700);
    assert.equal(pnl.coutsStructure, -300);
    assert.deepEqual(
      pnl.categories.map((c) => [c.sourceCategoryName, c.etage, c.montant]),
      [
        ["Meta Ads", "contribution_margin", -700],
        ["Loyer", "ebitda", -300],
      ]
    );
  });

  test("seul l'axe retenu compte ; sans axe, rien n'est calculé", () => {
    const autreAxe = tx(-999, [["ads", "Meta Ads", 1]], "300");
    assert.equal(calculerPnl([autreAxe], AXE, mappings).coutsCommerciaux, 0);
    assert.equal(calculerPnl(transactions, null, mappings).ca, 0);
  });

  test("changer un mapping reclasse tout l'historique sans toucher aux transactions", () => {
    const copie = structuredClone(transactions);
    const apres = indexerMappings([...mappings.values()].map((m) => (m.sourceCategoryId === "loyer" ? { ...m, pnlStage: "contribution_margin" as const } : m)));
    const pnl = calculerPnl(transactions, AXE, apres);
    assert.equal(pnl.coutsStructure, 0);
    assert.equal(pnl.coutsCommerciaux, -530_000);
    assert.equal(pnl.margeContributive, 190_000);
    assert.equal(pnl.ebitda, 190_000);
    assert.deepEqual(transactions, copie);
  });
});

describe("structure des revenus et des coûts (camemberts)", () => {
  const pnl = calculerPnl(
    [...transactions, tx(250_000, [["ca2", "Abonnements", 1]]), tx(-90_000, [["ads", "Meta Ads", 1]])],
    AXE,
    indexerMappings([...mappings.values(), mapping("ca2", "Abonnements", "revenue")])
  );

  test("revenus : uniquement les catégories de l'étage revenue", () => {
    const structure = structureParCategorie(pnl.categories, ETAGES_REVENUS, "revenus");
    assert.deepEqual(structure.parts.map((p) => [p.nom, p.montant]), [
      ["Stripe", 1_250_000],
      ["Abonnements", 250_000],
    ]);
    assert.equal(structure.total, 1_500_000);
    assert.equal(structure.parts[0].part, 1_250_000 / 1_500_000);
  });

  test("coûts : coûts directs, autres coûts variables et de structure — jamais le CA ni l'Extra P&L", () => {
    const structure = structureParCategorie(pnl.categories, ETAGES_COUTS, "couts");
    assert.deepEqual(structure.parts.map((p) => [p.nom, p.montant]), [
      ["Achats matières", -530_000],
      ["Loyer", -320_000],
      ["Meta Ads", -300_000],
    ]);
    assert.equal(structure.total, -1_150_000);
    // Taille d'une part = valeur absolue ; le montant reste signé.
    assert.ok(structure.parts.every((p) => p.part > 0 && p.montant < 0));
    assert.equal(structure.parts.reduce((s, p) => s + p.part, 0), 1);
  });

  test("au-delà de 6 catégories : les 5 plus grandes, puis « Autres »", () => {
    const categories = Array.from({ length: 9 }, (_, i) => ({
      sourceCategoryId: `c${i}`,
      sourceCategoryName: `Catégorie ${i}`,
      etage: "ebitda" as const,
      montant: -(i + 1) * 100,
    }));
    const structure = structureParCategorie(categories, ETAGES_COUTS, "couts");
    assert.equal(structure.parts.length, 6);
    assert.deepEqual(structure.parts.slice(0, 5).map((p) => p.montant), [-900, -800, -700, -600, -500]);
    assert.deepEqual([structure.parts[5].cle, structure.parts[5].nom, structure.parts[5].montant], [CLE_AUTRES, "Autres (4 catégories)", -1000]);
  });

  test("un montant de signe contraire n'est pas représenté, mais il est compté", () => {
    const structure = structureParCategorie(
      [
        { sourceCategoryId: "a", sourceCategoryName: "Loyer", etage: "ebitda", montant: -100 },
        { sourceCategoryId: "b", sourceCategoryName: "Remboursement", etage: "ebitda", montant: 40 },
      ],
      ETAGES_COUTS,
      "couts"
    );
    assert.deepEqual(structure.parts.map((p) => p.nom), ["Loyer"]);
    assert.equal(structure.nombreNonRepresentees, 1);
  });
});

describe("fin du P&L — Cash flow opérationnel puis Variation de trésorerie", () => {
  const avecFinancement = indexerMappings([
    mapping("ca", "Stripe", "revenue"),
    mapping("loyer", "Loyer", "ebitda"),
    mapping("tva", "TVA", "extra_pnl"),
    mapping("fin", "Catégorie quelconque", "financing"),
  ]);
  const activite = [tx(300_000, [["ca", "Stripe", 1]]), tx(-200_000, [["loyer", "Loyer", 1]]), tx(-20_000, [["tva", "TVA", 1]])];
  const pnlAvec = (financement: number[]) => calculerPnl([...activite, ...financement.map((m) => tx(m, [["fin", "Catégorie quelconque", 1]]))], AXE, avecFinancement);

  test("Cash flow opérationnel = EBITDA + Extra P&L : une addition de montants signés, jamais une soustraction", () => {
    const pnl = pnlAvec([150_000]);
    assert.deepEqual([pnl.ebitda, pnl.extraPnl, pnl.cashFlowOperationnel], [100_000, -20_000, 80_000]);
    assert.equal(pnl.cashFlowOperationnel, pnl.ebitda + pnl.extraPnl);
    assert.equal(calculerCashFlowOperationnel(100_000, -20_000, 0), 80_000);
  });

  test("Variation de trésorerie = Cash flow opérationnel + Virements internes & Financement", () => {
    const pnl = pnlAvec([150_000]);
    assert.deepEqual([pnl.financements, pnl.variationTresorerie], [150_000, 230_000]);
    assert.equal(pnl.variationTresorerie, pnl.cashFlowOperationnel + pnl.financements);
    assert.equal(calculerVariationTresorerie(80_000, 150_000), 230_000);
  });

  test("un financement positif augmente la variation de trésorerie, un flux négatif la diminue ; le Cash flow opérationnel ne bouge pas", () => {
    assert.deepEqual([pnlAvec([150_000]).variationTresorerie, pnlAvec([-50_000]).variationTresorerie], [230_000, 30_000]);
    assert.deepEqual([pnlAvec([150_000]).cashFlowOperationnel, pnlAvec([-50_000]).cashFlowOperationnel, pnlAvec([]).cashFlowOperationnel], [80_000, 80_000, 80_000]);
    assert.equal(pnlAvec([100_000, -100_000]).variationTresorerie, 80_000);
  });

  test("sans rien dans l'étage de financement, les deux résultats sont égaux", () => {
    assert.equal(pnl0().variationTresorerie, pnl0().cashFlowOperationnel);
    function pnl0() {
      return pnlAvec([]);
    }
  });

  test("les autres étages du P&L ne sont pas touchés par le financement", () => {
    const { financements: _f, variationTresorerie: _v, categories: _c, ...sans } = pnlAvec([]);
    const { financements: _f2, variationTresorerie: _v2, categories: _c2, ...avec } = pnlAvec([150_000, -50_000]);
    assert.deepEqual(avec, sans);
  });

  test("ajustements de gestion : comptés dans le résultat de leur étage", () => {
    const ajustement = { id: "a", date: "2026-03-31", label: "Ajustement", montant: 1_000, etage: "extra_pnl" as const, type: "manual", notes: null };
    const pnl = calculerPnl(activite, AXE, avecFinancement, [ajustement]);
    assert.deepEqual([pnl.extraPnl, pnl.cashFlowOperationnel, pnl.variationTresorerie], [-20_000, 81_000, 81_000]);
  });
});
