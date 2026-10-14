import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatKiloEuros, formatMontant, formatMontantComptable, formatPourcentage, MENTION_TTC, suffixeTTC } from "./format";
import { noteAjustements } from "./pastDetail";
import { LigneAjustement } from "./pastAdjustments";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { calculerPnl } from "./pastPnl";
import { EcartsVsCibles, libellePoints, libellesEcartCouts, libellesEcartEbitda, libellesEcartMarge } from "./pastTargets";
import PasseGeneral from "../components/PasseGeneral";
import PasseStructureChart from "../components/PasseStructureChart";

// Les composants sont compilés avec la transformation JSX classique : React doit être global.
(globalThis as unknown as { React: typeof React }).React = React;

const espaces = (texte: string) => texte.replace(/[  ]/g, " ");
const entites = (texte: string) => texte.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const texteDe = (html: string) =>
  entites(espaces(html.replace(/<[^>]+>/g, "\n")))
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);

describe("formatters : jamais de mention d'eux-mêmes", () => {
  test("€, k€ et présentation comptable : rendu inchangé, sans TTC", () => {
    assert.equal(espaces(formatMontant(125_000)), "125 000 €");
    assert.equal(espaces(formatKiloEuros(125_000)), "125 k€");
    assert.equal(espaces(formatMontantComptable(-1_500)), "(1 500 €)");
    for (const montant of [0, -999, 12_345.67, -1_000_000]) {
      for (const texte of [formatMontant(montant), formatKiloEuros(montant), formatMontantComptable(montant)]) {
        assert.equal(texte.includes(MENTION_TTC), false, texte);
      }
    }
  });

  test("suffixeTTC : après le montant, jamais devant, jamais deux fois, montant inchangé", () => {
    assert.equal(espaces(suffixeTTC(formatMontant(2_477_907))), "2 477 907 € TTC");
    assert.equal(espaces(suffixeTTC(formatKiloEuros(-18_000))), "-18 k€ TTC");
    assert.equal(suffixeTTC(suffixeTTC("12 k€")), "12 k€ TTC");
    assert.equal(suffixeTTC(formatMontant(5)).startsWith(MENTION_TTC), false);
  });

  test("jamais sur un pourcentage ni un écart en points", () => {
    assert.equal(formatPourcentage(0.576).includes(MENTION_TTC), false);
    assert.equal(libellePoints(-0.038).includes(MENTION_TTC), false);
  });
});

describe("détails secondaires : contexte déjà posé, aucune mention", () => {
  test("écarts vs cible : « -418,2 k€ vs cible », jamais « TTC -418,2 k€ vs cible »", () => {
    const libelles = [
      libellesEcartMarge({ cible: 0.56, ecartEuros: -418_200, couverture: 1 } as never),
      libellesEcartCouts({ cible: 85_000, ecart: 9_000, couverture: 1 } as never),
      libellesEcartEbitda({ cible: 150_000, ecart: -20_000, statut: "defavorable", couvertureCa: 1, couverturePeriode: 1 } as never),
    ];
    assert.equal(espaces(libelles[0].ecart), "-418,2 k€ vs cible");
    for (const l of libelles) assert.equal(JSON.stringify(l).includes(MENTION_TTC), false);
  });

  test("notes d'ajustements sous les graphiques : sans mention", () => {
    const ligne = { cle: "s", label: "Variation de stock", type: "inventory_change", montant: 12_000, notes: [] } as unknown as LigneAjustement;
    assert.deepEqual(noteAjustements([ligne]), ["Variation de stock : +12 k€"]);
  });
});

// P&L de référence : CA 1 250 000, coûts directs 530 000, coûts variables 210 000, structure 320 000.
const AXE = "229";
const mapping = (id: string, nom: string, pnlStage: MappingCategorie["pnlStage"]): MappingCategorie => ({ sourceCategoryId: id, sourceCategoryName: nom, sourceGroupId: AXE, pnlStage });
const tx = (amount: number, id: string, nom: string) =>
  ({ id: `t-${id}`, sourceType: "pennylane", transactionDate: "2026-03-01", label: "", amount, currency: "EUR", affectations: [{ groupId: AXE, categoryId: id, categoryName: nom, weight: 1 }] }) as never;
const pnl = calculerPnl(
  [tx(1_250_000, "ca", "Stripe"), tx(-530_000, "mat", "Achats"), tx(-210_000, "ads", "Ads"), tx(-320_000, "loyer", "Loyer"), tx(-85_000, "tva", "TVA"), tx(50_000, "fin", "Emprunt")],
  AXE,
  indexerMappings([mapping("ca", "Stripe", "revenue"), mapping("mat", "Achats", "gross_margin"), mapping("ads", "Ads", "contribution_margin"), mapping("loyer", "Loyer", "ebitda"), mapping("tva", "TVA", "extra_pnl"), mapping("fin", "Emprunt", "financing")])
);
const cibles = {
  margeBrute: { realise: 0.576, cible: 0.56, ecartPoints: 0.016, ecartEuros: -418_200, statut: "defavorable", couverture: 1 },
  margeContributive: null,
  ebitda: { realise: 190_000, cible: 208_000, ecart: -18_000, statut: "defavorable", couvertureCa: 1, couverturePeriode: 1 },
  ebitdaIncomplet: false,
  coutsStructure: null,
  montantCoutsStructure: -320_000,
} as unknown as EcartsVsCibles;

describe("P&L (Général) : TTC après le nom des indicateurs principaux", () => {
  const html = renderToStaticMarkup(
    React.createElement(PasseGeneral, { pnl, cibles, onOuvrir: () => {}, onDefinirCible: () => {}, teintes: new Map() })
  );
  const lignes = texteDe(html);
  const suivi = (libelle: string) => lignes[lignes.indexOf(libelle) + 1];

  test("chaque indicateur principal est suivi de la mention", () => {
    for (const principal of ["Encaissements", "Marge brute", "Marge contributive", "EBITDA", "Cash flow opérationnel", "Variation de trésorerie"]) {
      assert.ok(lignes.includes(principal), principal);
      assert.equal(suivi(principal), MENTION_TTC, principal);
    }
  });

  test("les sous-lignes (coûts, Extra P&L, financement) restent sans mention", () => {
    for (const secondaire of ["Coûts directs", "Coûts de structure"]) {
      assert.ok(lignes.includes(secondaire), secondaire);
      assert.notEqual(suivi(secondaire), MENTION_TTC, secondaire);
    }
    assert.equal(lignes.filter((t) => t === MENTION_TTC).length, 6, "une mention par indicateur principal, pas une de plus");
  });

  test("jamais à côté d'un montant, jamais « TTC -… vs cible », jamais deux fois", () => {
    lignes.forEach((t, i) => {
      if (t !== MENTION_TTC) return;
      assert.equal(/€|k€|%/.test(lignes[i - 1]), false, `« TTC » après « ${lignes[i - 1]} »`);
    });
    // Le montant du P&L vient ensuite, dans sa propre colonne : on contrôle chaque texte affiché.
    assert.equal(lignes.some((t) => /TTC\s*-?\d/.test(t)), false);
    assert.equal(lignes.some((t, i) => t === MENTION_TTC && lignes[i + 1] === MENTION_TTC), false);
    assert.ok(lignes.includes("-418,2 k€ vs cible"));
  });
});

describe("camemberts : aucune mention", () => {
  test("total, légende : formats € / k€ seuls", () => {
    const structure = { parts: [{ cle: "a", nom: "Coûts directs", montant: 420_000, part: 0.6 }, { cle: "b", nom: "Loyer", montant: 280_000, part: 0.4 }], total: 700_000 };
    const html = renderToStaticMarkup(
      React.createElement(PasseStructureChart, { titre: "Structure des coûts", structure: structure as never, messageVide: "—" })
    );
    assert.equal(html.includes(MENTION_TTC), false);
    assert.ok(espaces(html).includes("420 k€"));
  });

  test("ni infobulle ni total ne passent par la mention dans le composant", () => {
    assert.equal(/TTC|MentionTTC|suffixeTTC/.test(readFileSync(path.resolve(__dirname, "../components/PasseStructureChart.tsx"), "utf8")), false);
  });
});

describe("gros KPI : montant puis TTC", () => {
  const source = (nom: string) => readFileSync(path.resolve(__dirname, `../components/${nom}.tsx`), "utf8");

  test("CA, marges, EBITDA, Cash flow (écran de détail) : <MentionTTC /> après le montant", () => {
    assert.match(source("PastDetailDashboard"), /passe-kpi__montant">\s*\{[^}]*\}\s*<MentionTTC \/>/);
  });

  test("Analyse d'écarts : les trois KPI, montant puis mention", () => {
    const kpis = source("PasseEcarts").match(/passe-ecarts__kpi-valeur">[\s\S]*?<\/p>/g) ?? [];
    assert.equal(kpis.length, 3);
    for (const kpi of kpis) assert.match(kpi, /(\}|\/>)\s*<MentionTTC \/>\s*<\/p>/);
  });

  test("aucun écran ne place la mention devant un montant", () => {
    const fichiers = readdirSync(path.resolve(__dirname, "../components")).filter((nom) => /^(Passe|PastDetail).*\.tsx$/.test(nom));
    for (const fichier of fichiers) {
      const contenu = readFileSync(path.resolve(__dirname, "../components", fichier), "utf8");
      assert.equal(/<MentionTTC \/>\s*\{\s*(format|enK)/.test(contenu), false, fichier);
    }
  });
});

describe("garde-fous", () => {
  test("« TTC » n'est jamais écrit en dur dans les écrans ni le PDF", () => {
    const racine = path.resolve(__dirname, "..");
    const fichiers = [
      ...readdirSync(path.join(racine, "components")).filter((nom) => /^(Passe|PastDetail).*\.tsx$/.test(nom)).map((nom) => path.join("components", nom)),
      "lib/pastPdfDocument.tsx",
    ];
    for (const fichier of fichiers) {
      const source = readFileSync(path.join(racine, fichier), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}/gm, "");
      assert.equal(/["'`>][^"'`<]*\bTTC\b/.test(source), false, fichier);
    }
  });

  test("le disclaimer en bas de page est conservé", () => {
    assert.match(readFileSync(path.resolve(__dirname, "../app/passe/page.tsx"), "utf8"), /Ils sont TTC\./);
  });
});
