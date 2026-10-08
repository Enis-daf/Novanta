import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AjustementGestion,
  ajustementsDeLaPeriode,
  ajustementsDepuisStocks,
  finDeMois,
  regrouperAjustements,
  TYPE_VARIATION_STOCK,
  variationsDeStock,
} from "./pastAdjustments";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { calculerDetail, partsMappees } from "./pastDetail";
import { calculerPnl, ETAGES_COUTS, structureParCategorie } from "./pastPnl";
import { anomaliesDeSigne } from "./pastSignChecks";
import { PastTransactionStockee } from "./pastTransactions";

const stock = (mois: string, valeur: number) => ({ mois, valeur });
const variations = (stocks: { mois: string; valeur: number }[]) =>
  Object.fromEntries([...variationsDeStock(stocks)].map(([mois, v]) => [mois, v.montant]));

describe("variation de stock — calculée à partir des stocks de fin de mois", () => {
  const serie = [stock("2026-01", 100_000), stock("2026-02", 120_000), stock("2026-03", 90_000)];

  test("le premier mois renseigné est le point de départ : aucune variation", () => {
    assert.deepEqual(variations([stock("2026-01", 100_000)]), {});
    assert.equal(variationsDeStock(serie).has("2026-01"), false);
  });

  test("à partir du deuxième mois : stock N − stock N-1", () => {
    assert.deepEqual(variations(serie), { "2026-02": 20_000, "2026-03": -30_000 });
  });

  test("l'ordre de saisie n'a pas d'importance", () => {
    assert.deepEqual(variations([...serie].reverse()), variations(serie));
  });

  test("modifier un stock recalcule la variation de son mois et celle du mois suivant", () => {
    const modifiee = [stock("2026-01", 100), stock("2026-02", 110), stock("2026-03", 90)];
    assert.deepEqual(variations(modifiee), { "2026-02": 10, "2026-03": -20 });
  });

  test("supprimer le premier mois : le suivant devient le point de départ", () => {
    assert.deepEqual(variations([stock("2026-02", 120), stock("2026-03", 90)]), { "2026-03": -30 });
  });

  test("mois manquant : variation calculée depuis la dernière valeur connue, marquée discontinue", () => {
    const avecTrou = [stock("2026-01", 100), stock("2026-03", 90), stock("2026-04", 95)];
    assert.deepEqual(variations(avecTrou), { "2026-03": -10, "2026-04": 5 });
    assert.deepEqual(variationsDeStock(avecTrou).get("2026-03"), { montant: -10, moisPrecedent: "2026-01", discontinue: true });
    assert.equal(variationsDeStock(avecTrou).get("2026-04")!.discontinue, false);
    // La somme des variations reste égale à dernier stock − premier stock.
    assert.equal([...variationsDeStock(avecTrou).values()].reduce((s, v) => s + v.montant, 0), 95 - 100);
  });

  test("plusieurs mois manquants, y compris à cheval sur deux années : même logique", () => {
    const serie = [stock("2025-11", 200), stock("2026-02", 260)];
    assert.deepEqual(variationsDeStock(serie).get("2026-02"), { montant: 60, moisPrecedent: "2025-11", discontinue: true });
    assert.equal(variationsDeStock([stock("2025-12", 1), stock("2026-01", 2)]).get("2026-01")!.discontinue, false);
  });

  test("la réserve suit l'ajustement dans le reporting, sans rien retirer du montant", () => {
    const [mars, avril] = ajustementsDepuisStocks([stock("2026-01", 100), stock("2026-03", 90), stock("2026-04", 95)]);
    assert.equal(mars.montant, -10);
    assert.match(mars.notes!, /Périodisation incertaine.*janvier 2026.*mois intermédiaire manquant/);
    assert.equal(avril.notes, null);
    const pnl = calculerPnl([], "229", new Map(), [mars, avril]);
    assert.equal(pnl.margeBrute, -5);
    assert.equal(pnl.cashFlow, -5);
    assert.deepEqual(pnl.ajustements.gross_margin.map((l) => [l.montant, l.notes.length]), [[-5, 1]]);
  });

  test("chaque variation est un ajustement de gestion : fin de mois, marge brute, type dédié", () => {
    assert.deepEqual(ajustementsDepuisStocks(serie), [
      { id: "inventory_variation:2026-02", date: "2026-02-28", label: "Variation de stock", montant: 20_000, etage: "gross_margin", type: TYPE_VARIATION_STOCK, notes: null },
      { id: "inventory_variation:2026-03", date: "2026-03-31", label: "Variation de stock", montant: -30_000, etage: "gross_margin", type: TYPE_VARIATION_STOCK, notes: null },
    ]);
    assert.equal(finDeMois("2028-02"), "2028-02-29");
  });

  test("la variation d'un mois dépend d'un stock qui peut être antérieur à la période affichée", () => {
    const tous = ajustementsDepuisStocks([stock("2025-12", 80_000), stock("2026-01", 100_000)]);
    const periode2026 = ajustementsDeLaPeriode(tous, { debut: "2026-01-01", fin: "2026-12-31" });
    assert.deepEqual(periode2026.map((a) => [a.date, a.montant]), [["2026-01-31", 20_000]]);
  });
});

// --- Le moteur générique : il ne connaît que type, étage, montant, date, libellé ---

const AXE = "229";
const mapping = (id: string, pnlStage: MappingCategorie["pnlStage"]): MappingCategorie => ({
  sourceCategoryId: id,
  sourceCategoryName: id,
  sourceGroupId: AXE,
  pnlStage,
});
const tx = (id: string, date: string, amount: number, categorie: string): PastTransactionStockee => ({
  id,
  sourceType: "pennylane",
  transactionDate: date,
  label: id,
  amount,
  currency: "EUR",
  affectations: [{ groupId: AXE, categoryId: categorie, categoryName: categorie, weight: 1 }],
});
const ajustement = (id: string, date: string, montant: number, etage: AjustementGestion["etage"], label: string, type = "manual"): AjustementGestion => ({
  id,
  date,
  label,
  montant,
  etage,
  type,
  notes: null,
});

const mappings = indexerMappings([mapping("CA", "revenue"), mapping("Achats", "gross_margin"), mapping("Pub", "contribution_margin"), mapping("Loyer", "ebitda"), mapping("TVA", "extra_pnl")]);
const transactions = [
  tx("v", "2026-03-10", 1_250_000, "CA"),
  tx("a", "2026-03-11", -530_000, "Achats"),
  tx("p", "2026-03-12", -210_000, "Pub"),
  tx("l", "2026-03-13", -320_000, "Loyer"),
  tx("t", "2026-03-14", -85_000, "TVA"),
];
const variationStock = ajustement("s", "2026-03-31", -31_600, "gross_margin", "Variation de stock", TYPE_VARIATION_STOCK);

describe("ajustements de gestion dans le P&L", () => {
  const sans = calculerPnl(transactions, AXE, mappings);
  const avec = calculerPnl(transactions, AXE, mappings, [variationStock]);

  test("un ajustement gross_margin entre dans la marge brute, sur sa propre ligne", () => {
    assert.equal(avec.coutsDirects, -530_000);
    assert.deepEqual(avec.ajustements.gross_margin.map((l) => [l.label, l.montant]), [["Variation de stock", -31_600]]);
    assert.equal(avec.margeBrute, 688_400);
  });

  test("…et, par ricochet, dans la marge contributive, l'EBITDA et le Cash flow", () => {
    assert.equal(avec.margeContributive, sans.margeContributive - 31_600);
    assert.equal(avec.ebitda, sans.ebitda - 31_600);
    assert.equal(avec.cashFlow, sans.cashFlow - 31_600);
    assert.equal(avec.ratios.margeBrute, 688_400 / 1_250_000);
  });

  test("moteur générique : un ajustement de n'importe quelle nature suit son étage", () => {
    const pnl = calculerPnl(transactions, AXE, mappings, [
      variationStock,
      ajustement("p1", "2026-03-31", 8_000, "ebitda", "Provision", "provision"),
      ajustement("x1", "2026-03-31", -2_500, "extra_pnl", "Correction", "correction"),
    ]);
    assert.equal(pnl.ebitda, sans.ebitda - 31_600 + 8_000);
    assert.equal(pnl.cashFlow, sans.cashFlow - 31_600 + 8_000 - 2_500);
    assert.deepEqual(pnl.ajustements.ebitda.map((l) => l.label), ["Provision"]);
    assert.deepEqual(pnl.ajustements.extra_pnl.map((l) => l.label), ["Correction"]);
  });

  test("les ajustements ne deviennent pas une catégorie : camembert et contrôles de signe les ignorent", () => {
    const structure = structureParCategorie(avec.categories, ETAGES_COUTS, "couts");
    assert.ok(!structure.parts.some((p) => p.nom === "Variation de stock"));
    assert.equal(structure.total, -1_060_000);
    // Une variation de stock positive (ici dans un étage de coûts) n'est pas une anomalie de signe.
    const stockEnHausse = ajustement("s2", "2026-03-31", 20_000, "gross_margin", "Variation de stock", TYPE_VARIATION_STOCK);
    assert.equal(calculerPnl(transactions, AXE, mappings, [stockEnHausse]).margeBrute, 740_000);
    assert.deepEqual(anomaliesDeSigne(transactions, AXE, mappings), []);
  });

  test("plusieurs ajustements de même nature font une seule ligne, les plus significatives d'abord", () => {
    const lignes = regrouperAjustements([
      ajustement("a", "2026-02-28", 20_000, "gross_margin", "Variation de stock", TYPE_VARIATION_STOCK),
      ajustement("b", "2026-03-31", -30_000, "gross_margin", "Variation de stock", TYPE_VARIATION_STOCK),
      ajustement("c", "2026-03-31", 40_000, "ebitda", "Provision", "provision"),
    ]);
    assert.deepEqual(lignes.map((l) => [l.label, l.montant]), [
      ["Provision", 40_000],
      ["Variation de stock", -10_000],
    ]);
  });
});

describe("ajustements de gestion dans les écrans de détail", () => {
  const periode = { debut: "2026-02-01", fin: "2026-03-31" };
  const parts = partsMappees([...transactions, tx("a-fev", "2026-02-11", -100_000, "Achats")], AXE, mappings);
  const ajustements = [
    ajustement("s-fev", "2026-02-28", 20_000, "gross_margin", "Variation de stock", TYPE_VARIATION_STOCK),
    ajustement("s-mars", "2026-03-31", -30_000, "gross_margin", "Variation de stock", TYPE_VARIATION_STOCK),
    ajustement("prov", "2026-03-31", 8_000, "ebitda", "Provision", "provision"),
  ];
  const detail = (metrique: Parameters<typeof calculerDetail>[1], filtres = { categorie: null as string | null, mois: null as string | null }) =>
    calculerDetail(parts, metrique, filtres, periode, ajustements);

  test("KPI et histogramme de la Marge brute incluent les ajustements gross_margin", () => {
    const vue = detail("marge_brute");
    assert.equal(vue.kpi.montant, 1_250_000 - 530_000 - 100_000 + 20_000 - 30_000);
    assert.deepEqual(vue.evolution.map((e) => [e.mois, e.montant]), [
      ["2026-02", -100_000 + 20_000],
      ["2026-03", 1_250_000 - 530_000 - 30_000],
    ]);
  });

  test("le bloc liste les ajustements compris dans l'indicateur de l'écran", () => {
    assert.deepEqual(detail("marge_brute").ajustements.lignes.map((l) => [l.label, l.montant]), [["Variation de stock", -10_000]]);
    assert.deepEqual(detail("ebitda").ajustements.lignes.map((l) => [l.label, l.montant]), [
      ["Variation de stock", -10_000],
      ["Provision", 8_000],
    ]);
    // Le CA ne contient aucun ajustement de marge brute.
    assert.deepEqual(detail("ca").ajustements.lignes, []);
    assert.equal(detail("ca").kpi.montant, 1_250_000);
  });

  test("le bloc et le KPI suivent le filtre mois", () => {
    const fevrier = detail("marge_brute", { categorie: null, mois: "2026-02" });
    assert.equal(fevrier.kpi.montant, -100_000 + 20_000);
    assert.deepEqual(fevrier.ajustements.lignes.map((l) => l.montant), [20_000]);
    assert.deepEqual(fevrier.ajustementsDetail.map((a) => a.id), ["s-fev"]);
  });

  test("les ajustements restent à part des transactions et hors de la répartition par catégorie", () => {
    const vue = detail("marge_brute");
    assert.ok(vue.transactions.every((p) => p.sourceCategoryId === "Achats"));
    assert.deepEqual(vue.ajustementsDetail.map((a) => a.id), ["s-mars", "s-fev"]);
    assert.deepEqual(vue.structure!.parts.map((p) => p.nom), ["Achats"]);
    // L'écran EBITDA explore les coûts de structure : sa liste ne montre que la provision.
    assert.deepEqual(detail("ebitda").ajustementsDetail.map((a) => a.id), ["prov"]);
  });

  test("catégorie sélectionnée : l'indicateur porte sur elle seule, sans ajustement", () => {
    const vue = detail("marge_brute", { categorie: "Achats", mois: null });
    assert.equal(vue.kpi.montant, -630_000);
    assert.deepEqual(vue.ajustements.lignes, []);
    assert.deepEqual(vue.ajustementsDetail, []);
    assert.equal(vue.transactions.reduce((s, p) => s + p.montant, 0), vue.kpi.montant);
  });

  test("au plus 5 lignes dans le bloc, les plus significatives ; le reste est compté", () => {
    const nombreux = Array.from({ length: 7 }, (_, i) => ajustement(`n${i}`, "2026-03-31", (i + 1) * 100, "gross_margin", `Ajustement ${i}`));
    const vue = calculerDetail(parts, "marge_brute", { categorie: null, mois: null }, periode, nombreux);
    assert.deepEqual(vue.ajustements.lignes.map((l) => l.montant), [700, 600, 500, 400, 300]);
    assert.equal(vue.ajustements.nombreMasques, 2);
  });
});
