import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { calculerPnl } from "./pastPnl";
import { calculerDetail, partsMappees } from "./pastDetail";
import { comparerPeriodes, donneesPeriode } from "./pastVariance";
import { AjustementGestion } from "./pastAdjustments";
import { PastTransactionStockee } from "./pastTransactions";
import {
  calculerPnlEnBase,
  couvertureTva,
  estTauxTvaValide,
  libelleCouverture,
  montantHtEstime,
  partsEnBase,
  tauxParCategorie,
} from "./pastHtEstime";

const AXE = "229";
const PERIODE = { debut: "2026-03-01", fin: "2026-03-31" };

function mapping(id: string, pnlStage: MappingCategorie["pnlStage"], vatRate: number | null | undefined): MappingCategorie {
  return { sourceCategoryId: id, sourceCategoryName: id, sourceGroupId: AXE, pnlStage, vatRate };
}

let n = 0;
function tx(amount: number, parts: [string, number][], date = "2026-03-10"): PastTransactionStockee {
  return {
    id: `t${++n}`,
    sourceType: "pennylane",
    transactionDate: date,
    label: `Transaction ${n}`,
    amount,
    currency: "EUR",
    affectations: parts.map(([categoryId, weight]) => ({ groupId: AXE, categoryId, categoryName: categoryId, weight })),
  };
}

const proche = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

describe("conversion d'un montant", () => {
  test("1 200 € TTC à 20 % -> 1 000 € HT ; -1 200 € -> -1 000 € ; 1 100 € à 10 % -> 1 000 € ; 0 % -> inchangé", () => {
    proche(montantHtEstime(1_200, 20), 1_000);
    proche(montantHtEstime(-1_200, 20), -1_000);
    proche(montantHtEstime(1_100, 10), 1_000);
    proche(montantHtEstime(1_200, 0), 1_200);
  });

  test("0 % est un taux valide, distinct de « Non défini »", () => {
    assert.equal(estTauxTvaValide(0), true);
    assert.equal(estTauxTvaValide(null), false);
    assert.equal(estTauxTvaValide(undefined), false);
    assert.equal(estTauxTvaValide(-1), false);
    assert.equal(estTauxTvaValide(100), false);
    const taux = tauxParCategorie([mapping("zero", "revenue", 0), mapping("vide", "revenue", null)]);
    assert.equal(taux.get("zero"), 0);
    assert.equal(taux.get("vide"), null);
  });
});

describe("parts : conversion avant agrégation, une seule fois", () => {
  const mappings = indexerMappings([mapping("a", "revenue", 20), mapping("b", "revenue", 10), mapping("tva", "extra_pnl", 20)]);

  test("catégories à taux différents : 1 200 € à 20 % + 1 100 € à 10 % = 2 000 € HT", () => {
    const parts = partsEnBase(partsMappees([tx(1_200, [["a", 1]]), tx(1_100, [["b", 1]])], AXE, mappings), tauxParCategorie(mappings), "ht");
    proche(parts.reduce((s, p) => s + p.montant, 0), 2_000);
    assert.deepEqual(parts.map((p) => p.montantTtc), [1_200, 1_100]);
  });

  test("transaction répartie entre deux catégories : chaque part convertie à son propre taux", () => {
    const parts = partsEnBase(partsMappees([tx(2_400, [["a", 0.5], ["b", 0.5]])], AXE, mappings), tauxParCategorie(mappings), "ht");
    proche(parts[0].montant, 1_000); // 1 200 à 20 %
    proche(parts[1].montant, 1_200 / 1.1); // 1 200 à 10 %
  });

  test("étage de trésorerie (Extra P&L) : jamais converti", () => {
    const parts = partsEnBase(partsMappees([tx(-1_200, [["tva", 1]])], AXE, mappings), tauxParCategorie(mappings), "ht");
    assert.equal(parts[0].montant, -1_200);
  });

  test("une part déjà convertie n'est jamais reconvertie", () => {
    const une = partsEnBase(partsMappees([tx(1_200, [["a", 1]])], AXE, mappings), tauxParCategorie(mappings), "ht");
    assert.throws(() => partsEnBase(une, tauxParCategorie(mappings), "ht"));
  });

  test("lecture TTC : parts inchangées (aucune altération des données)", () => {
    const sources = partsMappees([tx(1_200, [["a", 1]])], AXE, mappings);
    const copie = JSON.parse(JSON.stringify(sources));
    assert.equal(partsEnBase(sources, tauxParCategorie(mappings), "ttc"), sources);
    partsEnBase(sources, tauxParCategorie(mappings), "ht");
    assert.deepEqual(sources, copie, "la conversion ne touche jamais les parts sources");
  });
});

describe("taux manquant : incomplet, jamais converti en silence", () => {
  const mappings = indexerMappings([mapping("a", "revenue", 20), mapping("inconnue", "revenue", null)]);

  test("couverture calculée sur les montants concernés, catégories nommées", () => {
    const parts = partsEnBase(partsMappees([tx(9_200, [["a", 1]]), tx(800, [["inconnue", 1]])], AXE, mappings), tauxParCategorie(mappings), "ht");
    const couverture = couvertureTva(parts);
    assert.equal(couverture.complete, false);
    proche(couverture.part!, 0.92);
    assert.deepEqual(couverture.categoriesSansTva.map((c) => [c.sourceCategoryId, c.montantTtc]), [["inconnue", 800]]);
    assert.equal(libelleCouverture(couverture), "TVA renseignée sur 92 % des montants concernés.");
    assert.equal(parts[1].montant, 800, "part sans taux : restée TTC, signalée, pas traitée comme 0 %");
    assert.equal(parts[1].tvaManquante, true);
  });

  test("couverture de 99,6 % : jamais affichée « 100 % »", () => {
    const parts = partsEnBase(partsMappees([tx(9_960, [["a", 1]]), tx(40, [["inconnue", 1]])], AXE, mappings), tauxParCategorie(mappings), "ht");
    assert.equal(libelleCouverture(couvertureTva(parts)), "TVA renseignée sur 99 % des montants concernés.");
  });

  test("P&L HT : l'indicateur concerné est marqué incomplet", () => {
    const pnl = calculerPnlEnBase([tx(1_200, [["a", 1]]), tx(500, [["inconnue", 1]])], AXE, mappings, [], "ht");
    assert.equal(pnl.couvertures!.ca.complete, false);
    assert.equal(pnl.couvertures!.ca.categoriesSansTva[0].sourceCategoryId, "inconnue");
  });
});

describe("P&L : soldes recalculés à partir de leurs composantes, trésorerie toujours TTC", () => {
  const mappings = indexerMappings([
    mapping("ventes", "revenue", 20),
    mapping("achats", "gross_margin", 20),
    mapping("pub", "contribution_margin", 20),
    mapping("loyer", "ebitda", 0),
    mapping("tva", "extra_pnl", null),
    mapping("emprunt", "financing", null),
  ]);
  const transactions = [
    tx(12_000, [["ventes", 1]]),
    tx(-6_000, [["achats", 1]]),
    tx(-1_200, [["pub", 1]]),
    tx(-1_000, [["loyer", 1]]),
    tx(-800, [["tva", 1]]),
    tx(5_000, [["emprunt", 1]]),
  ];
  const stock: AjustementGestion = { id: "s", date: "2026-03-31", label: "Variation de stock", montant: 500, etage: "gross_margin", type: "inventory_change", notes: null };
  const ttc = calculerPnlEnBase(transactions, AXE, mappings, [stock], "ttc");
  const ht = calculerPnlEnBase(transactions, AXE, mappings, [stock], "ht");

  test("lecture TTC strictement identique au reporting actuel", () => {
    const actuel = calculerPnl(transactions, AXE, mappings, [stock]);
    assert.deepEqual({ ...ttc, base: undefined, couvertures: undefined }, { ...actuel, base: undefined, couvertures: undefined });
  });

  test("Encaissements et coûts HT ; marges et EBITDA recalculés, variation de stock non convertie", () => {
    proche(ht.ca, 10_000);
    proche(ht.coutsDirects, -5_000);
    proche(ht.margeBrute, 10_000 - 5_000 + 500); // le stock entre tel quel, une seule fois
    proche(ht.margeContributive, ht.margeBrute - 1_000);
    proche(ht.ebitda, ht.margeContributive - 1_000); // loyer à 0 % : inchangé
    proche(ht.ratios.margeBrute!, 5_500 / 10_000);
    assert.equal(ttc.margeBrute, 12_000 - 6_000 + 500);
  });

  test("Cash flow opérationnel et Variation de trésorerie identiques en TTC et en HT", () => {
    assert.equal(ht.cashFlowOperationnel, ttc.cashFlowOperationnel);
    assert.equal(ht.variationTresorerie, ttc.variationTresorerie);
    assert.equal(ht.extraPnl, ttc.extraPnl);
    assert.equal(ht.financements, ttc.financements);
    assert.notEqual(ht.cashFlowOperationnel, ht.ebitda + ht.extraPnl, "jamais EBITDA HT + flux TTC");
  });

  test("changer de lecture n'altère aucune donnée", () => {
    const copie = JSON.parse(JSON.stringify(transactions));
    calculerPnlEnBase(transactions, AXE, mappings, [stock], "ht");
    calculerPnlEnBase(transactions, AXE, mappings, [stock], "ttc");
    assert.deepEqual(transactions, copie);
    assert.equal(stock.montant, 500);
  });

  test("écran de détail : KPI HT et couverture du périmètre, Cash flow sur parts TTC", () => {
    const partsTtc = partsMappees(transactions, AXE, mappings);
    const partsHt = partsEnBase(partsTtc, tauxParCategorie(mappings), "ht");
    const marge = calculerDetail(partsHt, "marge_brute", { categorie: null, mois: null }, PERIODE, [stock]);
    proche(marge.kpi.montant, 5_500);
    assert.equal(marge.couvertureKpi!.complete, true);
    const cashTtc = calculerDetail(partsTtc, "cash_flow", { categorie: null, mois: null }, PERIODE, [stock]);
    assert.equal(cashTtc.kpi.montant, ttc.cashFlowOperationnel);
    assert.equal(cashTtc.couvertureKpi, null);
  });

  test("Analyse d'écarts : porte sur le Cash flow, donc identique quelle que soit la lecture", () => {
    const a = donneesPeriode(transactions, AXE, mappings, [stock], PERIODE);
    const comparaison = comparerPeriodes(a, a);
    assert.equal(comparaison.cashFlowA, ttc.cashFlowOperationnel);
  });
});

describe("persistance par organisation", () => {
  test("le taux suit la catégorie de la correspondance, sans fuite d'une organisation à l'autre", () => {
    const orgA = indexerMappings([mapping("ventes", "revenue", 20)]);
    const orgB = indexerMappings([mapping("ventes", "revenue", 5.5)]);
    assert.equal(tauxParCategorie(orgA).get("ventes"), 20);
    assert.equal(tauxParCategorie(orgB).get("ventes"), 5.5);
  });
});

// --- Rendu de l'écran Général dans les deux lectures ---
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PasseGeneral from "../components/PasseGeneral";
import { EcartsVsCibles, ecartsVsCibles } from "./pastTargets";
import { MENTION_HT_ESTIME, MENTION_TTC } from "./format";

(globalThis as unknown as { React: typeof React }).React = React;
const texte = (html: string) =>
  html.replace(/<[^>]+>/g, "\n").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/[  ]/g, " ").split("\n").map((t) => t.trim()).filter(Boolean);

describe("écran Général : HT estimé jusqu'à l'EBITDA, trésorerie en TTC, objectifs dans la lecture active", () => {
  const mappings = indexerMappings([mapping("ventes", "revenue", 20), mapping("achats", "gross_margin", 20), mapping("tva", "extra_pnl", null)]);
  const transactions = [tx(12_000, [["ventes", 1]]), tx(-6_000, [["achats", 1]]), tx(-800, [["tva", 1]])];
  const cibles = ecartsVsCibles([], [], [], PERIODE);
  const rendre = (pnl: ReturnType<typeof calculerPnlEnBase>, c: EcartsVsCibles | null = cibles) =>
    texte(renderToStaticMarkup(React.createElement(PasseGeneral, { pnl, cibles: c, onOuvrir: () => {}, onDefinirCible: () => {}, onConfigurerTva: () => {}, teintes: new Map() })));

  test("lecture HT : « Encaissements HT estimé », « Cash flow opérationnel TTC », frontière explicite", () => {
    const lignes = rendre(calculerPnlEnBase(transactions, AXE, mappings, [], "ht"));
    const suivi = (libelle: string) => lignes[lignes.indexOf(libelle) + 1];
    assert.equal(suivi("Encaissements"), MENTION_HT_ESTIME);
    assert.equal(suivi("Marge brute"), MENTION_HT_ESTIME);
    assert.equal(suivi("Cash flow opérationnel"), MENTION_TTC);
    assert.equal(suivi("Variation de trésorerie"), MENTION_TTC);
    assert.ok(lignes.includes("Trésorerie : flux bancaires réels, toujours en TTC"));
    assert.ok(lignes.includes("10 000 €"));
    assert.ok(lignes.includes("5 200 €"), "cash flow : 12 000 − 6 000 − 800, en TTC");
  });

  test("objectifs : en HT, cible et écart HT ; en TTC, aucun objectif ni mention", () => {
    const objectifs = [{ id: "mb", type: "gross_margin_pct" as const, dimension: "ventes", validFrom: "2026-01-01", valeur: 40 }];
    const parts = (base: "ht" | "ttc") => partsEnBase(partsMappees(transactions, AXE, mappings), tauxParCategorie(mappings), base);
    const ht = rendre(calculerPnlEnBase(transactions, AXE, mappings, [], "ht"), ecartsVsCibles(objectifs, parts("ht"), [], PERIODE));
    // HT : CA 10 000, marge 5 000 (50 %), cible 40 % → 4 000 ; écart +1 000.
    assert.ok(ht.includes("Cible 40,0 %"));
    assert.ok(ht.some((t) => t.includes("+1 k€ vs cible")), ht.join(" | "));
    // TTC : ni cible, ni écart, ni « Définir une cible », ni mention des objectifs ; réalisé inchangé.
    const ttc = rendre(calculerPnlEnBase(transactions, AXE, mappings, [], "ttc"), null);
    assert.equal(ttc.some((t) => /Cible|vs cible|Définir une cible|Objectif EBITDA/.test(t)), false, ttc.join(" | "));
    assert.equal(ttc.some((t) => /objectif/i.test(t)), false);
    assert.ok(ttc.includes("12 000 €"));
    assert.throws(() => ecartsVsCibles(objectifs, parts("ttc"), [], PERIODE), /HT estimées uniquement/);
  });

  test("TVA manquante : « Incomplet » à la place du montant, catégorie nommée, pas de répartition HT", () => {
    const sansTaux = indexerMappings([mapping("ventes", "revenue", 20), mapping("achats", "gross_margin", null)]);
    const lignes = rendre(calculerPnlEnBase([tx(12_000, [["ventes", 1]]), tx(-6_000, [["achats", 1]])], AXE, sansTaux, [], "ht"));
    const suivi = (libelle: string) => lignes[lignes.indexOf(libelle) + 2];
    assert.equal(suivi("Encaissements"), "10 000 €", "Encaissements : couverts");
    assert.equal(suivi("Marge brute"), "Incomplet");
    assert.ok(lignes.some((t) => t.includes("TVA non définie pour achats")));
    assert.ok(lignes.some((t) => t.includes("Répartition HT non affichée")));
  });
});
