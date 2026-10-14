import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  avecMentionTTC,
  formatKiloEuros,
  formatMontant,
  formatMontantComptable,
  formatPourcentage,
  MENTION_TTC,
} from "./format";
import { noteAjustements } from "./pastDetail";
import { LigneAjustement } from "./pastAdjustments";
import { libellePoints, libellesEcartCouts, libellesEcartEbitda, libellesEcartMarge } from "./pastTargets";

const espaces = (texte: string) => texte.replace(/[  ]/g, " ");

describe("mention TTC des montants : formatters", () => {
  test("sans option : rendu strictement inchangé (le module Futur n'est pas concerné)", () => {
    assert.equal(espaces(formatMontant(125_000)), "125 000 €");
    assert.equal(espaces(formatKiloEuros(125_000)), "125 k€");
    assert.equal(espaces(formatMontantComptable(-1_500)), "(1 500 €)");
  });

  test("avec l'option : « TTC » devant, montant identique, unité conservée (€ ou k€)", () => {
    assert.equal(espaces(formatMontant(125_000, { ttc: true })), "TTC 125 000 €");
    assert.equal(espaces(formatMontant(-18_400, { ttc: true })), "TTC -18 400 €");
    assert.equal(espaces(formatKiloEuros(342_000, 1, { ttc: true })), "TTC 342 k€");
    assert.equal(espaces(formatKiloEuros(1_586_400, 0, { ttc: true })), "TTC 1 586 k€");
    assert.equal(espaces(formatMontantComptable(-1_500, { ttc: true })), "TTC (1 500 €)");
    for (const montant of [0, 1, -999, 12_345.67, -1_000_000]) {
      assert.equal(formatMontant(montant, { ttc: true }), `${MENTION_TTC} ${formatMontant(montant)}`);
      assert.equal(formatKiloEuros(montant, 1, { ttc: true }), `${MENTION_TTC} ${formatKiloEuros(montant, 1)}`);
    }
  });

  test("jamais « TTC TTC »", () => {
    assert.equal(avecMentionTTC("TTC 12 k€"), "TTC 12 k€");
    assert.equal(avecMentionTTC(avecMentionTTC("+12 k€")), "TTC +12 k€");
    assert.equal(avecMentionTTC(formatMontant(5, { ttc: true })), formatMontant(5, { ttc: true }));
  });

  test("jamais sur un pourcentage ni un écart en points", () => {
    assert.equal(formatPourcentage(0.576).includes(MENTION_TTC), false);
    assert.equal(libellePoints(-0.038).includes(MENTION_TTC), false);
  });
});

describe("mention TTC : libellés du module Passé", () => {
  const ligne = (label: string, montant: number, type = "provision"): LigneAjustement =>
    ({ cle: label, label, type, montant, notes: [] }) as unknown as LigneAjustement;

  test("note des ajustements : une seule mention, sur la ligne principale", () => {
    const stock = ligne("Variation de stock", 12_000, "inventory_change");
    assert.deepEqual(noteAjustements([stock]), ["Variation de stock : TTC +12 k€"]);
    const note = noteAjustements([stock, ligne("Provision", 3_000)]);
    assert.equal(note.join(" ").split(MENTION_TTC).length - 1, 1);
  });

  test("cible et écart : une seule mention par ligne, jamais devant un pourcentage", () => {
    const marge = libellesEcartMarge({ cible: 0.648, ecartEuros: -11_500, couverture: 1 } as never);
    assert.equal(marge.mentionTTC, "ecart", "cible en %, écart en € : la mention va devant l'écart");
    assert.equal(marge.cible.includes(MENTION_TTC) || marge.ecart.includes(MENTION_TTC), false, "posée par l'affichage, pas dans le texte");
    assert.equal(libellesEcartMarge({ cible: 0.648, ecartEuros: null, couverture: 0.6 } as never).mentionTTC, null, "pas d'écart en euros : aucune mention");
    assert.equal(libellesEcartCouts({ cible: 85_000, ecart: 9_000, couverture: 1 } as never).mentionTTC, "cible");
    assert.equal(libellesEcartEbitda({ cible: 150_000, ecart: -20_000, statut: "defavorable", couvertureCa: 1, couverturePeriode: 1 } as never).mentionTTC, "cible");
  });
});

describe("mention TTC : écrans", () => {
  const racine = path.resolve(__dirname, "..");
  const fichiers = [
    ...readdirSync(path.join(racine, "components"))
      .filter((nom) => /^(Passe|PastDetail).*\.tsx$/.test(nom))
      .map((nom) => path.join("components", nom)),
    "lib/pastPdfDocument.tsx",
  ];

  test("« TTC » n'est jamais écrit en dur : toujours via la constante ou le composant", () => {
    for (const fichier of fichiers) {
      const source = readFileSync(path.join(racine, fichier), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}/gm, "");
      assert.equal(/["'`>][^"'`<]*\bTTC\b/.test(source), false, fichier);
    }
  });

  test("les écrans principaux portent la mention", () => {
    const avecMention = ["PasseGeneral", "PastDetailDashboard", "PasseEcartCible", "PasseEcarts", "PasseStocks", "PasseObjectifs", "PasseTransactions", "PasseStructureChart"];
    for (const nom of avecMention) {
      assert.match(readFileSync(path.join(racine, "components", `${nom}.tsx`), "utf8"), /MentionTTC|ttc: true|MENTION_TTC/, nom);
    }
  });

  test("les axes des graphiques restent sans mention", () => {
    for (const nom of ["PasseEvolutionChart", "PasseCategoriesChart", "PasseWaterfallChart"]) {
      const source = readFileSync(path.join(racine, "components", `${nom}.tsx`), "utf8");
      const axes = source.match(/tickFormatter=\{[^}]*\}/g) ?? [];
      assert.ok(axes.length > 0, nom);
      for (const axe of axes) assert.equal(/ttc|TTC/.test(axe), false, `${nom} : ${axe}`);
    }
  });

  test("le disclaimer en bas de page est conservé", () => {
    assert.match(readFileSync(path.join(racine, "app/passe/page.tsx"), "utf8"), /Ils sont TTC\./);
  });
});
