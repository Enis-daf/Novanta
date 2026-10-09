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
      ["Général", "CA", "Marge brute", "Marge contributive", "EBITDA", "Cash flow"]
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
