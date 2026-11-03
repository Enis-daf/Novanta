import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FactureBfr } from "./pastBfr";
import {
  avecCategoriesDesTransactions,
  categoriesProposees,
  categoriesRecuperees,
  filtresInitiaux,
  libelleCategorie,
  libelleTrimestre,
  periodeDuType,
  periodesProposees,
  premiereEmission,
  resoudrePeriode,
  transactionsRapprochees,
} from "./pastBfrAnalyseDelais";
import { delaisDeLaCohorte } from "./pastBfrDelais";

const CIVIL = { mois: 1, jour: 1 };
const AVRIL = { mois: 4, jour: 1 }; // exercice du 1er avril au 31 mars

let n = 0;
function facture(champs: Partial<FactureBfr> = {}): FactureBfr {
  n++;
  return {
    pennylaneId: `f${n}`,
    type: "fournisseur",
    numero: `F-${n}`,
    tiers: "Fournisseur",
    dateEmission: "2026-09-25",
    echeance: null,
    devise: "EUR",
    montantTtc: 1_200,
    montantHt: 1_000,
    resteTtc: 0,
    resteHt: 0,
    exclusion: null,
    factureAvoireeId: null,
    reglements: [{ date: "2026-11-20", montant: 1_200 }],
    categories: [],
    ...champs,
  };
}

describe("ouverture de l'analyse", () => {
  test("depuis septembre : période septembre, toutes catégories, tous montants", () => {
    assert.deepEqual(filtresInitiaux("2026-09"), { periode: { type: "mois", mois: "2026-09" }, categorie: { type: "toutes" }, seuilHt: null });
  });
});

describe("périodes de l'analyse", () => {
  test("mois civil", () => {
    assert.deepEqual(resoudrePeriode({ type: "mois", mois: "2026-09" }, CIVIL), { ok: true, periode: { debut: "2026-09-01", fin: "2026-09-30" }, libelle: "Septembre 2026" });
  });

  test("trimestre et exercice de l'exercice fiscal configuré", () => {
    const t = resoudrePeriode({ type: "trimestre", debut: "2026-07-01" }, AVRIL);
    assert.ok(t.ok && t.periode.debut === "2026-07-01" && t.periode.fin === "2026-09-30" && t.libelle === "T2 2026/2027");
    const civil = resoudrePeriode({ type: "trimestre", debut: "2026-07-01" }, CIVIL);
    assert.ok(civil.ok && civil.libelle === "T3 2026");
    const e = resoudrePeriode({ type: "exercice", debut: "2026-04-01" }, AVRIL);
    assert.ok(e.ok && e.periode.debut === "2026-04-01" && e.periode.fin === "2027-03-31" && e.libelle === "Exercice 2026/2027");
    assert.equal(libelleTrimestre({ debut: "2027-01-01", fin: "2027-03-31" }, AVRIL), "T4 2026/2027");
  });

  test("personnalisée : bornes incluses ; dates invalides, ordre inversé et plus de 5 ans refusés, jamais corrigés", () => {
    const ok = resoudrePeriode({ type: "personnalise", debut: "2026-09-25", fin: "2026-09-25" }, CIVIL);
    assert.ok(ok.ok && ok.libelle === "Du 25/09/2026 au 25/09/2026");
    assert.equal(resoudrePeriode({ type: "personnalise", debut: "2026-02-31", fin: "2026-03-10" }, CIVIL).ok, false);
    assert.equal(resoudrePeriode({ type: "personnalise", debut: "", fin: "2026-03-10" }, CIVIL).ok, false);
    assert.equal(resoudrePeriode({ type: "personnalise", debut: "2026-10-01", fin: "2026-09-01" }, CIVIL).ok, false);
    assert.equal(resoudrePeriode({ type: "personnalise", debut: "2020-01-01", fin: "2025-01-01" }, CIVIL).ok, false);
    assert.equal(resoudrePeriode({ type: "personnalise", debut: "2020-01-02", fin: "2024-12-31" }, CIVIL).ok, true);
  });

  test("changer de type garde le début de la période en cours", () => {
    const sept = { debut: "2026-09-01", fin: "2026-09-30" };
    assert.deepEqual(periodeDuType("trimestre", sept, CIVIL), { type: "trimestre", debut: "2026-07-01" });
    assert.deepEqual(periodeDuType("exercice", sept, AVRIL), { type: "exercice", debut: "2026-04-01" });
    assert.deepEqual(periodeDuType("personnalise", sept, CIVIL), { type: "personnalise", debut: "2026-09-01", fin: "2026-09-30" });
    assert.deepEqual(periodeDuType("mois", { debut: "2026-07-01", fin: "2026-09-30" }, CIVIL), { type: "mois", mois: "2026-07" });
  });

  test("périodes proposées : de la plus récente à celle de la première facture", () => {
    const t = periodesProposees("trimestre", "2026-02-10", "2026-11-03", CIVIL).map((c) => c.valeur);
    assert.deepEqual(t, ["2026-10-01", "2026-07-01", "2026-04-01", "2026-01-01"]);
    assert.deepEqual(periodesProposees("exercice", "2025-05-01", "2026-11-03", AVRIL).map((c) => c.valeur), ["2026-04-01", "2025-04-01"]);
    assert.equal(periodesProposees("mois", "2026-09-15", "2026-11-03", CIVIL).length, 3);
  });

  test("cohorte par date d'émission : émise le 25/09, payée le 20/11 -> septembre, délai complet", () => {
    const factures = [facture()];
    const sept = resoudrePeriode({ type: "mois", mois: "2026-09" }, CIVIL);
    const nov = resoudrePeriode({ type: "mois", mois: "2026-11" }, CIVIL);
    assert.ok(sept.ok && nov.ok);
    const c = delaisDeLaCohorte(factures, "fournisseur", sept.periode, "2026-11-30");
    assert.equal(c.reglees.length, 1);
    assert.equal(c.delaiMoyen, 56);
    assert.equal(delaisDeLaCohorte(factures, "fournisseur", nov.periode, "2026-11-30").reglees.length, 0);
  });

  test("combinaison exercice + catégorie + montant", () => {
    const st = { id: "st", label: "Sous-traitance", groupId: "g1", weight: 1 };
    const factures = [
      facture({ dateEmission: "2026-05-02", montantHt: 8_000, montantTtc: 9_600, categories: [st], reglements: [{ date: "2026-06-01", montant: 9_600 }] }),
      facture({ dateEmission: "2027-02-10", montantHt: 6_000, montantTtc: 7_200, categories: [st], reglements: [{ date: "2027-04-11", montant: 7_200 }] }),
      facture({ dateEmission: "2026-05-02", montantHt: 3_000, montantTtc: 3_600, categories: [st] }),
      facture({ dateEmission: "2026-05-02", montantHt: 50_000, montantTtc: 60_000, categories: [] }),
      facture({ dateEmission: "2027-04-02", montantHt: 9_000, montantTtc: 10_800, categories: [st] }), // exercice suivant
    ];
    const e = resoudrePeriode({ type: "exercice", debut: "2026-04-01" }, AVRIL);
    assert.ok(e.ok);
    const c = delaisDeLaCohorte(factures, "fournisseur", e.periode, "2027-05-01", { categorie: { type: "categorie", id: "st" }, seuilHt: 5_000 });
    assert.deepEqual(c.reglees.map((f) => f.montantHt).sort(), [6_000, 8_000]);
    assert.ok(Math.abs((c.delaiMoyen as number) - (8_000 * 30 + 6_000 * 60) / 14_000) < 1e-9);
    assert.ok(Math.abs((c.filtre.couverture as number) - 14_000 / 17_000) < 1e-9);
  });
});

describe("catégories proposées", () => {
  test("par axe, chaque catégorie une fois, du seul côté analysé", () => {
    const a = { id: "1", label: "Projet A", groupId: "g1", weight: 0.5 };
    const b = { id: "2", label: "Maintenance", groupId: "g1", weight: 0.5 };
    const c = { id: "3", label: "Paris", groupId: "g2", weight: 1 };
    const factures = [facture({ categories: [a, b] }), facture({ categories: [a] }), facture({ categories: [c] }), facture({ type: "client", categories: [{ id: "9", label: "Client", groupId: "g1", weight: 1 }] })];
    const groupes = categoriesProposees(factures, "fournisseur", [{ groupId: "g1", name: "Activité" }]);
    assert.deepEqual(groupes.map((g) => [g.nom, g.categories.map((x) => x.label)]), [
      ["Activité", ["Maintenance", "Projet A"]],
      ["Axe analytique", ["Paris"]],
    ]);
    assert.equal(libelleCategorie({ type: "categorie", id: "3" }, groupes), "Paris");
    assert.equal(libelleCategorie({ type: "non_categorise" }, groupes), "Non catégorisé");
  });

  test("catégories récupérées et première émission", () => {
    assert.equal(categoriesRecuperees([facture({ categories: null })], "fournisseur"), false);
    assert.equal(categoriesRecuperees([facture({ categories: [] })], "fournisseur"), true);
    assert.equal(premiereEmission([facture({ dateEmission: "2026-03-01" }), facture({ dateEmission: "2025-12-01" })], "fournisseur"), "2025-12-01");
  });
});

describe("catégories déduites des transactions rapprochées", () => {
  const A = { id: "a", label: "Projet A", groupId: "g", weight: 0.6 };
  const M = { id: "m", label: "Maintenance", groupId: "g", weight: 0.4 };
  const parTransaction = new Map([
    ["t1", [A, M]], // transaction ventilée sur deux catégories
    ["t2", [A]],
    ["t3", []], // transaction connue, non catégorisée
  ]);
  const reglee = (...ids: (string | null)[]) => facture({ categories: undefined, reglements: ids.map((id) => ({ date: "2026-10-20", montant: 600, transactionId: id })) });

  test("union des catégories des transactions, chaque catégorie une fois", () => {
    const [f] = avecCategoriesDesTransactions([reglee("t1", "t2")], parTransaction);
    assert.deepEqual(f.categories!.map((c) => c.id), ["a", "m"]);
  });

  test("transactions connues sans catégorie : non catégorisée ([])", () => {
    assert.deepEqual(avecCategoriesDesTransactions([reglee("t3")], parTransaction)[0].categories, []);
  });

  test("inconnues (null) : facture ouverte, règlement sans identifiant, transaction absente de Passé", () => {
    const ouverte = facture({ categories: undefined, reglements: null, resteTtc: 1_200 });
    const ancienne = facture({ categories: undefined, reglements: [{ date: "2026-10-20", montant: 1_200 }] });
    const resultat = avecCategoriesDesTransactions([ouverte, ancienne, reglee("t9")], parTransaction);
    assert.deepEqual(resultat.map((f) => f.categories), [null, null, null]);
  });

  test("une transaction inconnue à côté d'une connue : catégories de la connue", () => {
    assert.deepEqual(avecCategoriesDesTransactions([reglee("t9", "t2")], parTransaction)[0].categories!.map((c) => c.id), ["a"]);
  });

  test("facture sur une transaction multi-catégories : comptée une fois, délai et montant entiers, sans ventilation", () => {
    const f = facture({ montantHt: 100_000, montantTtc: 120_000, dateEmission: "2026-09-01", categories: undefined, reglements: [{ date: "2026-10-22", montant: 120_000, transactionId: "t1" }] });
    const factures = avecCategoriesDesTransactions([f], parTransaction);
    const sept = { debut: "2026-09-01", fin: "2026-09-30" };
    for (const id of ["a", "m"]) {
      const c = delaisDeLaCohorte(factures, "fournisseur", sept, "2026-11-30", { categorie: { type: "categorie", id } });
      assert.equal(c.reglees.length, 1);
      assert.equal(c.reglees[0].montantHt, 100_000); // jamais 60 % ou 40 %
      assert.equal(c.delaiMoyen, 51);
    }
  });

  test("identifiants des transactions rapprochées, chacun une fois", () => {
    assert.deepEqual(transactionsRapprochees([reglee("t1", "t2"), reglee("t2", null)]).sort(), ["t1", "t2"]);
  });
});
