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

  test("Extra P&L : converti au taux de sa catégorie ; Virements internes & Financement : jamais converti", () => {
    const parts = partsEnBase(partsMappees([tx(-1_200, [["tva", 1]])], AXE, mappings), tauxParCategorie(mappings), "ht");
    proche(parts[0].montant, -1_000);
    const financement = indexerMappings([mapping("emprunt", "financing", 20)]);
    const partsFinancement = partsEnBase(partsMappees([tx(5_000, [["emprunt", 1]])], AXE, financement), tauxParCategorie(financement), "ht");
    assert.equal(partsFinancement[0].montant, 5_000);
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

describe("P&L : soldes recalculés à partir de leurs composantes ; en HT, arrêt au Cash flow opérationnel HT", () => {
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

  test("HT : Cash flow opérationnel = EBITDA HT + Extra P&L HT, jamais le Cash flow TTC renommé", () => {
    // Extra P&L sans taux : marqué incomplet, jamais repris en TTC à la place.
    assert.equal(ht.couvertures!.cashFlowOperationnel.complete, false);
    assert.equal(ht.couvertures!.ebitda.complete, true);
    const avecTaux = indexerMappings([...mappings.values()].map((m) => (m.sourceCategoryId === "tva" ? { ...m, vatRate: 0 } : m)));
    const htComplet = calculerPnlEnBase(transactions, AXE, avecTaux, [stock], "ht");
    assert.equal(htComplet.couvertures!.cashFlowOperationnel.complete, true);
    proche(htComplet.cashFlowOperationnel, htComplet.ebitda + htComplet.extraPnl);
    assert.notEqual(htComplet.cashFlowOperationnel, ttc.cashFlowOperationnel);
    // Financement exclu : l'emprunt de 5 000 € n'y entre pas.
    proche(htComplet.cashFlowOperationnel, htComplet.ebitda - 800);
    // TTC : trésorerie complète, inchangée.
    assert.equal(ttc.cashFlowOperationnel, ttc.ebitda + ttc.extraPnl);
    assert.equal(ttc.variationTresorerie, ttc.cashFlowOperationnel + ttc.financements);
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

describe("écran Général : HT estimé jusqu'au Cash flow opérationnel HT, objectifs dans la lecture active", () => {
  const mappings = indexerMappings([mapping("ventes", "revenue", 20), mapping("achats", "gross_margin", 20), mapping("tva", "extra_pnl", 0)]);
  const transactions = [tx(12_000, [["ventes", 1]]), tx(-6_000, [["achats", 1]]), tx(-800, [["tva", 1]])];
  const cibles = ecartsVsCibles([], [], [], PERIODE);
  const rendre = (pnl: ReturnType<typeof calculerPnlEnBase>, c: EcartsVsCibles | null = cibles) =>
    texte(renderToStaticMarkup(React.createElement(PasseGeneral, { pnl, cibles: c, onOuvrir: () => {}, onDefinirCible: () => {}, onConfigurerTva: () => {}, teintes: new Map() })));

  test("lecture HT : dernier résultat chiffré = Cash flow opérationnel HT ; financement vide ; « Voir onglet TTC »", () => {
    const lignes = rendre(calculerPnlEnBase(transactions, AXE, mappings, [], "ht"));
    const suivi = (libelle: string, decalage = 1) => lignes[lignes.indexOf(libelle) + decalage];
    assert.equal(suivi("Encaissements"), MENTION_HT_ESTIME);
    assert.equal(suivi("Marge brute"), MENTION_HT_ESTIME);
    assert.equal(suivi("Cash flow opérationnel"), MENTION_HT_ESTIME);
    assert.equal(suivi("Cash flow opérationnel", 2), "4 200 €", "10 000 − 5 000 − 800 (Extra P&L à 0 %)");
    // Virements internes & Financement : libellé seul, cellule vide (ni 0 €, ni tiret).
    assert.equal(suivi("Virements internes & Financement"), "Variation de trésorerie");
    // Variation de trésorerie : exactement « Voir onglet TTC », sans montant ni mention.
    assert.equal(suivi("Variation de trésorerie"), `Voir onglet ${MENTION_TTC}`);
    assert.equal(lignes.includes("5 200 €"), false, "aucun montant TTC de trésorerie en lecture HT");
  });

  test("lecture TTC : trésorerie complète, montants réaffichés", () => {
    const lignes = rendre(calculerPnlEnBase([...transactions, tx(5_000, [["emprunt", 1]])], AXE, indexerMappings([...mappings.values(), mapping("emprunt", "financing", null)]), [], "ttc"));
    const suivi = (libelle: string, decalage = 1) => lignes[lignes.indexOf(libelle) + decalage];
    assert.equal(suivi("Cash flow opérationnel"), MENTION_TTC);
    assert.equal(suivi("Cash flow opérationnel", 2), "5 200 €");
    assert.equal(suivi("Virements internes & Financement"), "5 000 €");
    assert.equal(suivi("Variation de trésorerie", 2), "10 200 €");
  });

  test("lecture HT : Extra P&L sans taux, Cash flow opérationnel HT « Incomplet », jamais repris en TTC", () => {
    const sansTaux = indexerMappings([...mappings.values()].map((m) => (m.sourceCategoryId === "tva" ? { ...m, vatRate: null } : m)));
    const lignes = rendre(calculerPnlEnBase(transactions, AXE, sansTaux, [], "ht"));
    assert.equal(lignes[lignes.indexOf("Cash flow opérationnel") + 2], "Incomplet");
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

describe("étage TVA — exclu du HT estimé, conservé en TTC et dans la trésorerie", () => {
  // Activité : 12 000 € TTC encaissés (20 %), 2 400 € TTC de loyer (20 %), et des mouvements de TVA :
  // un paiement de -12 000 € et un remboursement de +3 000 €, sans taux (aucun n'est requis).
  const mappings = indexerMappings([mapping("ventes", "revenue", 20), mapping("loyer", "ebitda", 20), mapping("tva", "vat", null), mapping("divers", "extra_pnl", null)]);
  const activite = [tx(12_000, [["ventes", 1]]), tx(-2_400, [["loyer", 1]])];
  const mouvementsTva = [tx(-12_000, [["tva", 1]]), tx(3_000, [["tva", 1]])];
  const transactions = [...activite, ...mouvementsTva];

  test("HT estimé : paiement et remboursement exclus des montants, des soldes et des répartitions", () => {
    const ht = calculerPnlEnBase(transactions, AXE, mappings, [], "ht");
    const htSansTva = calculerPnlEnBase(activite, AXE, mappings, [], "ht");
    proche(ht.ca, 10_000);
    proche(ht.ebitda, 8_000);
    assert.deepEqual([ht.ca, ht.margeBrute, ht.ebitda], [htSansTva.ca, htSansTva.margeBrute, htSansTva.ebitda]);
    assert.equal(ht.categories.some((c) => c.etage === "vat"), false);
    // Jamais divisés par un taux : ils ne sont tout simplement pas dans les parts HT.
    const parts = partsEnBase(partsMappees(transactions, AXE, mappings), tauxParCategorie(mappings), "ht");
    assert.equal(parts.some((p) => p.etage === "vat"), false);
  });

  test("TTC : mouvements de TVA présents, montants et signes réels, sur leur propre ligne", () => {
    const ttc = calculerPnlEnBase(transactions, AXE, mappings, [], "ttc");
    assert.equal(ttc.tva, -9_000);
    assert.equal(ttc.extraPnl, 0);
    assert.equal(ttc.ebitda, 9_600);
    assert.equal(ttc.categories.find((c) => c.sourceCategoryId === "tva")?.montant, -9_000);
  });

  test("trésorerie TTC : TVA comprise ; Cash flow opérationnel HT : TVA exclue", () => {
    const ttc = calculerPnlEnBase(transactions, AXE, mappings, [], "ttc");
    const ht = calculerPnlEnBase(transactions, AXE, mappings, [], "ht");
    assert.equal(ttc.cashFlowOperationnel, 9_600 - 9_000);
    assert.equal(ttc.variationTresorerie, 600);
    // HT : le Cash flow opérationnel HT estimé exclut la TVA (EBITDA HT 8 000 + Extra P&L HT 0).
    proche(ht.cashFlowOperationnel, 8_000);
  });

  test("écran Cash flow : TVA incluse hors financement comme financement compris", () => {
    const parts = partsMappees(transactions, AXE, mappings);
    for (const financementCompris of [false, true]) {
      const vue = calculerDetail(parts, "cash_flow", { categorie: null, mois: null }, PERIODE, [], { financementCompris });
      assert.equal(vue.kpi.montant, 600, `financementCompris=${financementCompris}`);
      assert.equal(vue.transactions.filter((p) => p.etage === "vat").length, 2);
    }
  });

  test("remapper une catégorie d'Extra P&L vers TVA : totaux TTC et trésorerie inchangés, jamais comptée deux fois", () => {
    const enExtra = indexerMappings([mapping("ventes", "revenue", 20), mapping("loyer", "ebitda", 20), mapping("tva", "extra_pnl", null)]);
    const avant = calculerPnl(transactions, AXE, enExtra);
    const apres = calculerPnl(transactions, AXE, mappings);
    assert.equal(apres.cashFlowOperationnel, avant.cashFlowOperationnel);
    assert.equal(apres.variationTresorerie, avant.variationTresorerie);
    assert.equal(apres.ebitda, avant.ebitda);
    assert.deepEqual([avant.extraPnl, avant.tva], [-9_000, 0]);
    assert.deepEqual([apres.extraPnl, apres.tva], [0, -9_000]);
    assert.equal(apres.ebitda + apres.extraPnl + apres.tva, apres.cashFlowOperationnel);
  });

  test("aucun taux requis : la catégorie TVA ne rend pas la couverture HT incomplète", () => {
    const ht = calculerPnlEnBase(transactions, AXE, mappings, [], "ht");
    for (const indicateur of ["ca", "margeBrute", "margeContributive", "ebitda"] as const) {
      assert.equal(ht.couvertures![indicateur].complete, true, indicateur);
    }
  });

  test("analyse d'écarts (Cash flow, TTC) : la TVA est une contribution distincte, réconciliation exacte", () => {
    const a = donneesPeriode(activite, AXE, mappings, [], PERIODE);
    const b = donneesPeriode(transactions, AXE, mappings, [], PERIODE);
    const comparaison = comparerPeriodes(a, b);
    assert.equal(comparaison.variationTva, -9_000);
    assert.equal(comparaison.etages.find((e) => e.etage === "vat")?.contribution, -9_000);
    proche(comparaison.etages.reduce((s, e) => s + e.contribution, 0), comparaison.ecart);
    proche(comparaison.variationEbitda + comparaison.variationExtraPnl + comparaison.variationTva + comparaison.variationFinancements, comparaison.ecart);
    // Sans mouvement de TVA sur aucune des deux périodes : pas de marche « TVA : 0 ».
    assert.equal(comparerPeriodes(a, a).etages.some((e) => e.etage === "vat"), false);
  });

  test("aucune transaction source modifiée : seule la lecture change", () => {
    const copie = JSON.stringify(transactions);
    calculerPnlEnBase(transactions, AXE, mappings, [], "ht");
    calculerPnlEnBase(transactions, AXE, mappings, [], "ttc");
    assert.equal(JSON.stringify(transactions), copie);
  });
});
