import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { partsMappees } from "./pastDetail";
import { BaseMontants, baseEnregistree, BASE_PAR_DEFAUT, calculerPnlEnBase, cleStockageBase, partsEnBase, tauxParCategorie } from "./pastHtEstime";
import { disclaimerPdf, DISCLAIMER_PASSE, DISCLAIMER_PDF_HT_ESTIME, PageDetailPdf, PageGeneralPdf, pagesExportPdf } from "./pastPdfModel";
import { PastTransactionStockee } from "./pastTransactions";
import { MENTION_HT_ESTIME, MENTION_TTC } from "./format";
import PasseSelecteurBase from "../components/PasseSelecteurBase";

(globalThis as unknown as { React: typeof React }).React = React;

const AXE = "229";
const MARS = { debut: "2026-03-01", fin: "2026-03-31" };

function mapping(id: string, pnlStage: MappingCategorie["pnlStage"], vatRate: number | null): MappingCategorie {
  return { sourceCategoryId: id, sourceCategoryName: id, sourceGroupId: AXE, pnlStage, vatRate };
}

let n = 0;
function tx(amount: number, categorie: string, date = "2026-03-10"): PastTransactionStockee {
  return {
    id: `t${++n}`,
    sourceType: "pennylane",
    transactionDate: date,
    label: `Transaction ${n}`,
    amount,
    currency: "EUR",
    affectations: [{ groupId: AXE, categoryId: categorie, categoryName: categorie, weight: 1 }],
  };
}

const MAPPINGS = indexerMappings([
  mapping("A", "revenue", 20),
  mapping("direct", "gross_margin", 20),
  mapping("structure", "ebitda", 20),
  mapping("extra", "extra_pnl", null),
]);
const parts = (transactions: PastTransactionStockee[], base: BaseMontants) =>
  partsEnBase(partsMappees(transactions, AXE, MAPPINGS), tauxParCategorie(MAPPINGS), base);
const proche = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≠ ${b}`);

describe("export PDF : la lecture affichée, trésorerie en TTC", () => {
  const transactions = [tx(120_000, "A"), tx(-66_000, "direct"), tx(-12_000, "structure"), tx(-800, "extra")];
  test("PDF HT : indicateurs HT, Cash flow TTC, pied de page HT", () => {
    const ht = calculerPnlEnBase(transactions, AXE, MAPPINGS, [], "ht");
    const ttc = calculerPnlEnBase(transactions, AXE, MAPPINGS, [], "ttc");
    // Général en HT : Cash flow opérationnel HT estimé (EBITDA HT + Extra P&L HT) ; l'écran et la
    // page Cash flow, eux, restent TTC.
    assert.ok(Math.abs(ht.cashFlowOperationnel - (ht.ebitda + ht.extraPnl)) < 1e-6);
    assert.equal(ht.variationTresorerie, ttc.variationTresorerie);
    const pages = pagesExportPdf({
      pnl: ht,
      parts: parts(transactions, "ht"),
      partsTtc: parts(transactions, "ttc"),
      base: "ht",
      periode: MARS,
      ajustements: [],
      avertissements: [],
      ongletOuvert: "general",
      filtresOngletOuvert: { categorie: null, mois: null },
    });
    const cashFlow = pages.find((p): p is PageDetailPdf => p.type === "detail" && p.metrique === "cash_flow")!;
    const ca = pages.find((p): p is PageDetailPdf => p.type === "detail" && p.metrique === "ca")!;
    assert.equal(cashFlow.base, "ttc");
    assert.equal(cashFlow.vue.kpi.montant, ttc.cashFlowOperationnel);
    assert.equal(ca.base, "ht");
    proche(ca.vue.kpi.montant, 100_000);
    assert.equal((pages[0] as PageGeneralPdf).base, "ht");
    assert.notEqual(disclaimerPdf("ht"), DISCLAIMER_PASSE);
    assert.equal(disclaimerPdf("ttc"), DISCLAIMER_PASSE);
  });

  test("pied de page : rappel TTC en TTC, estimation HT en HT", () => {
    assert.equal(disclaimerPdf("ttc"), DISCLAIMER_PASSE);
    assert.equal(disclaimerPdf("ht"), DISCLAIMER_PDF_HT_ESTIME);
    assert.match(DISCLAIMER_PDF_HT_ESTIME, /estimés/);
  });
});

describe("HT estimé par défaut, choix conservé", () => {
  test("nouvel utilisateur : HT estimé ; préférence TTC existante respectée ; valeur illisible : HT", () => {
    assert.equal(BASE_PAR_DEFAUT, "ht");
    assert.equal(baseEnregistree(null), "ht");
    assert.equal(baseEnregistree("ttc"), "ttc");
    assert.equal(baseEnregistree("ht"), "ht");
    assert.equal(baseEnregistree("n'importe quoi"), "ht");
    assert.notEqual(cleStockageBase("org-1"), cleStockageBase("org-2"));
  });

  test("ordre du sélecteur : HT estimé puis TTC, le mode actif signalé", () => {
    const html = renderToStaticMarkup(React.createElement(PasseSelecteurBase, { base: "ht", onChange: () => {} }));
    assert.ok(html.indexOf(MENTION_HT_ESTIME) < html.indexOf(`>${MENTION_TTC}<`));
    assert.match(html, /aria-pressed="true"[^>]*>HT estimé</);
  });

  test("le module relit la préférence au montage et ne l'écrit que sur un choix explicite", () => {
    const source = readFileSync(path.resolve(__dirname, "../components/PasseTransactions.tsx"), "utf8");
    assert.match(source, /useState<BaseMontants>\(\(\) => \{\s*try \{\s*return baseEnregistree\(window\.localStorage\.getItem\(cleStockageBase\(organizationId\)\)\)/);
    assert.equal(source.match(/setItem\(cleStockageBase/g)?.length, 1);
    assert.match(source, /<PasseSelecteurBase base=\{base\} onChange=\{choisirBase\} \/>/);
    // Objectifs exclusivement HT : calculés en lecture HT seulement, jamais pour le Cash flow.
    assert.match(source, /base === "ht" \? ecartsVsCibles\(cibles, partsDetailAffichees, ajustements, periode\) : null/);
    assert.match(source, /cibles=\{base === "ht" && vue !== "cash_flow" \? cibles : undefined\}/);
  });

});
