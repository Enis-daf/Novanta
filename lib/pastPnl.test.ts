import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { PastTransactionStockee } from "./pastTransactions";
import { calculerCashFlow, calculerPnl, CLE_AUTRES, ETAGES_COUTS, ETAGES_REVENUS, structureParCategorie } from "./pastPnl";

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

  test("Cash flow = EBITDA + Extra P&L, dérivé et distinct de l'Extra P&L", () => {
    assert.equal(calculerCashFlow(190_000, -85_000), 105_000);
    assert.equal(pnl.cashFlow, 105_000);
    assert.notEqual(pnl.cashFlow, pnl.extraPnl);
  });

  test("Cash flow négatif = consommation nette de trésorerie", () => {
    assert.equal(calculerCashFlow(-40_000, -85_000), -125_000);
    assert.equal(calculerCashFlow(-40_000, 60_000), 20_000);
  });

  test("aucune période sans transaction ne casse le calcul", () => {
    const vide = calculerPnl([], AXE, mappings);
    assert.equal(vide.ca, 0);
    assert.equal(vide.cashFlow, 0);
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
