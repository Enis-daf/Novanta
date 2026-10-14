import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MENTION_TTC } from "./format";
import { indexerMappings, LIBELLE_ENCAISSEMENTS, libelleEtagePnl, MappingCategorie } from "./pastCategoryMapping";
import { METRIQUES_DETAIL } from "./pastDetail";
import { calculerPnl } from "./pastPnl";
import { EcartsVsCibles, libellesEcartEbitda, libellesEcartMarge } from "./pastTargets";
import PasseGeneral from "../components/PasseGeneral";
import PasseStructureChart from "../components/PasseStructureChart";

(globalThis as unknown as { React: typeof React }).React = React;

const racine = path.resolve(__dirname, "..");
const lire = (fichier: string) => readFileSync(path.join(racine, fichier), "utf8");
const sansCommentaires = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}|^\s*\/\/.*$|\s\/\/.*$/gm, "");
const texteVisible = (html: string) =>
  html.replace(/<[^>]+>/g, "\n").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/[  ]/g, " ").split("\n").map((t) => t.trim()).filter(Boolean);

// Tous les fichiers source du module Passé (écrans, calculs, PDF), hors tests.
const FICHIERS_PASSE = [
  ...readdirSync(path.join(racine, "components")).filter((n) => /^(Passe|PastDetail).*\.tsx$/.test(n)).map((n) => `components/${n}`),
  ...readdirSync(path.join(racine, "lib")).filter((n) => /^past.*\.tsx?$/.test(n) && !n.includes(".test.")).map((n) => `lib/${n}`),
  "app/passe/page.tsx",
];

describe("vocabulaire du module Passé : Encaissements", () => {
  test("plus aucune mention de « Chiffre d'affaires » (apostrophe droite ou typographique)", () => {
    for (const fichier of FICHIERS_PASSE) assert.equal(/[Cc]hiffre d['’]affaires/.test(lire(fichier)), false, fichier);
  });

  test("plus aucun « CA » dans un texte affiché (chaînes et JSX) ; les clés techniques restent", () => {
    for (const fichier of FICHIERS_PASSE) {
      const source = sansCommentaires(lire(fichier));
      assert.equal(/["'`>][^"'`<\n]*\bCA\b[^"'`<\n]*["'`<]/.test(source), false, fichier);
    }
    // Clés internes inchangées : l'étage reste "revenue", l'écran reste "ca".
    assert.equal(libelleEtagePnl("revenue"), LIBELLE_ENCAISSEMENTS);
    assert.ok("ca" in METRIQUES_DETAIL);
  });

  test("écran de détail : titre, répartition et transactions parlent d'Encaissements", () => {
    const config = METRIQUES_DETAIL.ca;
    assert.equal(config.libelle, "Encaissements");
    assert.equal(config.libelleDetail, "Encaissements");
    assert.match(lire("components/PastDetailDashboard.tsx"), /des encaissements<\/p>/);
  });

  test("Objectifs : encaissements, jamais « CA », et sans mention TTC", () => {
    const source = sansCommentaires(lire("components/PasseObjectifs.tsx"));
    assert.match(source, /Objectifs de marge par catégorie d&apos;encaissements/);
    assert.match(source, /<th>Catégorie d&apos;encaissements<\/th>/);
    assert.equal(/MentionTTC|MENTION_TTC|\bTTC\b/.test(source), false);
    const marge = libellesEcartMarge({ cible: 0.648, ecartEuros: -11_500, couverture: 0.82 } as never);
    assert.equal(marge.reserve, "Cible calculée sur 82 % des encaissements");
    const ebitda = libellesEcartEbitda({ cible: 150_000, ecart: -20_000, statut: "defavorable", couvertureCa: 0.9, couverturePeriode: 1 } as never);
    assert.equal(ebitda.reserve, "Cible EBITDA calculée sur 90 % des encaissements");
  });
});

describe("rendus", () => {
  const AXE = "229";
  const mapping = (id: string, pnlStage: MappingCategorie["pnlStage"]): MappingCategorie => ({ sourceCategoryId: id, sourceCategoryName: id, sourceGroupId: AXE, pnlStage });
  const tx = (amount: number, id: string) =>
    ({ id: `t-${id}`, sourceType: "pennylane", transactionDate: "2026-03-01", label: "", amount, currency: "EUR", affectations: [{ groupId: AXE, categoryId: id, categoryName: id, weight: 1 }] }) as never;
  const pnl = calculerPnl([tx(2_477_907, "stripe"), tx(-1_507_791, "achats")], AXE, indexerMappings([mapping("stripe", "revenue"), mapping("achats", "gross_margin")]));
  const cibles = { margeBrute: null, margeContributive: null, ebitda: null, ebitdaIncomplet: false, coutsStructure: null, montantCoutsStructure: 0 } as unknown as EcartsVsCibles;

  test("P&L : « Encaissements TTC » en tête, montant inchangé", () => {
    const lignes = texteVisible(renderToStaticMarkup(React.createElement(PasseGeneral, { pnl, cibles, onOuvrir: () => {}, onDefinirCible: () => {}, teintes: new Map() })));
    const index = lignes.indexOf("Encaissements");
    assert.ok(index >= 0);
    assert.deepEqual(lignes.slice(index, index + 3), ["Encaissements", MENTION_TTC, "2 477 907 €"]);
    assert.equal(lignes.some((t) => /Chiffre d['’]affaires|^CA$/.test(t)), false);
  });

  test("pie chart : « Encaissements par catégorie », sans TTC", () => {
    const html = renderToStaticMarkup(
      React.createElement(PasseStructureChart, {
        titre: `${METRIQUES_DETAIL.ca.libelleDetail} par catégorie`,
        structure: { parts: [{ cle: "stripe", nom: "Stripe", montant: 2_477_907, part: 1 }], total: 2_477_907 } as never,
        messageVide: "—",
      })
    );
    const lignes = texteVisible(html);
    assert.ok(lignes.includes("Encaissements par catégorie"));
    assert.equal(html.includes(MENTION_TTC), false);
  });
});
