import { test, describe } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { calculerDetail, partsMappees } from "./pastDetail";
import { BaseMontants, calculerPnlEnBase, partsEnBase, tauxParCategorie } from "./pastHtEstime";
import {
  baseDeLaCible,
  Cible,
  cibleDeCoutsDeStructure,
  cibleDeMarge,
  ecartsVsCibles,
  LIBELLE_ECART_TVA_INCOMPLETE,
  libelleObjectifDefiniEn,
  poserCible,
  remplacerCible,
  corrigerCible,
  RevenuCible,
} from "./pastTargets";
import { chargerCibles, enregistrerCible } from "./pastTransactionsRepository";
import { PastTransactionStockee } from "./pastTransactions";
import { MENTION_TTC } from "./format";
import PasseObjectifs from "../components/PasseObjectifs";

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
  mapping("B", "revenue", 10),
  mapping("C", "revenue", null),
  mapping("direct", "gross_margin", 20),
  mapping("pub", "contribution_margin", 20),
  mapping("structure", "ebitda", 20),
  mapping("structureSansTva", "ebitda", null),
  mapping("extra", "extra_pnl", null),
]);

const parts = (transactions: PastTransactionStockee[], base: BaseMontants) =>
  partsEnBase(partsMappees(transactions, AXE, MAPPINGS), tauxParCategorie(MAPPINGS), base);
const ecarts = (cibles: Cible[], transactions: PastTransactionStockee[], base: BaseMontants, mois: string | null = null, periode = MARS) =>
  ecartsVsCibles(cibles, parts(transactions, base), [], periode, mois, base);

const proche = (a: number | null | undefined, b: number, eps = 1e-6) => assert.ok(a !== null && a !== undefined && Math.abs(a - b) < eps, `${a} ≠ ${b}`);

let id = 0;
const marge = (type: "gross_margin_pct" | "contribution_margin_pct", categorie: string, valeur: number, validFrom = "2026-01-01"): Cible => ({
  id: `c${++id}`,
  type,
  dimension: categorie,
  validFrom,
  valeur,
});
const structure = (valeur: number, base: BaseMontants | null | undefined, validFrom = "2026-01-01"): Cible => ({
  id: `s${++id}`,
  type: "structure_cost_monthly",
  dimension: "",
  validFrom,
  valeur,
  ...(base === undefined ? {} : { base }),
});

describe("objectifs de marge : même pourcentage, base monétaire du mode actif", () => {
  // TTC : 120 000 d'encaissements, 66 000 de coûts directs → marge 54 000 (45 %).
  // HT : 100 000 et 55 000 → marge 45 000 (45 %).
  const transactions = [tx(120_000, "A"), tx(-66_000, "direct")];
  const cibles = [marge("gross_margin_pct", "A", 50)];

  test("même objectif de marge brute % en TTC et en HT", () => {
    assert.equal(ecarts(cibles, transactions, "ttc").margeBrute!.cible, 0.5);
    assert.equal(ecarts(cibles, transactions, "ht").margeBrute!.cible, 0.5);
  });

  test("cible monétaire différente selon le mode : 60 000 TTC, 50 000 HT", () => {
    const caTtc = calculerDetail(parts(transactions, "ttc"), "ca", { categorie: null, mois: null }, MARS, []).kpi.montant;
    const caHt = calculerDetail(parts(transactions, "ht"), "ca", { categorie: null, mois: null }, MARS, []).kpi.montant;
    proche(caTtc * ecarts(cibles, transactions, "ttc").margeBrute!.cible, 60_000);
    proche(caHt * ecarts(cibles, transactions, "ht").margeBrute!.cible, 50_000);
  });

  test("écart recalculé dans la base : -6 000 TTC, -5 000 HT", () => {
    proche(ecarts(cibles, transactions, "ttc").margeBrute!.ecartEuros, -6_000);
    proche(ecarts(cibles, transactions, "ht").margeBrute!.ecartEuros, -5_000);
    assert.equal(ecarts(cibles, transactions, "ht").base, "ht");
  });
});

describe("pondération par catégorie d'encaissements", () => {
  // Exemple de la consigne : A 1 200 TTC (20 %) = 1 000 HT, objectif 50 % ; B 1 100 TTC (10 %) = 1 000 HT, objectif 70 %.
  const transactions = [tx(1_200, "A"), tx(1_100, "B")];
  const cibles = [marge("gross_margin_pct", "A", 50), marge("gross_margin_pct", "B", 70)];

  test("exemple A/B : 59,57 % en TTC, 60 % en HT", () => {
    const ttc = ecarts(cibles, transactions, "ttc").margeBrute!.cible;
    const ht = ecarts(cibles, transactions, "ht").margeBrute!.cible;
    proche(ttc, (1_200 * 0.5 + 1_100 * 0.7) / 2_300);
    assert.equal(Math.round(ttc * 10_000) / 100, 59.57);
    proche(ht, 0.6);
  });

  test("pondération TTC vs HT : jamais d'objectif HT calculé avec des poids TTC", () => {
    const revenus = (base: BaseMontants): RevenuCible[] =>
      parts(transactions, base).map((p) => ({ date: p.transactionDate, montant: p.montant, categorie: p.sourceCategoryId }));
    proche(cibleDeMarge(cibles, "gross_margin_pct", revenus("ht"))!.valeur, 0.6);
    assert.notEqual(cibleDeMarge(cibles, "gross_margin_pct", revenus("ttc"))!.valeur, 0.6);
  });

  test("filtrage par catégorie : la catégorie seule porte son propre objectif, son montant dans la base", () => {
    const seulementA = (base: BaseMontants) => parts(transactions, base).filter((p) => p.sourceCategoryId === "A");
    proche(calculerDetail(parts(transactions, "ht"), "ca", { categorie: "A", mois: null }, MARS, []).kpi.montant, 1_000);
    proche(calculerDetail(parts(transactions, "ttc"), "ca", { categorie: "A", mois: null }, MARS, []).kpi.montant, 1_200);
    for (const base of ["ht", "ttc"] as const) {
      proche(ecartsVsCibles(cibles, seulementA(base), [], MARS, null, base).margeBrute!.cible, 0.5);
    }
  });

  test("filtrage par mois : seuls les encaissements du mois pondèrent, dans la base", () => {
    const deuxMois = [tx(1_200, "A", "2026-03-10"), tx(1_100, "B", "2026-04-10")];
    const trimestre = { debut: "2026-03-01", fin: "2026-04-30" };
    proche(ecarts(cibles, deuxMois, "ht", "2026-03", trimestre).margeBrute!.cible, 0.5);
    proche(ecarts(cibles, deuxMois, "ht", "2026-04", trimestre).margeBrute!.cible, 0.7);
    proche(ecarts(cibles, deuxMois, "ht", null, trimestre).margeBrute!.cible, 0.6);
  });

  test("versions datées : chaque encaissement HT suit l'objectif en vigueur à sa date", () => {
    const versions = [marge("gross_margin_pct", "A", 50, "2026-01-01"), marge("gross_margin_pct", "A", 70, "2026-03-15")];
    const avantApres = [tx(1_200, "A", "2026-03-10"), tx(2_400, "A", "2026-03-20")];
    // HT : 1 000 à 50 %, 2 000 à 70 % → (500 + 1 400) / 3 000.
    proche(ecarts(versions, avantApres, "ht").margeBrute!.cible, 1_900 / 3_000);
  });

  test("couverture partielle des objectifs : part des encaissements de la base couverte", () => {
    const sansObjectifB = [marge("gross_margin_pct", "A", 50)];
    proche(ecarts(sansObjectifB, transactions, "ht").margeBrute!.couverture, 0.5);
    proche(ecarts(sansObjectifB, transactions, "ttc").margeBrute!.couverture, 1_200 / 2_300);
  });

  test("couverture partielle de TVA : écart indisponible en HT, distinct de la couverture des objectifs", () => {
    const avecC = [...transactions, tx(500, "C")];
    const cibleTotale = [...cibles, marge("gross_margin_pct", "C", 40)];
    const ht = ecarts(cibleTotale, avecC, "ht");
    assert.equal(ht.margeBrute, null);
    assert.equal(ht.indisponibles.margeBrute, LIBELLE_ECART_TVA_INCOMPLETE);
    // Les objectifs, eux, couvrent tout : seule la TVA manque. En TTC, rien ne bloque.
    const ttc = ecarts(cibleTotale, avecC, "ttc");
    assert.equal(ttc.margeBrute!.couverture, 1);
    assert.equal(ttc.indisponibles.margeBrute, null);
  });
});

describe("objectifs de coûts de structure : base explicite, jamais convertie", () => {
  // Mars : 12 000 TTC de coûts de structure à 20 % = 10 000 HT.
  const transactions = [tx(120_000, "A"), tx(-12_000, "structure")];

  test("objectif de structure HT : comparé en HT, « Objectif défini en HT » en TTC", () => {
    const cibles = [structure(10_000, "ht")];
    const ht = ecarts(cibles, transactions, "ht");
    proche(ht.coutsStructure!.cible, 10_000);
    proche(ht.coutsStructure!.ecart, 0);
    const ttc = ecarts(cibles, transactions, "ttc");
    assert.equal(ttc.coutsStructure, null);
    assert.equal(ttc.indisponibles.coutsStructure, libelleObjectifDefiniEn("ht"));
    assert.equal(libelleObjectifDefiniEn("ht"), "Objectif défini en HT");
  });

  test("objectif de structure TTC : comparé en TTC, « Objectif défini en TTC » en HT", () => {
    const cibles = [structure(12_000, "ttc")];
    proche(ecarts(cibles, transactions, "ttc").coutsStructure!.ecart, 0);
    const ht = ecarts(cibles, transactions, "ht");
    assert.equal(ht.coutsStructure, null);
    assert.equal(ht.indisponibles.coutsStructure, `Objectif défini en ${MENTION_TTC}`);
  });

  test("objectif historique (sans base) : conserve sa signification TTC", () => {
    const historique = structure(12_000, undefined);
    assert.equal(baseDeLaCible(historique), "ttc");
    assert.equal(baseDeLaCible(structure(12_000, null)), "ttc");
    proche(ecarts([historique], transactions, "ttc").coutsStructure!.cible, 12_000);
    assert.equal(ecarts([historique], transactions, "ht").coutsStructure, null);
  });

  test("aucune conversion arbitraire : un objectif TTC n'existe pas en HT, ni divisé par 1,2", () => {
    const cibles = [structure(12_000, "ttc")];
    assert.equal(cibleDeCoutsDeStructure(cibles, MARS, "ht"), null);
    proche(cibleDeCoutsDeStructure(cibles, MARS, "ttc")!.valeur, 12_000);
    const ht = ecarts(cibles, transactions, "ht");
    assert.equal(ht.coutsStructure, null, "pas de cible HT de 10 000 inventée");
    proche(ht.montantCoutsStructure, -10_000);
  });

  test("chargement : NULL en base = objectif historique, base lue sinon ; écriture explicite", async () => {
    const lignes = [
      { id: "1", target_type: "structure_cost_monthly", dimension_key: "", valid_from: "2026-01-01", target_value: 12000, amount_basis: null },
      { id: "2", target_type: "structure_cost_monthly", dimension_key: "", valid_from: "2026-02-01", target_value: 10000, amount_basis: "ht" },
      { id: "3", target_type: "gross_margin_pct", dimension_key: "A", valid_from: "2026-01-01", target_value: 50 },
    ];
    let insere: Record<string, unknown> | null = null;
    const requete = {
      select: () => requete,
      eq: () => Promise.resolve({ data: lignes, error: null }),
      insert: (ligne: Record<string, unknown>) => {
        insere = ligne;
        return { select: () => ({ single: () => Promise.resolve({ data: { id: "nouveau" }, error: null }) }) };
      },
    };
    const supabase = { from: () => requete } as unknown as Parameters<typeof chargerCibles>[0];
    const cibles = await chargerCibles(supabase, "org");
    assert.deepEqual(
      cibles.map((c) => [c.id, c.base, baseDeLaCible(c)]),
      [
        ["1", null, "ttc"],
        ["2", "ht", "ht"],
        ["3", null, "ttc"],
      ]
    );
    await enregistrerCible(supabase, "org", "structure_cost_monthly", "", "2026-03-01", 9_000, "ht");
    assert.equal(insere!.amount_basis, "ht");
    await enregistrerCible(supabase, "org", "gross_margin_pct", "A", "2026-03-01", 50);
    assert.equal("amount_basis" in insere!, false, "une marge n'a pas de base");
  });

  test("nouvel objectif : HT par défaut ; une correction garde sa base ; un remplacement la transmet", () => {
    const pose = poserCible([], { type: "structure_cost_monthly", dimension: "", validFrom: "2026-03-01" }, 10_000, "p");
    assert.equal(pose.cibles[0].base, "ht");
    const marge50 = poserCible([], { type: "gross_margin_pct", dimension: "A", validFrom: "2026-03-01" }, 50, "m");
    assert.equal(marge50.cibles[0].base, undefined, "pas de base pour un pourcentage");

    const historique = structure(12_000, undefined, "2026-01-01");
    const corrigee = corrigerCible([historique], historique.id, { valeur: 13_000, validFrom: "2026-01-01" });
    assert.equal(baseDeLaCible(corrigee.cibles!.find((c) => c.id === historique.id)!), "ttc");
    assert.equal("base" in corrigee.operations![0], false, "la base n'est pas réécrite");

    // Même date, base différente : la version en place change de base explicitement.
    const memeDate = poserCible([historique], { type: "structure_cost_monthly", dimension: "", validFrom: "2026-01-01" }, 10_000, "x", "ht");
    assert.deepEqual(memeDate.operations, [{ type: "update", id: historique.id, valeur: 10_000, validFrom: "2026-01-01", base: "ht" }]);

    const enHt = structure(10_000, "ht", "2026-02-01");
    const remplace = remplacerCible([historique, enHt], enHt.id, { valeur: 10_000, validFrom: "2026-01-01" });
    assert.equal(remplace.cibles[0].base, "ht");
    assert.equal(remplace.operations[0].type === "update" && remplace.operations[0].base, "ht");
  });
});

describe("EBITDA cible : cible contributive × encaissements − coûts de structure cibles, même base", () => {
  // Encaissements : 1 200 000 TTC = 1 000 000 HT ; marge contributive cible 40 %.
  const transactions = [tx(1_200_000, "A")];
  const contributive = marge("contribution_margin_pct", "A", 40);

  test("EBITDA cible HT : 400 000 − 250 000 = 150 000", () => {
    const resultat = ecarts([contributive, structure(250_000, "ht")], transactions, "ht");
    proche(resultat.ebitda!.cible, 150_000);
    assert.equal(resultat.indisponibles.ebitda, null);
  });

  test("EBITDA cible TTC : 480 000 − 300 000 = 180 000", () => {
    proche(ecarts([contributive, structure(300_000, "ttc")], transactions, "ttc").ebitda!.cible, 180_000);
  });

  test("EBITDA cible indisponible si les composantes sont incompatibles, avec la raison", () => {
    const resultat = ecarts([contributive, structure(300_000, "ttc")], transactions, "ht");
    assert.equal(resultat.ebitda, null);
    assert.equal(resultat.ebitdaIncomplet, false);
    assert.match(resultat.indisponibles.ebitda!, /indisponible.*définis en TTC/);
  });

  test("EBITDA cible indisponible si la TVA manque sur une composante, en HT seulement", () => {
    const avecCoutSansTva = [...transactions, tx(-1_000, "structureSansTva")];
    const ht = ecarts([contributive, structure(250_000, "ht")], avecCoutSansTva, "ht");
    assert.equal(ht.ebitda, null);
    assert.match(ht.indisponibles.ebitda!, /TVA non renseignée/);
    assert.equal(ht.indisponibles.coutsStructure, LIBELLE_ECART_TVA_INCOMPLETE);
  });

  test("prorata des objectifs mensuels conservé en HT : demi-mois = demi-objectif", () => {
    const quinzaine = { debut: "2026-04-01", fin: "2026-04-15" };
    proche(cibleDeCoutsDeStructure([structure(30_000, "ht")], quinzaine, "ht")!.valeur, 15_000);
  });
});

describe("cash flow et absence de régression TTC", () => {
  const transactions = [tx(120_000, "A"), tx(-66_000, "direct"), tx(-12_000, "structure"), tx(-800, "extra")];
  const cibles = [marge("gross_margin_pct", "A", 50), marge("contribution_margin_pct", "A", 40), structure(12_000, undefined)];

  test("cash flow inchangé : identique dans les deux lectures", () => {
    const ht = calculerPnlEnBase(transactions, AXE, MAPPINGS, [], "ht");
    const ttc = calculerPnlEnBase(transactions, AXE, MAPPINGS, [], "ttc");
    assert.equal(ht.cashFlowOperationnel, ttc.cashFlowOperationnel);
    assert.equal(ht.variationTresorerie, ttc.variationTresorerie);
  });

  test("TTC : base par défaut d'ecartsVsCibles, résultat inchangé", () => {
    const p = parts(transactions, "ttc");
    const implicite = ecartsVsCibles(cibles, p, [], MARS);
    const explicite = ecartsVsCibles(cibles, p, [], MARS, null, "ttc");
    assert.deepEqual(implicite, explicite);
    proche(implicite.margeBrute!.ecartEuros, -6_000);
    proche(implicite.coutsStructure!.ecart, 0);
    assert.deepEqual(implicite.indisponibles, { margeBrute: null, margeContributive: null, ebitda: null, coutsStructure: null });
  });
});

describe("écran Objectifs", () => {
  test("Objectifs : la base s'affiche pour les montants seulement, jamais pour les pourcentages", () => {
    const html = renderToStaticMarkup(
      React.createElement(PasseObjectifs, {
        cibles: [marge("gross_margin_pct", "A", 50), structure(12_000, undefined, "2026-01-01"), structure(10_000, "ht", "2026-02-01")],
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
    assert.ok(html.includes("10 000 € HT / mois"), "version en vigueur, en HT");
    assert.ok(html.includes("50 %"));
    assert.equal(/50 % (TTC|HT)/.test(html), false);
  });
});
