import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { calculerPnl } from "./pastPnl";
import { anomalieDeSigne, anomaliesDeSigne, compterTransactionsAvecAnomalie, repartirAnomalies, ValidationSigne } from "./pastSignChecks";
import { PastTransactionStockee } from "./pastTransactions";

const AXE = "229";

function mapping(id: string, pnlStage: MappingCategorie["pnlStage"]): MappingCategorie {
  return { sourceCategoryId: id, sourceCategoryName: `Catégorie ${id}`, sourceGroupId: AXE, pnlStage };
}

function tx(id: string, amount: number, parts: [string, number][], date = "2026-03-01"): PastTransactionStockee {
  return {
    id,
    sourceType: "pennylane",
    transactionDate: date,
    label: `Transaction ${id}`,
    amount,
    currency: "EUR",
    affectations: parts.map(([categoryId, weight]) => ({ groupId: AXE, categoryId, categoryName: `Catégorie ${categoryId}`, weight })),
  };
}

const mappings = indexerMappings([
  mapping("ca", "revenue"),
  mapping("direct", "gross_margin"),
  mapping("commercial", "contribution_margin"),
  mapping("structure", "ebitda"),
  mapping("extra", "extra_pnl"),
  mapping("nouvelle", null),
]);

describe("règles de signe par étage", () => {
  test("un montant négatif en revenue est signalé", () => {
    assert.equal(anomalieDeSigne("revenue", -50), "ca_negatif");
    assert.equal(anomalieDeSigne("revenue", 50), null);
  });

  test("un montant positif dans un étage de coûts est signalé", () => {
    for (const etage of ["gross_margin", "contribution_margin", "ebitda"] as const) {
      assert.equal(anomalieDeSigne(etage, 50), "cout_positif");
      assert.equal(anomalieDeSigne(etage, -50), null);
    }
  });

  test("aucune règle de signe pour extra_pnl ; un montant nul n'est jamais une anomalie", () => {
    assert.equal(anomalieDeSigne("extra_pnl", 50), null);
    assert.equal(anomalieDeSigne("extra_pnl", -50), null);
    assert.equal(anomalieDeSigne("revenue", 0), null);
    assert.equal(anomalieDeSigne("ebitda", 0), null);
  });
});

describe("anomalies de signe sur une période", () => {
  const transactions = [
    tx("vente", 1000, [["ca", 1]]),
    tx("remboursement-client", -120, [["ca", 1]]),
    tx("achat", -300, [["direct", 1]]),
    tx("avoir-fournisseur", 45, [["direct", 1]]),
    tx("pub-remboursee", 30, [["commercial", 1]]),
    tx("frais-rembourses", 15, [["structure", 1]]),
    tx("tva-recue", 500, [["extra", 1]]),
    tx("non-mappee", 80, [["nouvelle", 1]]),
    tx("non-categorisee", 60, []),
  ];

  test("seules les transactions au signe inhabituel sont listées, avec leur type", () => {
    const anomalies = anomaliesDeSigne(transactions, AXE, mappings);
    assert.deepEqual(
      anomalies.map((a) => [a.transactionId, a.etage, a.montant, a.type]),
      [
        ["remboursement-client", "revenue", -120, "ca_negatif"],
        ["avoir-fournisseur", "gross_margin", 45, "cout_positif"],
        ["pub-remboursee", "contribution_margin", 30, "cout_positif"],
        ["frais-rembourses", "ebitda", 15, "cout_positif"],
      ]
    );
    assert.equal(compterTransactionsAvecAnomalie(anomalies), 4);
  });

  test("tri par montant en valeur absolue décroissante, signe réel conservé", () => {
    const melange = [
      tx("d", -2500, [["ca", 1]]),
      tx("a", 10000, [["direct", 1]]),
      tx("c", 6000, [["structure", 1]]),
      tx("b", -9500, [["ca", 1]]),
      tx("e", -8000, [["ca", 1]]),
    ];
    assert.deepEqual(
      anomaliesDeSigne(melange, AXE, mappings).map((a) => a.montant),
      [10000, -9500, -8000, 6000, -2500]
    );
  });

  test("à valeur absolue égale : date la plus récente d'abord, puis identifiant", () => {
    const egales = [
      tx("z", -100, [["ca", 1]], "2026-03-05"),
      tx("b", 100, [["direct", 1]], "2026-03-20"),
      tx("a", -100, [["ca", 1]], "2026-03-20"),
    ];
    assert.deepEqual(
      anomaliesDeSigne(egales, AXE, mappings).map((a) => a.transactionId),
      ["a", "b", "z"]
    );
  });

  test("signaler ne modifie rien : transactions intactes, reporting sur les montants réels", () => {
    const copie = structuredClone(transactions);
    const avant = calculerPnl(transactions, AXE, mappings);
    anomaliesDeSigne(transactions, AXE, mappings);
    assert.deepEqual(transactions, copie);
    assert.deepEqual(calculerPnl(transactions, AXE, mappings), avant);
    // Le remboursement client reste déduit du CA, l'avoir fournisseur reste en réduction des coûts.
    assert.equal(avant.ca, 880);
    assert.equal(avant.coutsDirects, -255);
  });

  test("le compteur ne porte que sur les transactions fournies (la période affichée)", () => {
    const mars = transactions.filter((t) => t.transactionDate.startsWith("2026-03"));
    const avril = [tx("avril", -10, [["ca", 1]], "2026-04-02")];
    assert.equal(compterTransactionsAvecAnomalie(anomaliesDeSigne(mars, AXE, mappings)), 4);
    assert.equal(compterTransactionsAvecAnomalie(anomaliesDeSigne(avril, AXE, mappings)), 1);
    assert.equal(compterTransactionsAvecAnomalie(anomaliesDeSigne([], AXE, mappings)), 0);
  });

  test("modifier un mapping fait apparaître ou disparaître une anomalie", () => {
    const remappe = indexerMappings([...mappings.values()].map((m) => (m.sourceCategoryId === "direct" ? { ...m, pnlStage: "revenue" as const } : m)));
    const anomalies = anomaliesDeSigne(transactions, AXE, remappe).filter((a) => a.sourceCategoryId === "direct");
    // L'avoir (positif) n'est plus une anomalie en revenue ; l'achat (négatif) en devient une.
    assert.deepEqual(anomalies.map((a) => [a.transactionId, a.type]), [["achat", "ca_negatif"]]);
  });

  test("transaction ventilée : chaque part est contrôlée dans l'étage de sa catégorie", () => {
    const ventilee = tx("mixte", 1000, [
      ["ca", 0.7],
      ["structure", 0.3],
    ]);
    const anomalies = anomaliesDeSigne([ventilee], AXE, mappings);
    assert.deepEqual(anomalies.map((a) => [a.sourceCategoryId, a.montant, a.type]), [["structure", 300, "cout_positif"]]);
    assert.equal(compterTransactionsAvecAnomalie(anomalies), 1);
  });

  test("deux parts anormales d'une même transaction comptent pour une seule transaction", () => {
    const ventilee = tx("double", 200, [
      ["direct", 0.5],
      ["structure", 0.5],
    ]);
    const anomalies = anomaliesDeSigne([ventilee], AXE, mappings);
    assert.equal(anomalies.length, 2);
    assert.equal(compterTransactionsAvecAnomalie(anomalies), 1);
  });
});

describe("validation des signes inhabituels — repartirAnomalies", () => {
  const transactions = [
    tx("remboursement", -9500, [["ca", 1]]),
    tx("avoir", 10000, [["direct", 1]]),
    tx("petit-avoir", 45, [["direct", 1]]),
    tx("vente", 2000, [["ca", 1]]),
  ];
  const validation = (transactionId: string, sourceCategoryId: string, etage: ValidationSigne["etage"], type: ValidationSigne["type"]): ValidationSigne => ({
    transactionId,
    sourceCategoryId,
    etage,
    type,
    validatedAt: "2026-10-09T10:00:00Z",
  });
  const ids = (liste: { transactionId: string }[]) => liste.map((a) => a.transactionId);

  test("sans validation : tout est à vérifier, trié par valeur absolue décroissante", () => {
    const { aVerifier, validees } = repartirAnomalies(anomaliesDeSigne(transactions, AXE, mappings), []);
    assert.deepEqual(aVerifier.map((a) => a.montant), [10000, -9500, 45]);
    assert.deepEqual(validees, []);
  });

  test("une transaction validée quitte la liste à vérifier et rejoint les validées", () => {
    const { aVerifier, validees } = repartirAnomalies(anomaliesDeSigne(transactions, AXE, mappings), [
      validation("avoir", "direct", "gross_margin", "cout_positif"),
    ]);
    assert.deepEqual(ids(aVerifier), ["remboursement", "petit-avoir"]);
    assert.deepEqual(ids(validees), ["avoir"]);
    assert.equal(validees[0].validatedAt, "2026-10-09T10:00:00Z");
    assert.equal(validees[0].montant, 10000);
  });

  test("valider ne change rien au reporting", () => {
    const avant = calculerPnl(transactions, AXE, mappings);
    repartirAnomalies(anomaliesDeSigne(transactions, AXE, mappings), [validation("avoir", "direct", "gross_margin", "cout_positif")]);
    assert.deepEqual(calculerPnl(transactions, AXE, mappings), avant);
  });

  test("catégorie remappée vers un étage où la règle change : l'anomalie revient à vérifier", () => {
    // « ca » était un coût direct quand son montant positif a été validé ; elle est aujourd'hui
    // en revenue, où c'est le remboursement (négatif) qui est inhabituel.
    const { aVerifier, validees } = repartirAnomalies(anomaliesDeSigne(transactions, AXE, mappings), [
      validation("remboursement", "ca", "gross_margin", "cout_positif"),
    ]);
    assert.ok(ids(aVerifier).includes("remboursement"));
    assert.deepEqual(validees, []);
  });

  test("catégorie remappée vers un autre étage de coûts : même règle, mais étage différent -> à revérifier", () => {
    const { aVerifier } = repartirAnomalies(anomaliesDeSigne(transactions, AXE, mappings), [
      validation("avoir", "direct", "ebitda", "cout_positif"),
    ]);
    assert.ok(ids(aVerifier).includes("avoir"));
  });

  test("transaction ventilée : chaque part se valide séparément", () => {
    const ventilee = [tx("mixte", 100, [["direct", 0.5], ["structure", 0.5]])];
    const { aVerifier, validees } = repartirAnomalies(anomaliesDeSigne(ventilee, AXE, mappings), [
      validation("mixte", "direct", "gross_margin", "cout_positif"),
    ]);
    assert.deepEqual(aVerifier.map((a) => a.sourceCategoryId), ["structure"]);
    assert.deepEqual(validees.map((a) => a.sourceCategoryId), ["direct"]);
  });

  test("validation d'une transaction qui n'est plus une anomalie ou plus dans la période : ignorée", () => {
    const { aVerifier, validees } = repartirAnomalies(anomaliesDeSigne(transactions, AXE, mappings), [
      validation("vente", "ca", "revenue", "ca_negatif"),
      validation("disparue", "direct", "gross_margin", "cout_positif"),
    ]);
    assert.equal(aVerifier.length, 3);
    assert.deepEqual(validees, []);
  });
});
