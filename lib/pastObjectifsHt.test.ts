import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { calculerDetail, partsMappees } from "./pastDetail";
import { BaseMontants, calculerPnlEnBase, LIBELLE_CASH_FLOW_TTC, partsEnBase, tauxParCategorie } from "./pastHtEstime";
import { calculerPnl } from "./pastPnl";
import {
  Cible,
  cibleDeCoutsDeStructure,
  ecartsVsCibles,
  LIBELLE_EBITDA_TVA_INCOMPLETE,
  LIBELLE_ECART_TVA_INCOMPLETE,
  poserCible,
  UNITE_COUTS_DE_STRUCTURE,
} from "./pastTargets";
import { chargerCibles, enregistrerCible, modifierCible } from "./pastTransactionsRepository";
import { PastTransactionStockee } from "./pastTransactions";
import PasseObjectifs from "../components/PasseObjectifs";
import PastDetailDashboard from "../components/PastDetailDashboard";

(globalThis as unknown as { React: typeof React }).React = React;

/**
 * Objectifs EXCLUSIVEMENT HT : définis et évalués sur les montants HT estimés. La lecture TTC
 * garde ses réalisations, sans aucune cible ni aucun écart.
 */

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
  mapping("B", "revenue", 10),
  mapping("C", "revenue", null),
  mapping("direct", "gross_margin", 20),
  mapping("structure", "ebitda", 20),
  mapping("structureSansTva", "ebitda", null),
  mapping("extra", "extra_pnl", null),
]);

const parts = (transactions: PastTransactionStockee[], base: BaseMontants) =>
  partsEnBase(partsMappees(transactions, AXE, MAPPINGS), tauxParCategorie(MAPPINGS), base);
const ecartsHt = (cibles: Cible[], transactions: PastTransactionStockee[], mois: string | null = null, periode = MARS) =>
  ecartsVsCibles(cibles, parts(transactions, "ht"), [], periode, mois);

const proche = (a: number | null | undefined, b: number, eps = 1e-6) => assert.ok(a !== null && a !== undefined && Math.abs(a - b) < eps, `${a} ≠ ${b}`);

let id = 0;
const marge = (type: "gross_margin_pct" | "contribution_margin_pct", categorie: string, valeur: number, validFrom = "2026-01-01"): Cible => ({
  id: `c${++id}`,
  type,
  dimension: categorie,
  validFrom,
  valeur,
});
const structure = (valeur: number, validFrom = "2026-01-01"): Cible => ({ id: `s${++id}`, type: "structure_cost_monthly", dimension: "", validFrom, valeur });

const texte = (html: string) =>
  html
    .replace(/<[^>]+>/g, "\n")
    .replace(/&#x27;/g, "'")
    .replace(/[  ]/g, " ")
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);

describe("calcul des objectifs : exclusivement HT", () => {
  test("marge : pourcentage cible, pondération et écart sur les encaissements HT", () => {
    // 120 000 TTC = 100 000 HT d'encaissements ; 66 000 TTC = 55 000 HT de coûts directs.
    const resultat = ecartsHt([marge("gross_margin_pct", "A", 50)], [tx(120_000, "A"), tx(-66_000, "direct")]);
    assert.equal(resultat.margeBrute!.cible, 0.5);
    proche(resultat.margeBrute!.ecartEuros, -5_000);
  });

  test("pondération par les encaissements HT : exemple A/B à 60 %, jamais 59,57 %", () => {
    const resultat = ecartsHt([marge("gross_margin_pct", "A", 50), marge("gross_margin_pct", "B", 70)], [tx(1_200, "A"), tx(1_100, "B")]);
    proche(resultat.margeBrute!.cible, 0.6);
  });

  test("filtres et dates d'effet conservés : mois filtré, version en vigueur à la date", () => {
    const versions = [marge("gross_margin_pct", "A", 50, "2026-01-01"), marge("gross_margin_pct", "A", 70, "2026-03-15")];
    // HT : 1 000 à 50 %, 2 000 à 70 %.
    proche(ecartsHt(versions, [tx(1_200, "A", "2026-03-10"), tx(2_400, "A", "2026-03-20")]).margeBrute!.cible, 1_900 / 3_000);
    const trimestre = { debut: "2026-03-01", fin: "2026-04-30" };
    const deuxMois = [tx(1_200, "A", "2026-03-10"), tx(1_100, "B", "2026-04-10")];
    const cibles = [marge("gross_margin_pct", "A", 50), marge("gross_margin_pct", "B", 70)];
    proche(ecartsHt(cibles, deuxMois, "2026-04", trimestre).margeBrute!.cible, 0.7);
  });

  test("couverture des objectifs : part des encaissements HT ayant un objectif", () => {
    proche(ecartsHt([marge("gross_margin_pct", "A", 50)], [tx(1_200, "A"), tx(1_100, "B")]).margeBrute!.couverture, 0.5);
  });

  test("coûts de structure : objectif mensuel HT face aux coûts HT (12 000 TTC = 10 000 HT)", () => {
    const resultat = ecartsHt([structure(10_000)], [tx(120_000, "A"), tx(-12_000, "structure")]);
    proche(resultat.coutsStructure!.cible, 10_000);
    proche(resultat.coutsStructure!.ecart, 0);
    proche(cibleDeCoutsDeStructure([structure(30_000)], { debut: "2026-04-01", fin: "2026-04-15" })!.valeur, 15_000);
  });

  test("EBITDA cible HT : 1 000 000 HT × 40 % − 250 000 HT = 150 000", () => {
    const resultat = ecartsHt([marge("contribution_margin_pct", "A", 40), structure(250_000)], [tx(1_200_000, "A")]);
    proche(resultat.ebitda!.cible, 150_000);
  });

  test("aucune comparaison ni conversion TTC : des parts TTC sont refusées", () => {
    assert.throws(() => ecartsVsCibles([marge("gross_margin_pct", "A", 50)], parts([tx(1_200, "A")], "ttc"), [], MARS), /HT estimées uniquement/);
    const source = readFileSync(path.resolve(__dirname, "pastTargets.ts"), "utf8");
    assert.equal(/amount_basis|baseDeLaCible|"ttc"/.test(source), false);
  });

  test("TVA manquante : écart indisponible, distinct d'une catégorie sans objectif", () => {
    const cibles = [marge("gross_margin_pct", "A", 50), marge("gross_margin_pct", "C", 40), marge("contribution_margin_pct", "A", 40), structure(1_000)];
    const resultat = ecartsHt(cibles, [tx(1_200, "A"), tx(500, "C"), tx(-1_000, "structureSansTva")]);
    assert.equal(resultat.margeBrute, null);
    assert.equal(resultat.indisponibles.margeBrute, LIBELLE_ECART_TVA_INCOMPLETE);
    assert.equal(resultat.ebitda, null);
    assert.equal(resultat.indisponibles.ebitda, LIBELLE_EBITDA_TVA_INCOMPLETE);
    // Catégorie B sans objectif mais avec TVA : pas de motif TVA, seulement une couverture partielle.
    const sansObjectif = ecartsHt([marge("gross_margin_pct", "A", 50)], [tx(1_200, "A"), tx(1_100, "B")]);
    assert.equal(sansObjectif.indisponibles.margeBrute, null);
    assert.ok(sansObjectif.margeBrute!.couverture < 1);
  });
});

describe("objectifs existants et saisie", () => {
  test("objectifs historiques : valeurs et dates d'effet lues telles quelles, rien de converti", async () => {
    const lignes = [
      { id: "1", target_type: "structure_cost_monthly", dimension_key: "", valid_from: "2026-01-01", target_value: 85000, comment: "loyer" },
      { id: "2", target_type: "gross_margin_pct", dimension_key: "A", valid_from: "2025-10-01", target_value: 52.2 },
    ];
    const ecrits: Record<string, unknown>[] = [];
    const requete = {
      select: () => requete,
      eq: () => Promise.resolve({ data: lignes, error: null }),
      insert: (ligne: Record<string, unknown>) => {
        ecrits.push(ligne);
        return { select: () => ({ single: () => Promise.resolve({ data: { id: "nouveau" }, error: null }) }) };
      },
      update: (ligne: Record<string, unknown>) => {
        ecrits.push(ligne);
        const chaine = { eq: () => chaine, select: () => Promise.resolve({ data: [{ id: "1" }], error: null }) };
        return chaine;
      },
    };
    const supabase = { from: () => requete } as unknown as Parameters<typeof chargerCibles>[0];
    const cibles = await chargerCibles(supabase, "org");
    assert.deepEqual(
      cibles.map((c) => [c.type, c.validFrom, c.valeur, c.commentaire]),
      [
        ["structure_cost_monthly", "2026-01-01", 85000, "loyer"],
        ["gross_margin_pct", "2025-10-01", 52.2, null],
      ]
    );
    await enregistrerCible(supabase, "org", "structure_cost_monthly", "", "2026-03-01", 9_000);
    await modifierCible(supabase, "org", "1", { valeur: 86_000, validFrom: "2026-01-01" });
    assert.equal(ecrits.length, 2);
    assert.ok(ecrits.every((ligne) => !("amount_basis" in ligne)));
  });

  test("nouvel objectif de structure : aucune base à choisir, un montant HT", () => {
    const pose = poserCible([], { type: "structure_cost_monthly", dimension: "", validFrom: "2026-03-01" }, 10_000, "p");
    assert.deepEqual(Object.keys(pose.cibles[0]).sort(), ["commentaire", "dimension", "id", "type", "valeur", "validFrom"]);
    assert.equal(UNITE_COUTS_DE_STRUCTURE, "€ HT / mois");
  });

  test("onglet Objectifs : montants saisis en HT, aucun sélecteur ni mention TTC", () => {
    const html = renderToStaticMarkup(
      React.createElement(PasseObjectifs, {
        cibles: [marge("gross_margin_pct", "A", 50), structure(10_000)],
        categoriesCa: [{ id: "A", nom: "A" }],
        dateParDefaut: "2026-03-01",
        erreur: null,
        onPoser: () => {},
        onCorriger: () => {},
        onRemplacer: () => {},
        onCommenter: () => {},
        onSupprimer: () => {},
      })
    ).replace(/[  ]/g, " ");
    assert.ok(html.includes("10 000 € HT / mois"));
    assert.ok(html.includes("Montants mensuels saisis en HT."));
    assert.equal(/\bTTC\b|aria-pressed|Base du montant/.test(html), false);
    assert.equal(/50 % HT/.test(html), false, "pas de mention sur les pourcentages");
  });

  test("onglet Objectifs accessible dans les deux lectures ; Analyse d'écarts indépendante des objectifs", () => {
    const source = readFileSync(path.resolve(__dirname, "../components/PasseTransactions.tsx"), "utf8");
    assert.match(source, /\) : vue === "objectifs" \? \(\s*<PasseObjectifs/);
    const debut = source.indexOf("<PasseEcarts");
    const ecarts = source.slice(debut, source.indexOf("/>", debut));
    assert.equal(/\bbase\b|cibles/.test(ecarts), false);
  });
});

describe("écrans de détail : objectifs en HT seulement, Cash flow toujours TTC", () => {
  const transactions = [tx(120_000, "A"), tx(-66_000, "direct"), tx(-800, "extra")];
  const cibles = [marge("gross_margin_pct", "A", 50)];
  const rendre = (metrique: "marge_brute" | "cash_flow", base: BaseMontants, avecCibles: boolean) =>
    texte(
      renderToStaticMarkup(
        React.createElement(PastDetailDashboard, {
          metrique,
          parts: parts(transactions, metrique === "cash_flow" ? "ttc" : base),
          periode: MARS,
          ajustements: [],
          teintes: new Map(),
          base: metrique === "cash_flow" ? "ttc" : base,
          cibles: avecCibles ? cibles : undefined,
        })
      )
    );

  test("HT : cible et écart affichés", () => {
    const lignes = rendre("marge_brute", "ht", true);
    assert.ok(lignes.includes("Cible 50,0 %"), lignes.join(" | "));
    assert.ok(lignes.some((t) => t.includes("vs cible")));
  });

  test("TTC : réalisé TTC, aucun objectif, aucun emplacement vide", () => {
    const lignes = rendre("marge_brute", "ttc", false);
    assert.equal(lignes.some((t) => /Cible|vs cible|Aucune cible|Définir/.test(t)), false, lignes.join(" | "));
    assert.ok(lignes.some((t) => t.startsWith("54 000")), "marge brute TTC inchangée");
  });

  test("Cash flow : TTC dans les deux lectures, sans cible, mention conservée", () => {
    for (const base of ["ht", "ttc"] as const) {
      const lignes = rendre("cash_flow", base, false);
      assert.ok(lignes.includes(LIBELLE_CASH_FLOW_TTC));
      assert.equal(lignes.some((t) => /Cible|vs cible/.test(t)), false);
    }
    const ht = calculerPnlEnBase(transactions, AXE, MAPPINGS, [], "ht");
    const ttc = calculerPnlEnBase(transactions, AXE, MAPPINGS, [], "ttc");
    assert.equal(ht.cashFlowOperationnel, ttc.cashFlowOperationnel);
    assert.equal(ht.variationTresorerie, ttc.variationTresorerie);
  });

  test("TTC : réalisations inchangées (mêmes chiffres que le P&L d'origine)", () => {
    const { base: _base, couvertures: _couvertures, ...ttc } = calculerPnlEnBase(transactions, AXE, MAPPINGS, [], "ttc");
    assert.deepEqual(ttc, calculerPnl(transactions, AXE, MAPPINGS, []));
    assert.equal(calculerDetail(parts(transactions, "ttc"), "ca", { categorie: null, mois: null }, MARS, []).kpi.montant, 120_000);
  });
});
