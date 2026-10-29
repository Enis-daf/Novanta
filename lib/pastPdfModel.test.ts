import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { partsMappees } from "./pastDetail";
import { MAX_TRANSACTIONS_PDF, nomFichierPdf, PageDetailPdf, pagesExportPdf, SourceExportPdf, textePdf } from "./pastPdfModel";
import { calculerPnl } from "./pastPnl";
import { PastTransactionStockee } from "./pastTransactions";

const AXE = "229";
const PERIODE = { debut: "2025-10-01", fin: "2026-09-30" };

function mapping(id: string, pnlStage: MappingCategorie["pnlStage"]): MappingCategorie {
  return { sourceCategoryId: id, sourceCategoryName: `Catégorie ${id}`, sourceGroupId: AXE, pnlStage };
}

function tx(id: string, amount: number, categorie: string, date = "2026-03-01"): PastTransactionStockee {
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

const mappings = indexerMappings([
  mapping("ca", "revenue"),
  mapping("direct", "gross_margin"),
  mapping("pub", "contribution_margin"),
  mapping("influence", "contribution_margin"),
  mapping("structure", "ebitda"),
  mapping("extra", "extra_pnl"),
]);

function source(transactions: PastTransactionStockee[], surcharge: Partial<SourceExportPdf> = {}): SourceExportPdf {
  return {
    pnl: calculerPnl(transactions, AXE, mappings),
    parts: partsMappees(transactions, AXE, mappings),
    periode: PERIODE,
    ajustements: [],
    avertissements: [],
    ongletOuvert: "general",
    filtresOngletOuvert: { categorie: null, mois: null },
    ...surcharge,
  };
}

const details = (s: SourceExportPdf) => pagesExportPdf(s).filter((p): p is PageDetailPdf => p.type === "detail");

describe("pagesExportPdf — une page par onglet de résultats", () => {
  const transactions = [tx("a", 1000, "ca"), tx("b", -300, "direct"), tx("c", -100, "pub"), tx("d", -50, "structure"), tx("e", -20, "extra")];

  test("six pages, dans l'ordre des onglets ; ni Stocks ni Correspondance P&L", () => {
    assert.deepEqual(
      pagesExportPdf(source(transactions)).map((p) => p.titre),
      ["Général", "Encaissements", "Marge brute", "Marge contributive", "EBITDA", "Cash flow"]
    );
  });

  test("les indicateurs sont ceux des écrans", () => {
    assert.deepEqual(
      details(source(transactions)).map((p) => p.vue.kpi.montant),
      [1000, 700, 600, 550, 530]
    );
  });
});

describe("pagesExportPdf — transactions d'une page de détail", () => {
  test("les 20 plus importantes en valeur absolue, prises sur l'ensemble, signe réel conservé", () => {
    const transactions = [
      ...Array.from({ length: 40 }, (_, i) => tx(`petite-${String(i).padStart(2, "0")}`, 10 + i, "ca")),
      tx("gros-encaissement", 10000, "ca"),
      tx("gros-remboursement", -9500, "ca"),
    ];
    const [ca] = details(source(transactions));
    assert.equal(ca.nombreTransactions, 42);
    assert.equal(ca.transactions.length, MAX_TRANSACTIONS_PDF);
    assert.deepEqual(ca.transactions.slice(0, 3).map((p) => p.montant), [10000, -9500, 49]);
    // Aucune des transactions écartées ne pèse plus que la dernière retenue.
    assert.equal(ca.transactions.at(-1)!.montant, 32);
  });

  test("moins de 20 transactions : toutes, sans complément", () => {
    const [ca] = details(source([tx("a", 100, "ca"), tx("b", -300, "ca")]));
    assert.deepEqual(ca.transactions.map((p) => p.montant), [-300, 100]);
  });
});

describe("pagesExportPdf — filtres locaux", () => {
  const transactions = [
    tx("ca-mars", 1000, "ca", "2026-03-10"),
    tx("pub-mars", -100, "pub", "2026-03-12"),
    tx("pub-avril", -400, "pub", "2026-04-02"),
    tx("influence-avril", -60, "influence", "2026-04-03"),
    tx("structure-avril", -50, "structure", "2026-04-05"),
  ];

  test("le filtre de l'onglet ouvert s'applique à sa page, et à elle seule", () => {
    const pages = details(source(transactions, { ongletOuvert: "marge_contributive", filtresOngletOuvert: { categorie: "pub", mois: "2026-04" } }));
    const page = pages.find((p) => p.metrique === "marge_contributive")!;
    assert.deepEqual(page.libellesFiltres, ["Catégorie pub", "Avril 2026"]);
    assert.deepEqual(page.transactions.map((p) => p.transactionId), ["pub-avril"]);
    assert.equal(page.vue.kpi.montant, -400);
    for (const autre of pages.filter((p) => p.metrique !== "marge_contributive")) {
      assert.deepEqual(autre.filtres, { categorie: null, mois: null });
      assert.deepEqual(autre.libellesFiltres, []);
    }
    assert.equal(pages.find((p) => p.metrique === "ebitda")!.nombreTransactions, 1);
  });

  test("filtre sur le mois seul", () => {
    const pages = details(source(transactions, { ongletOuvert: "marge_contributive", filtresOngletOuvert: { categorie: null, mois: "2026-04" } }));
    const page = pages.find((p) => p.metrique === "marge_contributive")!;
    assert.deepEqual(page.libellesFiltres, ["Avril 2026"]);
    assert.deepEqual(page.transactions.map((p) => p.transactionId), ["pub-avril", "influence-avril"]);
  });

  test("onglet ouvert hors reporting (Stocks, Général) : aucune page filtrée", () => {
    for (const ongletOuvert of ["stocks", "mapping", "general"]) {
      const pages = details(source(transactions, { ongletOuvert, filtresOngletOuvert: { categorie: "pub", mois: "2026-04" } }));
      assert.ok(pages.every((p) => p.libellesFiltres.length === 0), ongletOuvert);
    }
  });
});

describe("nomFichierPdf", () => {
  test("format Novanta_Reporting_<Organisation>_<DateDebut>_<DateFin>.pdf", () => {
    assert.equal(nomFichierPdf("Maju", PERIODE), "Novanta_Reporting_Maju_2025-10-01_2026-09-30.pdf");
  });

  test("accents, espaces et caractères spéciaux retirés ; nom vide remplacé", () => {
    assert.equal(nomFichierPdf("Société Éxemple & Fils / SAS", PERIODE), "Novanta_Reporting_Societe-Exemple-Fils-SAS_2025-10-01_2026-09-30.pdf");
    assert.equal(nomFichierPdf("  ", PERIODE), "Novanta_Reporting_Organisation_2025-10-01_2026-09-30.pdf");
  });
});

describe("textePdf", () => {
  test("espaces insécables du formatage français et retours à la ligne ramenés à des espaces simples", () => {
    assert.equal(textePdf("1 234,5 k€"), "1 234,5 k€");
    assert.equal(textePdf("VIR SEPA\n- Reason: facture"), "VIR SEPA - Reason: facture");
  });
});

// --- Rapport par période : structure, BFR, Analyse d'écarts ---

import { FactureBfr } from "./pastBfr";
import { delaisDuMois } from "./pastBfrDelais";
import { evolutionBfr, lectureBfrDuMois, SourcesBfr } from "./pastBfrLecture";
import { EXERCICE_PAR_DEFAUT } from "./fiscalPeriods";
import { entetePnl, PagePdf, pageBfrPdf, pageEcartsPdf } from "./pastPdfModel";
import { planRapport } from "./pastPdfPeriodes";
import { comparerPeriodes, donneesPeriode } from "./pastVariance";

const AUJ = "2026-10-15";
const PLAN_SEPTEMBRE = planRapport({ type: "mois", mois: "2026-09" }, AUJ, EXERCICE_PAR_DEFAUT);

function factureBfr(n: number, champs: Partial<FactureBfr> = {}): FactureBfr {
  return {
    pennylaneId: `p${n}`,
    type: "client",
    numero: `F-${n}`,
    tiers: "Client",
    dateEmission: "2026-09-05",
    echeance: "2026-10-05",
    devise: "EUR",
    montantTtc: 1_200,
    montantHt: 1_000,
    resteTtc: 0,
    resteHt: 0,
    exclusion: null,
    factureAvoireeId: null,
    reglements: [{ date: "2026-10-01", montant: 1_200 }],
    ...champs,
  };
}

const SOURCES_BFR: SourcesBfr = {
  factures: [
    factureBfr(1),
    factureBfr(2, { montantHt: 3_000, montantTtc: 3_600, reglements: [{ date: "2026-10-10", montant: 3_600 }] }),
    // Toujours due aujourd'hui.
    factureBfr(3, { dateEmission: "2026-09-20", resteTtc: 6_000, resteHt: 5_000, montantTtc: 6_000, montantHt: 5_000, reglements: null }),
    factureBfr(4, { type: "fournisseur", dateEmission: "2026-09-10", echeance: "2026-10-10", reglements: [{ date: "2026-10-12", montant: 1_200 }] }),
  ],
  validees: [],
  stocks: [{ mois: "2026-09", valeur: 7_000 }],
  sansStock: false,
  synchroniseLe: "2026-10-14",
};

describe("Rapport PDF — structure", () => {
  test("ordre : Général, Encaissements, marges, EBITDA, Cash flow, BFR, Analyse d'écarts ; aucune page Stocks, Objectifs ni Correspondance", () => {
    const transactions = [tx("1", 1_000, "ca", "2026-09-03"), tx("2", -300, "direct", "2026-09-04")];
    const pages: PagePdf[] = [
      ...pagesExportPdf(source(transactions, { periode: PLAN_SEPTEMBRE.periode, entete: entetePnl(PLAN_SEPTEMBRE, AUJ) })),
      pageBfrPdf(PLAN_SEPTEMBRE, SOURCES_BFR, AUJ),
      pageEcartsPdf({ plan: PLAN_SEPTEMBRE.ecarts, transactionsA: [tx("3", 800, "ca", "2026-08-03")], transactionsB: transactions, axeId: AXE, mappings, ajustements: [], financementCompris: false }),
    ];
    assert.deepEqual(
      pages.map((p) => p.titre),
      ["Général", "Encaissements", "Marge brute", "Marge contributive", "EBITDA", "Cash flow", "BFR", "Analyse d'écarts"]
    );
    assert.ok(pages.every((p) => !["Stocks", "Objectifs", "Correspondance P&L"].includes(p.titre)));
  });

  test("chaque page dit sa période : le mois pour le P&L, la fin de mois pour le BFR, les deux mois pour les écarts", () => {
    const [general] = pagesExportPdf(source([], { periode: PLAN_SEPTEMBRE.periode, entete: entetePnl(PLAN_SEPTEMBRE, AUJ) }));
    assert.deepEqual(general.entete, { titre: "Période analysée", valeur: "Septembre 2026", detail: "01/09/2026 — 30/09/2026" });
    assert.deepEqual(pageBfrPdf(PLAN_SEPTEMBRE, SOURCES_BFR, AUJ).entete, { titre: "Situation", valeur: "Au 30 septembre 2026", detail: null });
    const ecarts = pageEcartsPdf({ plan: PLAN_SEPTEMBRE.ecarts, transactionsA: [], transactionsB: [], axeId: AXE, mappings, ajustements: [], financementCompris: false });
    assert.equal(ecarts.entete.valeur, "Septembre 2026 vs août 2026");
  });

  test("mois en cours : le P&L est dit « à date », le BFR « dernier mois complet disponible »", () => {
    const plan = planRapport({ type: "mois", mois: "2026-10" }, AUJ, EXERCICE_PAR_DEFAUT);
    assert.deepEqual(entetePnl(plan, AUJ), { titre: "Période analysée", valeur: "Octobre 2026, à date", detail: "01/10/2026 — 15/10/2026" });
    assert.deepEqual(pageBfrPdf(plan, SOURCES_BFR, AUJ).entete, { titre: "Situation", valeur: "Au 30 septembre 2026", detail: "Dernier mois complet disponible" });
  });
});

describe("Rapport PDF — page BFR", () => {
  const page = pageBfrPdf(PLAN_SEPTEMBRE, SOURCES_BFR, AUJ);

  test("mêmes valeurs que l'onglet BFR : créances, stocks, dettes, BFR et statut", () => {
    assert.deepEqual(page.lecture, lectureBfrDuMois(SOURCES_BFR, "2026-09"));
    // Au 30/09, les factures réglées en octobre sont encore dues : 1 000 + 3 000 + 5 000 de créances.
    assert.deepEqual(page.lecture?.totaux, { creances: 9_000, stock: 7_000, dettes: 1_000, bfr: 15_000 });
  });

  test("mêmes délais que les cartouches du mois, et le mois précédent pour l'évolution", () => {
    assert.deepEqual(page.delais?.client, delaisDuMois(SOURCES_BFR.factures, "client", "2026-09", AUJ));
    assert.deepEqual(page.delais?.fournisseur, delaisDuMois(SOURCES_BFR.factures, "fournisseur", "2026-09", AUJ));
    assert.deepEqual(page.delais?.clientPrecedent, delaisDuMois(SOURCES_BFR.factures, "client", "2026-08", AUJ));
  });

  test("évolution : 12 mois se terminant sur la date de la situation ; un mois sans données n'est jamais 0", () => {
    assert.deepEqual(page.evolution, evolutionBfr(SOURCES_BFR, "2026-09", AUJ));
    assert.equal(page.evolution.length, 12);
    assert.equal(page.evolution[11].mois, "2026-09");
    assert.equal(page.evolution[0].mois, "2025-10");
    assert.equal(page.evolution[10].valeur, null); // août : stock non renseigné
    assert.equal(page.evolution[11].delaiClients, page.delais?.client.delaiMoyen);
  });

  test("aucune fin de mois utilisable : page explicite, aucune valeur fabriquée", () => {
    const plan = planRapport({ type: "exercice", debut: "2026-10-01" }, AUJ, { mois: 10, jour: 1 });
    const vide = pageBfrPdf(plan, SOURCES_BFR, AUJ);
    assert.equal(vide.lecture, null);
    assert.equal(vide.evolution.length, 0);
    assert.match(vide.indisponible ?? "", /^BFR non disponible : aucune fin de mois terminée/);
  });

  test("situation incomplète (stock manquant) : BFR non chiffré, créances et dettes connues conservées", () => {
    const incomplete = pageBfrPdf(PLAN_SEPTEMBRE, { ...SOURCES_BFR, stocks: [] }, AUJ);
    assert.equal(incomplete.lecture?.totaux, null);
    assert.equal(incomplete.lecture?.statut, "incomplete");
    assert.equal(incomplete.lecture?.situation.totalCreances, 9_000);
    assert.equal(incomplete.lecture?.situation.totalDettes, 1_000);
  });
});

describe("Rapport PDF — page Analyse d'écarts", () => {
  const a = [tx("a1", 1_000, "ca", "2026-08-03"), tx("a2", -400, "pub", "2026-08-10")];
  const b = [tx("b1", 1_500, "ca", "2026-09-03"), tx("b2", -200, "pub", "2026-09-10"), tx("b3", -100, "structure", "2026-09-11")];
  const page = pageEcartsPdf({ plan: PLAN_SEPTEMBRE.ecarts, transactionsA: a, transactionsB: b, axeId: AXE, mappings, ajustements: [], financementCompris: false });

  test("même calcul que l'écran, sur les périodes du plan (septembre vs août), sans normalisation", () => {
    const attendu = comparerPeriodes(
      donneesPeriode(a, AXE, mappings, [], PLAN_SEPTEMBRE.ecarts.a),
      donneesPeriode(b, AXE, mappings, [], PLAN_SEPTEMBRE.ecarts.b),
      { financementCompris: false }
    );
    assert.deepEqual(page.comparaison, attendu);
    assert.equal(page.comparaison?.cashFlowA, 600);
    assert.equal(page.comparaison?.cashFlowB, 1_200);
  });

  test("waterfall cohérente : la somme des contributions est l'écart", () => {
    const somme = (page.comparaison?.etages ?? []).reduce((t, e) => t + e.contribution, 0);
    assert.equal(somme, page.comparaison?.ecart);
  });

  test("mouvements explicatifs : par impact décroissant, avec leur étage", () => {
    assert.deepEqual(
      page.mouvements.map((m) => [m.nom, m.contribution]),
      [["Catégorie ca", 500], ["Catégorie pub", 200], ["Catégorie structure", -100]]
    );
    assert.equal(page.mouvements[0].libelleEtage, "Encaissements");
  });

  test("période précédente sans transaction : « Comparaison indisponible », jamais une autre période", () => {
    const vide = pageEcartsPdf({ plan: PLAN_SEPTEMBRE.ecarts, transactionsA: [], transactionsB: b, axeId: AXE, mappings, ajustements: [], financementCompris: false });
    assert.equal(vide.comparaison, null);
    assert.equal(vide.indisponible, "Comparaison indisponible : aucune transaction synchronisée du 01/08/2026 au 31/08/2026.");
  });
});
