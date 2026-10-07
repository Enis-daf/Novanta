import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  appliquerAxe,
  categoriePrincipale,
  categoriesDisponibles,
  GROUPE_EXCEL,
  GROUPE_INCONNU,
  libelleAxe,
  resoudreAxeAnalytique,
  transactionsCategorisees,
  compterNonCategorisees,
  decouperPeriodeParMois,
  estNonCategorisee,
  filtrerParCategories,
  PastTransaction,
  periodeAnneeCivile,
  periodeValide,
  trierParDateDecroissante,
} from "./pastTransactions";
import { affectationsPennylane, depuisLignesExcel, depuisTransactionsPennylane } from "./pastTransactionAdapters";

function tx(id: string, date: string, categorie: string | null, amount = -100): PastTransaction {
  return {
    id,
    sourceType: "pennylane",
    transactionDate: date,
    label: `Transaction ${id}`,
    amount,
    currency: "EUR",
    analyticCategoryId: categorie ? `cat-${categorie}` : null,
    analyticCategoryName: categorie,
  };
}

describe("période du module Passé", () => {
  test("la période par défaut est l'année civile en cours, pas 12 mois glissants", () => {
    assert.deepEqual(periodeAnneeCivile("2026-10-07"), { debut: "2026-01-01", fin: "2026-12-31" });
    assert.deepEqual(periodeAnneeCivile("2027-01-01"), { debut: "2027-01-01", fin: "2027-12-31" });
  });

  test("une période inversée ou incomplète est invalide", () => {
    assert.equal(periodeValide({ debut: "2026-01-01", fin: "2026-12-31" }), true);
    assert.equal(periodeValide({ debut: "2026-03-01", fin: "2026-03-01" }), true);
    assert.equal(periodeValide({ debut: "2026-12-31", fin: "2026-01-01" }), false);
    assert.equal(periodeValide({ debut: "", fin: "2026-01-01" }), false);
  });

  test("le découpage mensuel couvre la période sans trou ni recouvrement", () => {
    assert.deepEqual(decouperPeriodeParMois({ debut: "2026-01-15", fin: "2026-03-10" }), [
      { debut: "2026-01-15", fin: "2026-01-31" },
      { debut: "2026-02-01", fin: "2026-02-28" },
      { debut: "2026-03-01", fin: "2026-03-10" },
    ]);
    assert.equal(decouperPeriodeParMois({ debut: "2026-01-01", fin: "2026-12-31" }).length, 12);
    assert.deepEqual(decouperPeriodeParMois({ debut: "2026-05-04", fin: "2026-05-04" }), [
      { debut: "2026-05-04", fin: "2026-05-04" },
    ]);
    assert.deepEqual(decouperPeriodeParMois({ debut: "2026-12-31", fin: "2026-01-01" }), []);
  });
});

describe("catégorisation — définition unique de « non catégorisé »", () => {
  test("nom absent, vide ou fait d'espaces = non catégorisé", () => {
    assert.equal(estNonCategorisee({ analyticCategoryName: null }), true);
    assert.equal(estNonCategorisee({ analyticCategoryName: "" }), true);
    assert.equal(estNonCategorisee({ analyticCategoryName: "   " }), true);
    assert.equal(estNonCategorisee({ analyticCategoryName: "Publicité" }), false);
  });

  const transactions = [
    tx("a", "2026-10-07", "Publicité"),
    tx("b", "2026-10-06", "CA", 4230),
    tx("c", "2026-10-05", "Achats"),
    tx("d", "2026-10-04", null),
    tx("e", "2026-10-03", "  "),
    tx("f", "2026-10-02", "Publicité"),
  ];

  test("les options du filtre sont les catégories présentes, dédoublonnées et triées", () => {
    assert.deepEqual(categoriesDisponibles(transactions), ["Achats", "CA", "Publicité"]);
  });

  test("sélection vide = toutes les catégories", () => {
    assert.equal(filtrerParCategories(transactions, new Set()).length, 6);
  });

  test("plusieurs catégories sélectionnées = transactions de l'une OU l'autre", () => {
    const resultat = filtrerParCategories(transactions, new Set(["Publicité", "CA"]));
    assert.deepEqual(resultat.map((t) => t.id), ["a", "b", "f"]);
  });

  test("les transactions non catégorisées sont exclues du tableau", () => {
    assert.deepEqual(transactionsCategorisees(transactions).map((t) => t.id), ["a", "b", "c", "f"]);
  });

  test("le compteur porte sur toute la période, indépendamment du tableau et du filtre catégorie", () => {
    assert.equal(compterNonCategorisees(transactions), 2);
    const filtrees = filtrerParCategories(transactionsCategorisees(transactions), new Set(["CA"]));
    assert.equal(filtrees.length, 1);
    assert.equal(compterNonCategorisees(filtrees), 0);
    assert.equal(compterNonCategorisees(transactions), 2);
  });

  test("tri par date décroissante, stable à date égale", () => {
    const melange = [tx("b", "2026-01-02", null), tx("z", "2026-03-01", null), tx("a", "2026-01-02", null)];
    assert.deepEqual(trierParDateDecroissante(melange).map((t) => t.id), ["z", "a", "b"]);
  });
});

describe("adaptateur Pennylane -> transactions internes", () => {
  test("reprend l'identifiant source, la date, le libellé, le montant signé et TOUTES les affectations", () => {
    const [t] = depuisTransactionsPennylane([
      {
        id: 42,
        date: "2026-10-07",
        label: " META ADS ",
        amount: "-850.00",
        categories: [
          { id: 421, label: "Publicité", weight: "1.0", category_group: { id: 229 } },
          { id: 77, label: "Projet Alpha", weight: "0.4", category_group: { id: 300 } },
          { id: 78, label: "Projet Beta", weight: "0.6", category_group: { id: 300 } },
        ],
        created_at: "2026-10-07T10:00:00Z",
        updated_at: "2026-10-08T10:00:00Z",
      },
    ]);
    assert.deepEqual(t, {
      sourceType: "pennylane",
      sourceTransactionId: "42",
      importBatchId: null,
      sourceRowIndex: null,
      transactionDate: "2026-10-07",
      label: "META ADS",
      amount: -850,
      currency: "EUR",
      affectations: [
        { groupId: "229", categoryId: "421", categoryName: "Publicité", weight: 1 },
        { groupId: "300", categoryId: "77", categoryName: "Projet Alpha", weight: 0.4 },
        { groupId: "300", categoryId: "78", categoryName: "Projet Beta", weight: 0.6 },
      ],
      sourceCreatedAt: "2026-10-07T10:00:00Z",
      sourceUpdatedAt: "2026-10-08T10:00:00Z",
    });
  });

  test("sans catégorie exploitable : aucune affectation", () => {
    const sans = depuisTransactionsPennylane([
      { id: 1, date: "2026-01-01", label: "A", amount: "10" },
      { id: 2, date: "2026-01-01", label: "B", amount: "10", categories: [] },
      { id: 3, date: "2026-01-01", label: "C", amount: "10", categories: [{ id: 9, label: "  " }] },
    ]);
    assert.equal(sans.length, 3);
    assert.ok(sans.every((t) => t.affectations.length === 0));
  });

  test("une catégorie sans groupe est rangée dans un axe à part, poids 1 par défaut", () => {
    assert.deepEqual(affectationsPennylane([{ id: 5, label: "Divers" }]), [
      { groupId: GROUPE_INCONNU, categoryId: "5", categoryName: "Divers", weight: 1 },
    ]);
  });

  test("écarte les transactions archivées ou inexploitables", () => {
    const resultat = depuisTransactionsPennylane([
      { id: 1, date: "2026-01-01", label: "Archivée", amount: "10", archived_at: "2026-02-01T00:00:00Z" },
      { id: 2, date: "", label: "Sans date", amount: "10" },
      { id: 3, date: "2026-01-01", label: "Montant illisible", amount: "abc" },
      { id: 4, date: "2026-01-01", label: null, amount: "10" },
    ]);
    assert.deepEqual(resultat.map((t) => t.sourceTransactionId), ["4"]);
    assert.equal(resultat[0].label, "");
  });
});

describe("axe analytique — la catégorie affichée est dérivée, jamais choisie en silence", () => {
  const axeType = { groupId: "229", name: "Types de dépenses / revenus" };
  const axeProjet = { groupId: "300", name: "Projets" };

  test("axe configuré : il fait foi", () => {
    assert.deepEqual(resoudreAxeAnalytique([axeType, axeProjet], "300"), { etat: "configure", axeId: "300" });
  });

  test("un seul axe, rien de configuré : utilisé automatiquement", () => {
    assert.deepEqual(resoudreAxeAnalytique([axeType], null), { etat: "automatique", axeId: "229" });
  });

  test("plusieurs axes, rien de configuré : aucun axe choisi", () => {
    assert.deepEqual(resoudreAxeAnalytique([axeType, axeProjet], null), { etat: "a_configurer", axeId: null });
  });

  test("un axe configuré qui n'existe plus n'est pas suivi aveuglément", () => {
    assert.deepEqual(resoudreAxeAnalytique([axeType, axeProjet], "999"), { etat: "a_configurer", axeId: null });
    assert.deepEqual(resoudreAxeAnalytique([axeType], "999"), { etat: "automatique", axeId: "229" });
  });

  test("aucun axe connu", () => {
    assert.deepEqual(resoudreAxeAnalytique([], null), { etat: "aucun", axeId: null });
  });

  const affectations = [
    { groupId: "229", categoryId: "421", categoryName: "Publicité", weight: 1 },
    { groupId: "300", categoryId: "77", categoryName: "Projet Alpha", weight: 0.4 },
    { groupId: "300", categoryId: "78", categoryName: "Projet Beta", weight: 0.6 },
  ];

  test("la catégorie principale est la plus pondérée DE L'AXE retenu", () => {
    assert.equal(categoriePrincipale(affectations, "229")?.categoryName, "Publicité");
    assert.equal(categoriePrincipale(affectations, "300")?.categoryName, "Projet Beta");
    assert.equal(categoriePrincipale([...affectations].reverse(), "300")?.categoryName, "Projet Beta");
  });

  test("sans axe retenu, ou sans affectation dans l'axe : pas de catégorie", () => {
    assert.equal(categoriePrincipale(affectations, null), null);
    assert.equal(categoriePrincipale(affectations, "555"), null);
  });

  test("appliquerAxe ne modifie pas les affectations stockées et suit le changement d'axe", () => {
    const stockee = {
      id: "t1",
      sourceType: "pennylane" as const,
      transactionDate: "2026-10-07",
      label: "META ADS",
      amount: -850,
      currency: "EUR",
      affectations,
    };
    const copie = structuredClone(stockee);
    assert.equal(appliquerAxe([stockee], "229")[0].analyticCategoryName, "Publicité");
    assert.equal(appliquerAxe([stockee], "300")[0].analyticCategoryName, "Projet Beta");
    const sansAxe = appliquerAxe([stockee], null)[0];
    assert.equal(sansAxe.analyticCategoryName, null);
    assert.equal(estNonCategorisee(sansAxe), true);
    assert.deepEqual(stockee, copie);
  });

  test("un axe sans nom est présenté avec des exemples de ses catégories", () => {
    const stockee = { id: "t1", sourceType: "pennylane" as const, transactionDate: "2026-10-07", label: "", amount: 1, currency: null, affectations };
    assert.equal(libelleAxe(axeType, [stockee]), "Types de dépenses / revenus");
    assert.equal(libelleAxe({ groupId: "300", name: null }, [stockee]), "Axe 300 (ex. Projet Alpha, Projet Beta)");
  });
});

describe("adaptateur Excel -> transactions internes (même modèle que Pennylane)", () => {
  test("identité = position dans le lot : deux lignes identiques restent deux transactions", () => {
    const ligne = { date: "2026-03-01", libelle: "Loyer", montant: -1200, categorieAnalytique: "Loyer " };
    const resultat = depuisLignesExcel([ligne, ligne, { date: "2026-03-02", libelle: "Divers", montant: -5 }], "lot-1");
    assert.deepEqual(
      resultat.map((t) => [t.sourceType, t.importBatchId, t.sourceRowIndex, t.sourceTransactionId]),
      [
        ["excel", "lot-1", 0, null],
        ["excel", "lot-1", 1, null],
        ["excel", "lot-1", 2, null],
      ]
    );
    assert.deepEqual(resultat[0].affectations, [
      { groupId: GROUPE_EXCEL, categoryId: null, categoryName: "Loyer", weight: 1 },
    ]);
    assert.deepEqual(resultat[2].affectations, []);
  });

  test("produit exactement les mêmes champs qu'une transaction Pennylane", () => {
    const [excel] = depuisLignesExcel([{ date: "2026-03-01", libelle: "X", montant: 1 }], "lot-1");
    const [pennylane] = depuisTransactionsPennylane([{ id: 1, date: "2026-03-01", label: "X", amount: "1" }]);
    assert.deepEqual(Object.keys(excel).sort(), Object.keys(pennylane).sort());
  });
});
