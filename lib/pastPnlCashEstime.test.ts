import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ajustementsDepuisStocks, AjustementGestion } from "./pastAdjustments";
import { EtagePnl, indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { calculerPnl } from "./pastPnl";
import { calculerPnlCashEstime, fluxHorsPnl, lignesAvertissementFlux, lignesFinalesDuCashFlow, TITRE_PNL_CASH_ESTIME } from "./pastPnlCashEstime";
import { pagesExportPdf } from "./pastPdfModel";
import { partsMappees } from "./pastDetail";
import { partsEnBase, tauxParCategorie } from "./pastHtEstime";
import { pnlCashEstimeActif } from "./featureFlags";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PastTransactionStockee } from "./pastTransactions";

const AXE = "axe";

function mapping(id: string, pnlStage: EtagePnl | null, vatRate: number | null = 20): MappingCategorie {
  return { sourceCategoryId: id, sourceCategoryName: id, sourceGroupId: AXE, pnlStage, vatRate };
}

function transaction(id: string, amount: number, categories: [string, number][] = [], date = "2026-03-15"): PastTransactionStockee {
  return {
    id,
    sourceType: "pennylane",
    transactionDate: date,
    label: id,
    amount,
    currency: "EUR",
    affectations: categories.map(([categoryId, weight]) => ({ groupId: AXE, categoryId, categoryName: categoryId, weight })),
  };
}

const MAPPINGS = indexerMappings([
  mapping("ventes", "revenue", 20),
  mapping("ventes_reduites", "revenue", 5.5),
  mapping("achats", "gross_margin", 20),
  mapping("pub", "contribution_margin", 20),
  mapping("loyer", "ebitda", 20),
  mapping("salaires", "ebitda", 0),
  mapping("divers", "extra_pnl", 20),
  mapping("tva", "vat", null),
  mapping("emprunt", "financing", null),
  mapping("virement", "financing", null),
  mapping("sans_etage", null),
  mapping("sans_taux", "gross_margin", null),
]);

const proche = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≠ ${b}`);

describe("P&L cash estimé : cascade HT", () => {
  const lignes = [
    transaction("v1", 1200, [["ventes", 1]]),
    transaction("v2", 105.5, [["ventes_reduites", 1]]),
    transaction("a1", -240, [["achats", 1]]),
    transaction("p1", -120, [["pub", 1]]),
    transaction("l1", -360, [["loyer", 1]]),
    transaction("s1", -100, [["salaires", 1]]),
    transaction("d1", -60, [["divers", 1]]),
  ];

  test("chaque catégorie est convertie à SON taux, les soldes sont recalculés", () => {
    const pnl = calculerPnlCashEstime(lignes, AXE, MAPPINGS, []);
    proche(pnl.ca, 1000 + 100);
    proche(pnl.coutsDirects, -200);
    proche(pnl.margeBrute, 900);
    proche(pnl.coutsCommerciaux, -100);
    proche(pnl.margeContributive, 800);
    proche(pnl.coutsStructure, -300 - 100);
    proche(pnl.ebitda, 400);
    proche(pnl.extraPnl, -50);
    proche(pnl.soldeGestionEstime, 350);
    assert.equal(pnl.base, "ht");
  });

  test("ratios HT sur HT", () => {
    const pnl = calculerPnlCashEstime(lignes, AXE, MAPPINGS, []);
    proche(pnl.ratios.margeBrute!, 900 / 1100);
    proche(pnl.ratios.ebitda!, 400 / 1100);
  });

  test("catégorie sans taux : ni convertie ni assimilée à 0 %, et signalée", () => {
    const pnl = calculerPnlCashEstime([...lignes, transaction("x", -120, [["sans_taux", 1]])], AXE, MAPPINGS, []);
    proche(pnl.coutsDirects, -200 - 120);
    assert.equal(pnl.couvertures!.margeBrute.complete, false);
    assert.equal(pnl.couvertures!.margeBrute.categoriesSansTva[0].sourceCategoryId, "sans_taux");
    assert.equal(pnl.couvertures!.ca.complete, true);
  });
});

describe("P&L cash estimé : bottom line", () => {
  const lignes = [
    transaction("v", 1200, [["ventes", 1]]),
    transaction("t", -500, [["tva", 1]]),
    transaction("e", -3000, [["emprunt", 1]]),
    transaction("vi", 800, [["virement", 1]]),
  ];

  test("TVA, financement et virements internes n'entrent ni dans une charge ni dans le solde", () => {
    const pnl = calculerPnlCashEstime(lignes, AXE, MAPPINGS, []);
    proche(pnl.soldeGestionEstime, 1000);
    assert.ok(!pnl.categories.some((c) => c.etage === "vat"));
  });

  test("ils restent intacts dans les flux TTC : la trésorerie ne perd rien", () => {
    const ttc = calculerPnl(lignes, AXE, MAPPINGS, []);
    proche(ttc.tva, -500);
    proche(ttc.financements, -2200);
    proche(ttc.variationTresorerie, 1200 - 500 - 2200);
  });

  test("ajustements de gestion : comptés à leur étage, jamais convertis ; ceux de TVA ou financement hors solde", () => {
    const ajustement = (etage: EtagePnl, montant: number): AjustementGestion => ({ id: etage, date: "2026-03-31", label: etage, montant, etage, type: "autre", notes: null });
    const pnl = calculerPnlCashEstime(lignes, AXE, MAPPINGS, [ajustement("ebitda", -120), ajustement("extra_pnl", 40), ajustement("vat", 999), ajustement("financing", 999)]);
    proche(pnl.ebitda, 1000 - 120);
    proche(pnl.soldeGestionEstime, 1000 - 120 + 40);
    assert.equal(pnl.ajustements.extra_pnl[0].montant, 40);
  });
});

describe("P&L cash estimé : variation de stocks", () => {
  test("alimente la marge brute sans conversion HT et se propage jusqu'au solde", () => {
    const ajustements = ajustementsDepuisStocks([
      { mois: "2026-02", valeur: 1000 },
      { mois: "2026-03", valeur: 1600 },
    ]).filter((a) => a.date.startsWith("2026-03"));
    const pnl = calculerPnlCashEstime([transaction("v", 1200, [["ventes", 1]])], AXE, MAPPINGS, ajustements);
    proche(pnl.margeBrute, 1000 + 600);
    proche(pnl.soldeGestionEstime, 1600);
  });

  test("société sans stock : aucun ajustement, cascade identique", () => {
    const pnl = calculerPnlCashEstime([transaction("v", 1200, [["ventes", 1]])], AXE, MAPPINGS, []);
    assert.deepEqual(pnl.ajustements.gross_margin, []);
    proche(pnl.margeBrute, 1000);
  });
});

describe("Flux sans affectation", () => {
  test("non catégorisé et non mappé sont distingués, signes conservés, pas de HT", () => {
    const flux = fluxHorsPnl(
      [transaction("a", -120), transaction("b", 50), transaction("c", -240, [["sans_etage", 1]]), transaction("d", 60, [["sans_etage", 1]])],
      AXE,
      MAPPINGS
    );
    assert.equal(flux.nonCategorise.nombreTransactions, 2);
    assert.equal(flux.nonCategorise.montant, -70);
    assert.equal(flux.nonCategorise.encaissements, 50);
    assert.equal(flux.nonCategorise.decaissements, -120);
    assert.equal(flux.nonMappe.montant, -180);
    assert.deepEqual(flux.nonMappe.categories.map((c) => c.sourceCategoryId), ["sans_etage"]);
    assert.equal(flux.incomplet, true);
  });

  test("ils n'entrent dans aucune marge, et le P&L les expose à part", () => {
    const pnl = calculerPnlCashEstime([transaction("v", 1200, [["ventes", 1]]), transaction("a", -120)], AXE, MAPPINGS, []);
    proche(pnl.margeBrute, 1000);
    proche(pnl.soldeGestionEstime, 1000);
    assert.equal(pnl.flux.nonCategorise.montant, -120);
    assert.equal(pnl.flux.incomplet, true);
  });

  test("le reliquat d'une ventilation incomplète ne disparaît plus", () => {
    const flux = fluxHorsPnl([transaction("a", -1000, [["achats", 0.6]])], AXE, MAPPINGS);
    proche(flux.nonCategorise.montant, -400);
    assert.equal(flux.nonCategorise.nombreTransactions, 1);
  });

  test("une catégorie d'un autre axe ne vaut pas catégorisation sur l'axe retenu", () => {
    const flux = fluxHorsPnl([transaction("a", -100, [["achats", 1]])], "autre_axe", MAPPINGS);
    assert.equal(flux.nonCategorise.montant, -100);
    assert.equal(flux.nonMappe.montant, 0);
  });

  test("rien à signaler quand tout est affecté", () => {
    const flux = fluxHorsPnl([transaction("a", -100, [["achats", 0.5], ["pub", 0.5]])], AXE, MAPPINGS);
    assert.equal(flux.incomplet, false);
  });

  test("répartition par mois pour l'écran Cash flow", () => {
    const flux = fluxHorsPnl([transaction("a", -100, [], "2026-01-10"), transaction("b", -20, [["sans_etage", 1]], "2026-02-10")], AXE, MAPPINGS);
    assert.deepEqual(flux.parMois.get("2026-01"), { nonCategorise: -100, nonMappe: 0 });
    assert.deepEqual(flux.parMois.get("2026-02"), { nonCategorise: 0, nonMappe: -20 });
  });

  test("aucun flux ne disparaît : étages + hors P&L = somme des transactions", () => {
    const lignes = [
      transaction("v", 1200, [["ventes", 1]]),
      transaction("m", -1000, [["achats", 0.7], ["pub", 0.2]]),
      transaction("t", -500, [["tva", 1]]),
      transaction("vi", 800, [["virement", 1]]),
      transaction("d", -60, [["divers", 1]]),
      transaction("n", -33, []),
      transaction("x", 77, [["sans_etage", 1]]),
    ];
    const ttc = calculerPnl(lignes, AXE, MAPPINGS, []);
    const flux = fluxHorsPnl(lignes, AXE, MAPPINGS);
    const total = lignes.reduce((s, t) => s + t.amount, 0);
    proche(ttc.variationTresorerie + flux.nonCategorise.montant + flux.nonMappe.montant, total);
  });
});

describe("Écran Cash flow et rapport : lignes finales", () => {
  const flux = fluxHorsPnl([transaction("a", -100, [], "2026-01-10"), transaction("b", -20, [["sans_etage", 1]], "2026-02-10")], AXE, MAPPINGS);

  test("Non catégorisé en dernière ligne, total signé", () => {
    const fin = lignesFinalesDuCashFlow(1000, flux, null)!;
    assert.deepEqual(fin.lignes.map((l) => l.libelle), ["Catégories à mapper", "Non catégorisé"]);
    assert.equal(fin.total, 880);
  });

  test("un mois filtré ne porte que ses flux", () => {
    assert.equal(lignesFinalesDuCashFlow(50, flux, "2026-02")!.total, 30);
    assert.equal(lignesFinalesDuCashFlow(50, flux, "2026-03"), null);
  });

  test("rien à signaler : aucune ligne ajoutée", () => {
    assert.equal(lignesFinalesDuCashFlow(50, fluxHorsPnl([], AXE, MAPPINGS), null), null);
  });

  test("avertissements du rapport : montants signés, sans conversion HT", () => {
    const lignes = lignesAvertissementFlux(flux);
    assert.match(lignes[0], /Non catégorisé.*100.*TTC.*hors P&L/);
    assert.match(lignes[1], /Catégories à mapper.*20.*TTC/);
    assert.match(lignes[2], /Marges incomplètes/);
  });
});

describe("Rapport PDF, présentation cash estimé", () => {
  const lignes = [transaction("v", 1200, [["ventes", 1]]), transaction("n", -33, [])];
  const pnl = calculerPnlCashEstime(lignes, AXE, MAPPINGS, []);
  const parts = partsEnBase(partsMappees(lignes, AXE, MAPPINGS), tauxParCategorie(MAPPINGS), "ht");
  const pages = pagesExportPdf({
    pnl,
    parts,
    partsTtc: partsMappees(lignes, AXE, MAPPINGS),
    base: "ht",
    presentation: "cash_estime",
    fluxHorsPnl: pnl.flux,
    periode: { debut: "2026-03-01", fin: "2026-03-31" },
    ajustements: [],
    avertissements: [],
    ongletOuvert: "general",
    filtresOngletOuvert: { categorie: null, mois: null },
  });

  test("le rapport porte le nom du P&L et sa présentation", () => {
    const general = pages[0];
    assert.equal(general.type === "general" && general.presentation, "cash_estime");
    assert.equal(general.titre, TITRE_PNL_CASH_ESTIME);
  });

  test("la page Cash flow reprend les flux sans affectation", () => {
    const cashFlow = pages.find((p) => p.type === "detail" && p.metrique === "cash_flow");
    assert.equal(cashFlow?.type === "detail" && cashFlow.lignesFinales?.total, 1200 - 33);
  });

  test("les autres pages n'en ont pas", () => {
    const marge = pages.find((p) => p.type === "detail" && p.metrique === "marge_brute");
    assert.equal(marge?.type === "detail" && marge.lignesFinales, null);
  });

  test("sans présentation demandée, le rapport historique est inchangé", () => {
    const historique = pagesExportPdf({ pnl, parts, periode: { debut: "2026-03-01", fin: "2026-03-31" }, ajustements: [], avertissements: [], ongletOuvert: "general", filtresOngletOuvert: { categorie: null, mois: null } });
    assert.equal(historique[0].type === "general" && historique[0].presentation, "historique");
    assert.equal(historique[0].titre, "Général");
  });
});

describe("Écran P&L cash estimé : garde-fous de présentation", () => {
  const source = readFileSync(join(process.cwd(), "components/PassePnlCashEstime.tsx"), "utf8");

  test("ni variation de trésorerie, ni TVA, ni financement, ni mention TTC", () => {
    assert.doesNotMatch(source, /LIBELLE_VARIATION_TRESORERIE|Variation de trésorerie|libelleEtagePnl\("vat"\)|libelleEtagePnl\("financing"\)|MENTION_TTC/);
  });

  test("le drapeau éteint garde le sélecteur HT / TTC et l'écran historique", () => {
    const module = readFileSync(join(process.cwd(), "components/PasseTransactions.tsx"), "utf8");
    assert.match(module, /!cashEstime && \(vue === "general"/);
    assert.match(module, /<PasseGeneral/);
    assert.ok(!pnlCashEstimeActif(), "éteint par défaut");
  });
});
