import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { calculerDetail, FiltresDetail, libelleMois, libelleMoisCourt, moisDeLaPeriode, partsMappees } from "./pastDetail";
import { calculerPnl, CLE_AUTRES } from "./pastPnl";
import { PastTransactionStockee } from "./pastTransactions";

const AXE = "229";
const PERIODE = { debut: "2026-07-01", fin: "2026-09-30" };
const SANS_FILTRE: FiltresDetail = { categorie: null, mois: null };

function mapping(id: string, nom: string, pnlStage: MappingCategorie["pnlStage"]): MappingCategorie {
  return { sourceCategoryId: id, sourceCategoryName: nom, sourceGroupId: AXE, pnlStage };
}

function tx(id: string, date: string, amount: number, parts: [string, number][]): PastTransactionStockee {
  return {
    id,
    sourceType: "pennylane",
    transactionDate: date,
    label: `Transaction ${id}`,
    amount,
    currency: "EUR",
    affectations: parts.map(([categoryId, weight]) => ({ groupId: AXE, categoryId, categoryName: categoryId, weight })),
  };
}

const mappings = indexerMappings([
  mapping("stripe", "Stripe", "revenue"),
  mapping("matieres", "Achats matières", "gross_margin"),
  mapping("pub", "Publicité & marketing", "contribution_margin"),
  mapping("logistique", "Logistique", "contribution_margin"),
  mapping("loyer", "Loyer", "ebitda"),
  mapping("tva", "TVA", "extra_pnl"),
  mapping("emprunt", "Emprunt reçu", "extra_pnl"),
  mapping("nouvelle", "Nouvelle catégorie", null),
]);

const transactions = [
  tx("v-juil", "2026-07-10", 10_000, [["stripe", 1]]),
  tx("v-aout", "2026-08-10", 12_000, [["stripe", 1]]),
  tx("v-sept", "2026-09-10", 20_000, [["stripe", 1]]),
  tx("m-sept", "2026-09-12", -6_000, [["matieres", 1]]),
  tx("pub-aout", "2026-08-15", -1_000, [["pub", 1]]),
  tx("pub-sept-1", "2026-09-05", -2_500, [["pub", 1]]),
  tx("pub-sept-2", "2026-09-20", -1_500, [["pub", 1]]),
  tx("log-sept", "2026-09-18", -800, [["logistique", 1]]),
  tx("mixte-sept", "2026-09-25", -1_000, [["pub", 0.7], ["logistique", 0.3]]),
  tx("loyer-sept", "2026-09-01", -3_000, [["loyer", 1]]),
  tx("tva-sept", "2026-09-28", -2_000, [["tva", 1]]),
  tx("emprunt-aout", "2026-08-02", 500, [["emprunt", 1]]),
  tx("non-mappee", "2026-09-03", -999, [["nouvelle", 1]]),
  tx("non-categorisee", "2026-09-04", -777, []),
];
const parts = partsMappees(transactions, AXE, mappings);
const detail = (metrique: Parameters<typeof calculerDetail>[1], filtres = SANS_FILTRE) =>
  calculerDetail(parts, metrique, filtres, PERIODE);

describe("parts mappées — matière première commune des écrans de détail", () => {
  test("ni transaction non catégorisée, ni catégorie non mappée", () => {
    assert.ok(!parts.some((p) => p.transactionId === "non-categorisee" || p.transactionId === "non-mappee"));
  });

  test("une transaction ventilée donne une part par catégorie, montant source conservé", () => {
    assert.deepEqual(
      parts.filter((p) => p.transactionId === "mixte-sept").map((p) => [p.sourceCategoryId, p.montant, p.montantSource, p.weight]),
      [
        ["pub", -700, -1000, 0.7],
        ["logistique", -300, -1000, 0.3],
      ]
    );
  });
});

describe("mois de la période", () => {
  test("tous les mois couverts, même sans transaction, à cheval sur deux années", () => {
    assert.deepEqual(moisDeLaPeriode({ debut: "2025-11-15", fin: "2026-02-03" }), ["2025-11", "2025-12", "2026-01", "2026-02"]);
    assert.deepEqual(moisDeLaPeriode({ debut: "2026-09-30", fin: "2026-09-30" }), ["2026-09"]);
    assert.deepEqual(moisDeLaPeriode({ debut: "2026-12-01", fin: "2026-01-01" }), []);
  });

  test("libellés", () => {
    assert.equal(libelleMois("2026-09"), "Septembre 2026");
    assert.equal(libelleMoisCourt("2026-09", false), "sept.");
    assert.equal(libelleMoisCourt("2026-09", true), "sept. 26");
  });
});

describe("écran de détail sans filtre local — cohérent avec le P&L de l'onglet Général", () => {
  const pnl = calculerPnl(transactions, AXE, mappings);

  test("le KPI de chaque écran est le solde correspondant du P&L", () => {
    assert.equal(detail("ca").kpi.montant, pnl.ca);
    assert.equal(detail("marge_brute").kpi.montant, pnl.margeBrute);
    assert.equal(detail("marge_contributive").kpi.montant, pnl.margeContributive);
    assert.equal(detail("ebitda").kpi.montant, pnl.ebitda);
    assert.equal(detail("cash_flow").kpi.montant, pnl.cashFlow);
  });

  test("ratio sur le CA pour les marges et l'EBITDA, pas pour le CA ni le Cash flow", () => {
    assert.equal(detail("ca").kpi.ratio, undefined);
    assert.equal(detail("cash_flow").kpi.ratio, undefined);
    assert.equal(detail("marge_contributive").kpi.ratio, pnl.ratios.margeContributive);
    assert.equal(detail("ebitda").kpi.ratio, pnl.ratios.ebitda);
  });

  test("le camembert détaille l'étage de l'écran, par catégorie", () => {
    assert.deepEqual(detail("marge_contributive").structure!.parts.map((p) => [p.nom, p.montant]), [
      ["Publicité & marketing", -5_700],
      ["Logistique", -1_100],
    ]);
    assert.deepEqual(detail("ca").structure!.parts.map((p) => [p.nom, p.montant]), [["Stripe", 42_000]]);
  });

  test("l'histogramme couvre tous les mois de la période avec le solde mensuel signé", () => {
    const vue = detail("marge_contributive");
    assert.deepEqual(vue.evolution, [
      { mois: "2026-07", montant: 10_000, valeur: 10_000 },
      { mois: "2026-08", montant: 11_000, valeur: 11_000 },
      { mois: "2026-09", montant: 8_200, valeur: 8_200 },
    ]);
    assert.equal(vue.evolutionAbsolue, false);
    // Sans catégorie, un solde mensuel négatif reste sous zéro.
    const coutsSeuls = calculerDetail(parts.filter((p) => p.etage !== "revenue"), "ebitda", SANS_FILTRE, PERIODE);
    assert.deepEqual(coutsSeuls.evolution.map((e) => e.valeur), [0, -1_000, -14_800]);
  });

  test("les transactions sont celles de l'étage exploré, date décroissante, sans non mappées", () => {
    assert.deepEqual(
      detail("marge_contributive").transactions.map((p) => [p.transactionId, p.sourceCategoryId, p.montant]),
      [
        ["mixte-sept", "pub", -700],
        ["mixte-sept", "logistique", -300],
        ["pub-sept-2", "pub", -1_500],
        ["log-sept", "logistique", -800],
        ["pub-sept-1", "pub", -2_500],
        ["pub-aout", "pub", -1_000],
      ]
    );
  });
});

describe("cross-filtering — une seule source de vérité pour les quatre blocs", () => {
  test("clic sur un mois : KPI, camembert et transactions se limitent à ce mois ; l'histogramme reste entier", () => {
    const vue = detail("marge_contributive", { categorie: null, mois: "2026-08" });
    assert.equal(vue.kpi.montant, 11_000);
    assert.deepEqual(vue.structure!.parts.map((p) => [p.nom, p.montant]), [["Publicité & marketing", -1_000]]);
    assert.deepEqual(vue.transactions.map((p) => p.transactionId), ["pub-aout"]);
    assert.equal(vue.evolution.length, 3);
    assert.deepEqual(vue.evolution, detail("marge_contributive").evolution);
  });

  test("clic sur une catégorie : KPI, histogramme et transactions se limitent à elle ; le camembert reste entier", () => {
    const vue = detail("marge_contributive", { categorie: "pub", mois: null });
    assert.deepEqual([vue.kpi.categorie, vue.kpi.montant], ["Publicité & marketing", -5_700]);
    assert.equal(vue.kpi.ratio, -5_700 / 42_000);
    assert.ok(vue.transactions.every((p) => p.sourceCategoryId === "pub"));
    assert.equal(vue.transactions.length, 4);
    assert.equal(vue.structure!.parts.length, 2);
  });

  test("catégorie sélectionnée : barreaux en valeur absolue, montants réels conservés", () => {
    const vue = detail("marge_contributive", { categorie: "pub", mois: null });
    assert.equal(vue.evolutionAbsolue, true);
    assert.deepEqual(vue.evolution.map((e) => e.valeur), [0, 1_000, 4_700]);
    assert.deepEqual(vue.evolution.map((e) => e.montant), [0, -1_000, -4_700]);
    // Le KPI, lui, garde le montant financier signé.
    assert.equal(vue.kpi.montant, -5_700);
  });

  test("catégorie + mois se cumulent", () => {
    const vue = detail("marge_contributive", { categorie: "pub", mois: "2026-09" });
    assert.equal(vue.kpi.montant, -4_700);
    assert.equal(vue.kpi.ratio, -4_700 / 20_000);
    assert.deepEqual(vue.transactions.map((p) => [p.transactionId, p.montant]), [
      ["mixte-sept", -700],
      ["pub-sept-2", -1_500],
      ["pub-sept-1", -2_500],
    ]);
    // Somme des transactions listées = KPI affiché : ce que l'on voit explique le chiffre.
    assert.equal(vue.transactions.reduce((s, p) => s + p.montant, 0), vue.kpi.montant);
  });

  test("le filtre catégorie prend la part pondérée d'une transaction ventilée, pas son montant total", () => {
    const vue = detail("marge_contributive", { categorie: "logistique", mois: "2026-09" });
    assert.equal(vue.kpi.montant, -1_100);
    assert.deepEqual(vue.transactions.map((p) => [p.transactionId, p.montant, p.montantSource]), [
      ["mixte-sept", -300, -1_000],
      ["log-sept", -800, -800],
    ]);
  });

  test("mois sans CA : pas de ratio plutôt qu'une division par zéro", () => {
    const sansCa = calculerDetail(parts.filter((p) => p.etage !== "revenue"), "ebitda", SANS_FILTRE, PERIODE);
    assert.equal(sansCa.kpi.ratio, null);
  });
});

describe("Cash flow — indicateur dérivé, écran volontairement différent", () => {
  test("KPI = EBITDA + Extra P&L ; pas de camembert ; transactions de l'Extra P&L", () => {
    const vue = detail("cash_flow");
    assert.equal(vue.kpi.montant, detail("ebitda").kpi.montant + (-2_000 + 500));
    assert.equal(vue.structure, null);
    assert.deepEqual(vue.transactions.map((p) => p.transactionId), ["tva-sept", "emprunt-aout"]);
  });

  test("décomposition mensuelle : EBITDA + Extra P&L = Cash flow, mois par mois", () => {
    const vue = detail("cash_flow");
    assert.deepEqual(vue.decomposition, [
      { mois: "2026-07", ebitda: 10_000, extraPnl: 0, cashFlow: 10_000 },
      { mois: "2026-08", ebitda: 11_000, extraPnl: 500, cashFlow: 11_500 },
      { mois: "2026-09", ebitda: 5_200, extraPnl: -2_000, cashFlow: 3_200 },
    ]);
    assert.deepEqual(vue.evolution.map((e) => e.montant), vue.decomposition!.map((d) => d.cashFlow));
    assert.equal(detail("ebitda").decomposition, null);
  });

  test("le filtre mois s'applique ; aucun filtre catégorie sur cet écran", () => {
    const vue = detail("cash_flow", { categorie: "tva", mois: "2026-08" });
    assert.equal(vue.kpi.montant, 11_500);
    assert.equal(vue.kpi.categorie, null);
    assert.equal(vue.evolutionAbsolue, false);
    assert.deepEqual(vue.transactions.map((p) => p.transactionId), ["emprunt-aout"]);
  });
});

describe("camembert — lisibilité", () => {
  const nombreuses = Array.from({ length: 10 }, (_, i) => mapping(`c${i}`, `Catégorie ${i}`, "ebitda"));
  const transactionsNombreuses = (etage: MappingCategorie["pnlStage"]) =>
    partsMappees(
      nombreuses.map((m, i) => tx(`t${i}`, "2026-09-01", -(10 - i) * 100, [[m.sourceCategoryId, 1]])),
      AXE,
      indexerMappings(nombreuses.map((m) => ({ ...m, pnlStage: etage })))
    );

  test("CA, Marge brute, Marge contributive : 5 catégories puis « Autres » (6 parts)", () => {
    const vue = calculerDetail(transactionsNombreuses("contribution_margin"), "marge_contributive", SANS_FILTRE, PERIODE);
    assert.deepEqual(vue.structure!.parts.map((p) => p.cle), ["c0", "c1", "c2", "c3", "c4", CLE_AUTRES]);
    assert.equal(vue.structure!.parts[5].nom, "Autres (5 catégories)");
  });

  test("EBITDA : 7 catégories puis « Autres » (8 parts)", () => {
    const vue = calculerDetail(transactionsNombreuses("ebitda"), "ebitda", SANS_FILTRE, PERIODE);
    assert.deepEqual(vue.structure!.parts.map((p) => p.cle), ["c0", "c1", "c2", "c3", "c4", "c5", "c6", CLE_AUTRES]);
    assert.equal(vue.structure!.parts[7].nom, "Autres (3 catégories)");
  });

  test("une petite catégorie sélectionnée sort de « Autres » ; une autre y entre à sa place", () => {
    const vue = calculerDetail(transactionsNombreuses("ebitda"), "ebitda", { categorie: "c9", mois: null }, PERIODE);
    assert.deepEqual(vue.structure!.parts.map((p) => p.cle), ["c0", "c1", "c2", "c3", "c4", "c5", "c9", CLE_AUTRES]);
    assert.equal(vue.structure!.parts[7].nom, "Autres (3 catégories)");
    assert.equal(vue.structure!.parts.reduce((s, p) => s + p.montant, 0), -5_500);
  });
});
