import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AjustementGestion } from "./pastAdjustments";
import {
  compterAMapper,
  decomposerDestination,
  destinationDe,
  destinationsMapping,
  ETAGES_PNL,
  filtrerLignesMapping,
  indexerMappings,
  lignesMapping,
  MappingCategorie,
  NATURES_REVENU,
} from "./pastCategoryMapping";
import { calculerDetail, partsMappees } from "./pastDetail";
import { capacitesDeLOffre, offreMinimale } from "./offres";
import { calculerPnl } from "./pastPnl";
import { partRecurrente, recurrenceDuRevenu } from "./pastRecurrence";
import { PastTransactionStockee } from "./pastTransactions";

const AXE = "229";
const PERIODE = { debut: "2026-01-01", fin: "2026-04-30" };

function mapping(id: string, pnlStage: MappingCategorie["pnlStage"], revenueNature: MappingCategorie["revenueNature"] = null): MappingCategorie {
  return { sourceCategoryId: id, sourceCategoryName: `Catégorie ${id}`, sourceGroupId: AXE, pnlStage, revenueNature };
}

function tx(id: string, amount: number, categorie: string, date: string): PastTransactionStockee {
  return {
    id,
    sourceType: "pennylane",
    transactionDate: date,
    label: `Transaction ${id}`,
    amount,
    currency: "EUR",
    affectations: [{ groupId: AXE, categoryId: categorie, categoryName: `Catégorie ${categorie}`, weight: 1 }],
  };
}

const MAPPINGS = [
  mapping("abonnements", "revenue", "recurring"),
  mapping("projets", "revenue", "one_off"),
  mapping("divers", "revenue", null), // Encaissements, nature à classer
  mapping("achats", "gross_margin"),
  mapping("nouvelle", null),
];
const INDEX = indexerMappings(MAPPINGS);

const TRANSACTIONS = [
  tx("1", 1_000, "abonnements", "2026-01-05"),
  tx("2", 3_000, "projets", "2026-01-20"),
  tx("3", 1_200, "abonnements", "2026-02-05"),
  tx("4", 800, "projets", "2026-02-11"),
  tx("5", 500, "divers", "2026-02-15"),
  tx("6", -400, "achats", "2026-02-16"),
  tx("7", 1_500, "abonnements", "2026-03-05"),
];

const recurrence = (transactions = TRANSACTIONS, index = INDEX, ajustements: AjustementGestion[] = []) =>
  recurrenceDuRevenu(partsMappees(transactions, AXE, index), index, ajustements, PERIODE);

describe("Correspondance P&L — nature du revenu", () => {
  test("offre Pilotage : deux lignes d'Encaissements remplacent la ligne générique, aucune « Non classé »", () => {
    const libelles = destinationsMapping(true).map((d) => d.libelle);
    assert.deepEqual(libelles.slice(0, 2), ["Encaissements : revenu récurrent", "Encaissements : revenu ponctuel"]);
    assert.ok(!libelles.includes("Encaissements"));
    assert.equal(libelles.length, ETAGES_PNL.length + 1);
    assert.ok(libelles.every((l) => !/non class/i.test(l)));
    assert.deepEqual(NATURES_REVENU.map((n) => n.cle), ["recurring", "one_off"]);
  });

  test("autres offres : la liste des étages est inchangée", () => {
    assert.deepEqual(destinationsMapping(false).map((d) => d.libelle), ETAGES_PNL.map((e) => e.libelle));
  });

  test("une catégorie se mappe directement vers revenu récurrent ou revenu ponctuel : étage Encaissements + nature", () => {
    assert.deepEqual(decomposerDestination("revenue:recurring"), { etage: "revenue", nature: "recurring" });
    assert.deepEqual(decomposerDestination("revenue:one_off"), { etage: "revenue", nature: "one_off" });
    assert.deepEqual(decomposerDestination("ebitda"), { etage: "ebitda", nature: null });
    assert.equal(destinationDe(mapping("x", "revenue", "recurring"), true), "revenue:recurring");
    assert.equal(destinationDe(mapping("x", "revenue", "one_off"), true), "revenue:one_off");
    assert.equal(destinationDe(mapping("x", "revenue", "recurring"), false), "revenue");
  });

  test("Encaissements sans nature : à mapper (alerte habituelle) en Pilotage, mappée ailleurs", () => {
    assert.equal(destinationDe(mapping("x", "revenue", null), true), null);
    assert.equal(compterAMapper(MAPPINGS, true), 2); // « nouvelle » + « divers »
    assert.equal(compterAMapper(MAPPINGS, false), 1); // comptage historique inchangé
    assert.deepEqual(filtrerLignesMapping(MAPPINGS, "a_mapper", true).map((m) => m.sourceCategoryId), ["divers", "nouvelle"]);
    assert.deepEqual(filtrerLignesMapping(MAPPINGS, "revenue:recurring", true).map((m) => m.sourceCategoryId), ["abonnements"]);
  });

  test("tri : les catégories à classer d'abord", () => {
    const lignes = lignesMapping(MAPPINGS, AXE, TRANSACTIONS, true).map((l) => l.sourceCategoryId);
    assert.deepEqual(lignes.slice(0, 2), ["divers", "nouvelle"]);
  });
});

describe("Récurrence du revenu — agrégation", () => {
  const r = recurrence();

  test("montants récurrent, ponctuel et à classer ; part = récurrent / classé", () => {
    assert.equal(r.recurrent, 3_700);
    assert.equal(r.ponctuel, 3_800);
    assert.equal(r.aClasser, 500);
    assert.equal(r.part, 3_700 / 7_500);
    assert.equal(r.categoriesAClasser, 1);
  });

  test("Encaissements = récurrent + ponctuel + à classer + ajustements, comme l'écran Encaissements et le P&L", () => {
    const ajustements: AjustementGestion[] = [{ id: "a", date: "2026-02-28", label: "Ajustement", montant: 250, etage: "revenue", type: "manual", notes: null }];
    const avec = recurrence(TRANSACTIONS, INDEX, ajustements);
    const ecran = calculerDetail(partsMappees(TRANSACTIONS, AXE, INDEX), "ca", { categorie: null, mois: null }, PERIODE, ajustements);
    assert.equal(avec.encaissements, avec.recurrent + avec.ponctuel + avec.aClasser + avec.ajustements);
    assert.equal(avec.encaissements, ecran.kpi.montant);
    // Général : la ligne Encaissements (bancaire), ses ajustements sur leurs propres lignes.
    assert.equal(avec.recurrent + avec.ponctuel + avec.aClasser, calculerPnl(TRANSACTIONS, AXE, INDEX, ajustements).ca);
  });

  test("la nature ne change pas les Encaissements : même total avec ou sans nature", () => {
    const sansNature = indexerMappings(MAPPINGS.map((m) => ({ ...m, revenueNature: null })));
    assert.equal(calculerPnl(TRANSACTIONS, AXE, sansNature).ca, calculerPnl(TRANSACTIONS, AXE, INDEX).ca);
  });

  test("à classer : jamais compté comme ponctuel", () => {
    const tout = recurrence(TRANSACTIONS, indexerMappings(MAPPINGS.map((m) => ({ ...m, revenueNature: m.sourceCategoryId === "abonnements" ? "recurring" : null }))));
    assert.equal(tout.ponctuel, 0);
    assert.equal(tout.part, 1);
    assert.equal(tout.aClasser, 4_300);
  });

  test("historique mensuel : une part par mois, null sans encaissement classé (jamais 0 %)", () => {
    assert.deepEqual(
      r.mois.map((m) => [m.mois, m.part]),
      [["2026-01", 0.25], ["2026-02", 0.6], ["2026-03", 1], ["2026-04", null]]
    );
    assert.equal(r.mois[1].aClasser, 500);
  });

  test("changement de période : la répartition suit la période, pas un instantané", () => {
    const fevrier = recurrenceDuRevenu(partsMappees(TRANSACTIONS.filter((t) => t.transactionDate.startsWith("2026-02")), AXE, INDEX), INDEX, [], { debut: "2026-02-01", fin: "2026-02-28" });
    assert.equal(fevrier.part, 0.6);
    assert.equal(fevrier.mois.length, 1);
  });

  test("changement de mapping : l'historique d'une catégorie se relit dans sa nouvelle nature", () => {
    const reclasse = indexerMappings(MAPPINGS.map((m) => (m.sourceCategoryId === "projets" ? { ...m, revenueNature: "recurring" as const } : m)));
    const apres = recurrence(TRANSACTIONS, reclasse);
    assert.equal(apres.recurrent, 7_500);
    assert.equal(apres.mois[0].part, 1);
  });
});

describe("Récurrence du revenu — cas limites", () => {
  test("100 % récurrent", () => {
    assert.equal(recurrence([tx("1", 900, "abonnements", "2026-01-05")]).part, 1);
  });

  test("0 % récurrent", () => {
    assert.equal(recurrence([tx("1", 900, "projets", "2026-01-05")]).part, 0);
  });

  test("une seule catégorie d'encaissement", () => {
    const r = recurrence([tx("1", 900, "abonnements", "2026-01-05"), tx("2", 100, "abonnements", "2026-02-05")]);
    assert.equal(r.categories.length, 1);
    assert.equal(r.recurrent, 1_000);
  });

  test("aucun encaissement sur la période : part indisponible, pas 0 %", () => {
    const r = recurrence([tx("1", -300, "achats", "2026-01-05")]);
    assert.equal(r.part, null);
    assert.equal(r.raison, "aucun_encaissement");
    assert.ok(r.mois.every((m) => m.part === null));
  });

  test("absence d'historique : aucune transaction", () => {
    const r = recurrence([]);
    assert.equal(r.part, null);
    assert.equal(r.raison, "aucun_encaissement");
    assert.equal(r.categories.length, 0);
  });

  test("seulement des catégories à classer : part indisponible, dite comme telle", () => {
    const r = recurrence([tx("1", 500, "divers", "2026-01-05")]);
    assert.equal(r.part, null);
    assert.equal(r.raison, "aucun_classe");
    assert.equal(r.aClasser, 500);
  });

  test("remboursements supérieurs aux encaissements classés : part non calculable plutôt que trompeuse", () => {
    assert.deepEqual(partRecurrente(-200, 100), { part: null, raison: "base_non_positive" });
    assert.deepEqual(partRecurrente(500, -100), { part: null, raison: "base_non_positive" });
  });
});

describe("Récurrence du revenu — offre", () => {
  test("disponible avec Pilotage seulement", () => {
    assert.equal(capacitesDeLOffre("steering").canViewRevenueRecurrence, true);
    assert.equal(capacitesDeLOffre("forecast").canViewRevenueRecurrence, false);
    assert.equal(capacitesDeLOffre("essential").canViewRevenueRecurrence, false);
    assert.equal(offreMinimale("canViewRevenueRecurrence"), "steering");
  });
});
