import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  categoriesDesTransactions,
  compterAMapper,
  estEtagePnl,
  ETAGES_PNL,
  filtrerLignesMapping,
  identiteCategorie,
  indexerMappings,
  lignesMapping,
  MappingCategorie,
  resoudreEtagePnl,
  ventilerTransaction,
} from "./pastCategoryMapping";
import { depuisLignesExcel, depuisTransactionsPennylane } from "./pastTransactionAdapters";
import { appliquerAxe, PastTransaction, PastTransactionStockee } from "./pastTransactions";

function mapping(id: string, nom: string, pnlStage: MappingCategorie["pnlStage"], groupe = "229"): MappingCategorie {
  return { sourceCategoryId: id, sourceCategoryName: nom, sourceGroupId: groupe, pnlStage };
}

function tx(id: string, categorieId: string | null, categorie: string | null, amount: number): PastTransaction {
  return {
    id,
    sourceType: "pennylane",
    transactionDate: "2026-03-01",
    label: "",
    amount,
    currency: "EUR",
    analyticCategoryId: categorieId,
    analyticCategoryName: categorie,
  };
}

describe("étages P&L", () => {
  test("exactement 5 étages fixes, aux clés stables", () => {
    assert.deepEqual(
      ETAGES_PNL.map((e) => [e.cle, e.libelle]),
      [
        ["revenue", "CA"],
        ["gross_margin", "Coûts directs"],
        ["contribution_margin", "Autres coûts variables"],
        ["ebitda", "Coûts de structure"],
        ["extra_pnl", "Extra P&L"],
      ]
    );
    assert.equal(estEtagePnl("ebitda"), true);
    assert.equal(estEtagePnl("autre"), false);
    assert.equal(estEtagePnl(null), false);
  });
});

describe("catégories connues à l'issue d'une synchronisation", () => {
  test("une ligne par catégorie source, identifiée par son identifiant stable, tous axes confondus", () => {
    const normalisees = depuisTransactionsPennylane([
      { id: 1, date: "2026-01-01", label: "A", amount: "-10", categories: [{ id: 421, label: "Meta Ads", category_group: { id: 229 } }] },
      {
        id: 2,
        date: "2026-01-02",
        label: "B",
        amount: "-20",
        categories: [
          { id: 421, label: "Meta Ads", category_group: { id: 229 } },
          { id: 77, label: "Projet Alpha", category_group: { id: 300 } },
        ],
      },
      { id: 3, date: "2026-01-03", label: "C", amount: "5" },
    ]);
    assert.deepEqual(categoriesDesTransactions(normalisees), [
      { sourceCategoryId: "421", sourceCategoryName: "Meta Ads", sourceGroupId: "229" },
      { sourceCategoryId: "77", sourceCategoryName: "Projet Alpha", sourceGroupId: "300" },
    ]);
  });

  test("une transaction non catégorisée ne crée aucune fausse catégorie", () => {
    const normalisees = depuisTransactionsPennylane([{ id: 3, date: "2026-01-03", label: "C", amount: "5" }]);
    assert.deepEqual(categoriesDesTransactions(normalisees), []);
  });

  test("sans identifiant source (Excel), l'identité retombe sur le nom, insensible à la casse", () => {
    assert.equal(identiteCategorie("421", "Meta Ads"), "421");
    assert.equal(identiteCategorie(null, "Loyer"), identiteCategorie(null, "LOYER"));
    const [categorie] = categoriesDesTransactions(
      depuisLignesExcel([{ date: "2026-01-01", libelle: "x", montant: -1, categorieAnalytique: "Loyer" }], "lot")
    );
    assert.equal(categorie.sourceCategoryId, "nom:loyer");
  });
});

describe("résolution transaction -> catégorie -> mapping courant -> étage", () => {
  const meta = tx("t1", "421", "Meta Ads", -850);

  test("non catégorisée, non mappée et mappée sont trois statuts distincts", () => {
    const mappings = indexerMappings([mapping("421", "Meta Ads", "contribution_margin"), mapping("9", "Nouvelle", null)]);
    assert.deepEqual(resoudreEtagePnl(tx("t0", null, null, -5), mappings), { statut: "non_categorisee" });
    assert.deepEqual(resoudreEtagePnl(tx("t2", "9", "Nouvelle", -5), mappings), { statut: "non_mappee", sourceCategoryId: "9" });
    assert.deepEqual(resoudreEtagePnl(meta, mappings), {
      statut: "mappee",
      sourceCategoryId: "421",
      etage: "contribution_margin",
    });
  });

  test("une catégorie inconnue de la table n'est jamais affectée arbitrairement", () => {
    assert.deepEqual(resoudreEtagePnl(meta, new Map()), { statut: "non_mappee", sourceCategoryId: "421" });
  });

  test("modifier une ligne de mapping reclasse l'historique sans toucher aux transactions", () => {
    const historique = [meta, tx("t3", "421", "Meta Ads", -120), tx("t4", "421", "Meta Ads", -60)];
    const copie = structuredClone(historique);
    const avant = indexerMappings([mapping("421", "Meta Ads", "ebitda")]);
    const apres = indexerMappings([mapping("421", "Meta Ads", "contribution_margin")]);
    const etages = (m: Map<string, MappingCategorie>) =>
      historique.map((t) => {
        const classement = resoudreEtagePnl(t, m);
        return classement.statut === "mappee" ? classement.etage : null;
      });
    assert.deepEqual(etages(avant), ["ebitda", "ebitda", "ebitda"]);
    assert.deepEqual(etages(apres), ["contribution_margin", "contribution_margin", "contribution_margin"]);
    assert.deepEqual(historique, copie);
  });
});

function stockee(id: string, amount: number, parts: [string, string, number, string?][]): PastTransactionStockee {
  return {
    id,
    sourceType: "pennylane",
    transactionDate: "2026-03-01",
    label: "",
    amount,
    currency: "EUR",
    affectations: parts.map(([categoryId, categoryName, weight, groupId]) => ({
      groupId: groupId ?? "229",
      categoryId,
      categoryName,
      weight,
    })),
  };
}

describe("transactions ventilées — le montant suit les pondérations, pas la catégorie principale", () => {
  const ventilee = stockee("v", -1000, [
    ["1", "Marketing", 0.7],
    ["2", "Logistique", 0.3],
    ["77", "Projet Alpha", 1, "300"],
  ]);

  test("-1 000 € à 70 % / 30 % donne -700 € et -300 € dans l'axe retenu", () => {
    assert.deepEqual(
      ventilerTransaction(ventilee, "229").map((p) => [p.sourceCategoryName, p.montant]),
      [
        ["Marketing", -700],
        ["Logistique", -300],
      ]
    );
  });

  test("un autre axe a sa propre répartition ; sans axe retenu, rien n'est réparti", () => {
    assert.deepEqual(ventilerTransaction(ventilee, "300").map((p) => [p.sourceCategoryName, p.montant]), [["Projet Alpha", -1000]]);
    assert.deepEqual(ventilerTransaction(ventilee, null), []);
  });

  test("la catégorie affichée reste la principale, sans effet sur la répartition", () => {
    assert.equal(appliquerAxe([ventilee], "229")[0].analyticCategoryName, "Marketing");
    assert.equal(ventilee.affectations.length, 3);
  });

  test("le tableau de correspondance répartit le montant entre les catégories", () => {
    const lignes = lignesMapping([mapping("1", "Marketing", "contribution_margin"), mapping("2", "Logistique", null)], "229", [
      ventilee,
      stockee("w", -100, [["1", "Marketing", 1]]),
    ]);
    assert.deepEqual(
      lignes.map((l) => [l.sourceCategoryName, l.nombreTransactions, l.montantTotal]),
      [
        ["Logistique", 1, -300],
        ["Marketing", 2, -800],
      ]
    );
  });
});

describe("tableau de correspondance", () => {
  const mappings = [
    mapping("421", "Meta Ads", "contribution_margin"),
    mapping("500", "Stripe", "revenue"),
    mapping("600", "Nouvelle catégorie", null),
    mapping("700", "Ancienne catégorie", "ebitda"),
    mapping("77", "Projet Alpha", null, "300"),
  ];
  const periode = [
    stockee("a", -850, [["421", "Meta Ads", 1]]),
    stockee("b", -150, [["421", "Meta Ads", 1]]),
    stockee("c", 4230, [["500", "Stripe", 1]]),
    stockee("d", -820, [["600", "Nouvelle catégorie", 1]]),
    stockee("e", -400, []),
    stockee("f", -90, [["77", "Projet Alpha", 1, "300"]]),
  ];

  test("toutes les catégories connues de l'axe, même sans transaction sur la période", () => {
    const lignes = lignesMapping(mappings, "229", periode);
    assert.deepEqual(
      lignes.map((l) => [l.sourceCategoryName, l.nombreTransactions, l.montantTotal, l.pnlStage]),
      [
        ["Nouvelle catégorie", 1, -820, null],
        ["Ancienne catégorie", 0, 0, "ebitda"],
        ["Meta Ads", 2, -1000, "contribution_margin"],
        ["Stripe", 1, 4230, "revenue"],
      ]
    );
  });

  test("les catégories d'un autre axe ne polluent pas la table ; sans axe retenu, rien n'est listé", () => {
    assert.deepEqual(
      lignesMapping(mappings, "300", periode).map((l) => [l.sourceCategoryName, l.montantTotal]),
      [["Projet Alpha", -90]]
    );
    assert.deepEqual(lignesMapping(mappings, null, periode), []);
  });

  test("le compteur « à mapper » ne dépend pas de la période", () => {
    assert.equal(compterAMapper(lignesMapping(mappings, "229", periode)), 1);
    assert.equal(compterAMapper(lignesMapping(mappings, "229", [])), 1);
  });

  test("filtres : toutes, mappées, à mapper, par étage", () => {
    const lignes = lignesMapping(mappings, "229", periode);
    assert.equal(filtrerLignesMapping(lignes, "toutes").length, 4);
    assert.deepEqual(filtrerLignesMapping(lignes, "a_mapper").map((l) => l.sourceCategoryName), ["Nouvelle catégorie"]);
    assert.equal(filtrerLignesMapping(lignes, "mappees").length, 3);
    assert.deepEqual(filtrerLignesMapping(lignes, "revenue").map((l) => l.sourceCategoryName), ["Stripe"]);
  });
});
