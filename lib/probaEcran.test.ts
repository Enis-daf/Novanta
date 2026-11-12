/**
 * Écran des hypothèses de la prévision probabiliste : modèle pur (regroupement P&L, tri, filtres,
 * complétude, matérialité) et rendu du composant dans jsdom (cartouche, filtres, état vide, champs
 * selon le type de ligne).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// jsdom doit être posé AVANT tout import de react-dom/client (voir analyseSessionContext.test.ts).
const dom = new JSDOM("<!doctype html><html><body></body></html>");
(globalThis as unknown as { window: unknown }).window = dom.window;
(globalThis as unknown as { document: Document }).document = dom.window.document as unknown as Document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import HypothesesProbabilistes from "../components/HypothesesProbabilistes";
import type { FluxProjete, SourceFlux } from "./cash-engine";
import { cleLigne, HypotheseLigne } from "./probaEvenements";
import {
  CleGroupeHypotheses,
  completude,
  completudeMoteur,
  construireLignesHypotheses,
  correspondAuFiltre,
  grouperHypotheses,
  messageCompletude,
  phraseARenseigner,
  resumeGroupe,
} from "./probaEcran";
import { capacitesDeLOffre } from "./offres";

(globalThis as unknown as { React: typeof React }).React = React;

const flux = (source: SourceFlux, sourceId: string, montant: number, date = "2026-12-01", libelle = sourceId): FluxProjete => ({ source, sourceId, libelle, date, montant });

// Groupes P&L tels que Futur les classe : encaissements, coûts de structure, coûts directs, financement, à classer.
const GROUPES: Record<string, CleGroupeHypotheses> = {
  fc1: "revenue",
  fc2: "revenue",
  r1: "revenue",
  cf1: "ebitda",
  cf2: "ebitda",
  ff1: "gross_margin",
  fi1: "financing",
  ad1: "a_classer",
};
const groupeDe = (_s: SourceFlux, id: string) => GROUPES[id];

const FLUX: FluxProjete[] = [
  flux("facture_client", "fc1", 12_000),
  flux("facture_client", "fc2", 40_000),
  flux("rentree_reguliere", "r1", 8_000, "2026-12-05"),
  flux("rentree_reguliere", "r1", 8_000, "2027-01-05"),
  flux("charge_fixe", "cf1", -4_500),
  flux("charge_fixe", "cf1", -4_500, "2027-01-01"),
  flux("charge_fixe", "cf2", -900),
  flux("facture_fournisseur", "ff1", -15_000),
  flux("financement", "fi1", 30_000),
  flux("autre_depense", "ad1", -300),
];

function hypotheses(...liste: HypotheseLigne[]): Map<string, HypotheseLigne> {
  return new Map(liste.map((h) => [cleLigne(h.source, h.sourceId), h]));
}
const h = (source: SourceFlux, sourceId: string, champs: Partial<HypotheseLigne> = {}): HypotheseLigne => ({
  source,
  sourceId,
  probabilite: 100,
  fiabiliteDate: 100,
  fiabiliteMontant: null,
  montantCible: null,
  condition: null,
  ...champs,
});

describe("Valeurs par défaut selon le type de ligne", () => {
  const lignes = construireLignesHypotheses(FLUX, new Map(), groupeDe);
  const ligne = (id: string) => lignes.find((l) => l.sourceId === id)!;

  test("factures : certaines, jamais « À renseigner » ; date client selon l'historique", () => {
    assert.equal(ligne("fc1").aRenseigner, false);
    assert.equal(ligne("fc1").hypothese.probabilite, 100);
    assert.equal(ligne("fc1").hypothese.fiabiliteDate, 50);
    assert.equal(ligne("ff1").aRenseigner, false);
  });

  test("charges fixes : montant, existence et début certains", () => {
    assert.equal(ligne("cf1").aRenseigner, false);
    assert.deepEqual([ligne("cf1").hypothese.probabilite, ligne("cf1").hypothese.fiabiliteDate, ligne("cf1").hypothese.fiabiliteMontant], [100, 100, 100]);
  });

  test("rentrées régulières, financements et autres dépenses : « À renseigner »", () => {
    assert.equal(ligne("r1").aRenseigner, true);
    assert.equal(ligne("fi1").aRenseigner, true);
    assert.equal(ligne("ad1").aRenseigner, true);
  });

  test("une hypothèse enregistrée vaut validation, même aux valeurs par défaut", () => {
    const renseignees = construireLignesHypotheses(FLUX, hypotheses(h("financement", "fi1")), groupeDe);
    assert.equal(renseignees.find((l) => l.sourceId === "fi1")!.aRenseigner, false);
  });

  test("impact = somme des échéances de l'horizon", () => {
    assert.equal(ligne("r1").impact, 16_000);
    assert.equal(ligne("r1").echeances, 2);
    assert.equal(ligne("cf1").impact, 9_000);
  });
});

describe("Regroupement P&L et tri", () => {
  const lignes = construireLignesHypotheses(FLUX, new Map(), groupeDe);

  test("étages dans l'ordre de la taxonomie de Futur, « À classer » en dernier, aucun groupe vide", () => {
    assert.deepEqual(
      grouperHypotheses(lignes).map((g) => g.libelle),
      ["Encaissements", "Coûts directs", "Coûts de structure", "Financement", "À classer"]
    );
  });

  test("dans chaque étage : impact décroissant", () => {
    const encaissements = grouperHypotheses(lignes)[0];
    assert.deepEqual(
      encaissements.lignes.map((l) => l.sourceId),
      ["fc2", "r1", "fc1"]
    );
  });

  test("résumé d'étage : nombre, impact, à renseigner", () => {
    const [encaissements, , structure] = grouperHypotheses(lignes);
    assert.equal(resumeGroupe(encaissements), "Encaissements — 3 hypothèses — 68 k€ d'impact — 1 à renseigner");
    assert.equal(resumeGroupe(structure), "Coûts de structure — 2 hypothèses — 10 k€ d'impact");
  });
});

describe("Filtres", () => {
  const lignes = construireLignesHypotheses(
    FLUX,
    hypotheses(h("facture_client", "fc1", { probabilite: 75, fiabiliteDate: 50 }), h("charge_fixe", "cf2", { probabilite: 25 })),
    groupeDe
  );
  const ids = (filtre: Parameters<typeof grouperHypotheses>[1]) =>
    grouperHypotheses(lignes, filtre)
      .flatMap((g) => g.lignes.map((l) => l.sourceId))
      .sort();

  test("Toutes / À renseigner / 25 / 50 / 75 / 100 %", () => {
    assert.equal(ids("toutes").length, 8);
    assert.deepEqual(ids("a_renseigner"), ["ad1", "fi1", "r1"]);
    assert.deepEqual(ids(75), ["fc1"]);
    assert.deepEqual(ids(25), ["cf2"]);
    assert.deepEqual(ids(50), []);
    // Une ligne à renseigner n'a pas encore de probabilité choisie : jamais sous 100 %.
    assert.deepEqual(ids(100), ["cf1", "fc2", "ff1"]);
  });

  test("un filtre vide ne renvoie aucun groupe", () => {
    assert.deepEqual(grouperHypotheses(lignes, 50), []);
    assert.equal(correspondAuFiltre(lignes[0], "toutes"), true);
  });
});

describe("Complétude et matérialité", () => {
  test("hypothèse importante à renseigner : prévision bloquée", () => {
    const lignes = construireLignesHypotheses(FLUX, new Map(), groupeDe);
    const c = completude(lignes);
    // Total des flux 129 300 € : seuil 5 % = 6 465 €. Rentrée (16 000) et financement (30 000) importants, autre dépense (300) secondaire.
    assert.deepEqual([c.aRenseigner, c.importantesARenseigner, c.secondairesARenseigner, c.bloquee], [3, 2, 1, true]);
    assert.equal(phraseARenseigner(c), "3 hypothèses à renseigner");
    assert.equal(messageCompletude(c), "Prévision probabiliste indisponible — 2 hypothèses importantes doivent être renseignées.");
  });

  test("seules des hypothèses secondaires à renseigner : prévision calculée avec un avertissement", () => {
    const lignes = construireLignesHypotheses(FLUX, hypotheses(h("rentree_reguliere", "r1"), h("financement", "fi1")), groupeDe);
    const c = completude(lignes);
    assert.equal(c.bloquee, false);
    assert.equal(messageCompletude(c), "Prévision calculée avec 1 hypothèse secondaire non renseignée, prise telle que saisie dans Futur.");
  });

  test("tout renseigné : aucune cartouche ni message ; incertaines comptées", () => {
    const lignes = construireLignesHypotheses(
      FLUX,
      hypotheses(h("rentree_reguliere", "r1", { probabilite: 75 }), h("financement", "fi1", { probabilite: 50 }), h("autre_depense", "ad1")),
      groupeDe
    );
    const c = completude(lignes);
    assert.equal(phraseARenseigner(c), null);
    assert.equal(messageCompletude(c), null);
    assert.equal(c.incertaines, 2);
  });

  test("même règle côté serveur", () => {
    const etat = completudeMoteur(
      [
        { cle: "a", aRenseigner: true },
        { cle: "b", aRenseigner: true },
        { cle: "c", aRenseigner: false },
      ],
      [
        { cleLigne: "a", montant: 30_000, datePrevue: "2026-12-01" },
        { cleLigne: "b", montant: 100, datePrevue: "2026-12-01" },
        { cleLigne: "c", montant: 70_000, datePrevue: "2026-12-01" },
      ],
      "2027-02-10"
    );
    assert.deepEqual(etat, { aRenseigner: 2, importantesARenseigner: 1, secondairesARenseigner: 1, bloquee: true });
  });

  test("compte vide : rien à renseigner, rien de bloqué", () => {
    const c = completude(construireLignesHypotheses([], new Map(), groupeDe));
    assert.equal(c.bloquee, false);
    assert.equal(phraseARenseigner(c), null);
  });
});

describe("Offre Pilotage", () => {
  test("seule l'offre Pilotage ouvre l'écran, l'édition et le calcul (une seule capacité, revérifiée par les deux routes)", () => {
    assert.deepEqual(
      (["essential", "forecast", "steering"] as const).map((o) => capacitesDeLOffre(o).canViewProbabilisticForecast),
      [false, false, true]
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------------------------

function rendre(lignes: ReturnType<typeof construireLignesHypotheses>) {
  const conteneur = document.createElement("div");
  document.body.appendChild(conteneur);
  const racine = createRoot(conteneur);
  const modifications: unknown[] = [];
  act(() => {
    racine.render(
      createElement(HypothesesProbabilistes, {
        lignes,
        completude: completude(lignes),
        montantsFixes: new Map([["rentree_reguliere:r1", 8_000]]),
        descendantsDe: () => new Set<string>(),
        onModifier: (_l, h) => modifications.push(h),
      })
    );
  });
  const boutons = () => Array.from(conteneur.querySelectorAll("button"));
  const cliquer = (texte: string) =>
    act(() => {
      const b = boutons().find((x) => x.textContent?.replace("▾", "").trim().startsWith(texte));
      assert.ok(b, `bouton « ${texte} » introuvable`);
      b!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  const lignesAffichees = () => Array.from(conteneur.querySelectorAll(".proba-ligne__libelle > span:first-child")).map((e) => e.textContent);
  return { conteneur, cliquer, lignesAffichees, modifications, demonter: () => act(() => racine.unmount()) };
}

describe("Écran des hypothèses", () => {
  test("étages repliables avec résumé, lignes triées, cartouche « À renseigner » qui filtre", () => {
    const lignes = construireLignesHypotheses(FLUX, new Map(), groupeDe);
    const ecran = rendre(lignes);
    const titres = Array.from(ecran.conteneur.querySelectorAll(".proba-groupe__resume")).map((e) => e.textContent);
    assert.equal(titres[0], "Encaissements — 3 hypothèses — 68 k€ d'impact — 1 à renseigner");
    assert.deepEqual(ecran.lignesAffichees().slice(0, 3), ["fc2", "r1", "fc1"]);
    assert.match(ecran.conteneur.querySelector(".proba-a-renseigner")!.textContent!, /3 hypothèses à renseigner.*dont 2 importantes/);

    ecran.cliquer("3 hypothèses à renseigner");
    assert.deepEqual(ecran.lignesAffichees().sort(), ["ad1", "fi1", "r1"]);

    ecran.cliquer("Encaissements");
    assert.equal(ecran.lignesAffichees().includes("r1"), false, "étage replié");
    ecran.demonter();
  });

  test("filtre par probabilité et état vide du filtre", () => {
    const ecran = rendre(construireLignesHypotheses(FLUX, new Map(), groupeDe));
    ecran.cliquer("50 %");
    assert.equal(ecran.lignesAffichees().length, 0);
    assert.match(ecran.conteneur.textContent!, /Aucune hypothèse pour ce filtre/);
    ecran.cliquer("Toutes");
    assert.equal(ecran.lignesAffichees().length, 8);
    ecran.demonter();
  });

  test("champs selon le type : facture sans montant, rentrée avec montant cible et certitude", () => {
    const ecran = rendre(construireLignesHypotheses(FLUX, new Map(), groupeDe));
    const ouvrir = (libelle: string) => {
      const li = Array.from(ecran.conteneur.querySelectorAll(".proba-ligne")).find((x) => x.querySelector(".proba-ligne__libelle span")?.textContent === libelle)!;
      act(() => li.querySelector<HTMLButtonElement>(".etage-pnl-outils__lien")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
      return li;
    };
    const facture = ouvrir("fc2");
    assert.equal(facture.textContent!.includes("Certitude du montant"), false);
    assert.equal(facture.textContent!.includes("Fiabilité de la date"), true);
    const rentree = ouvrir("r1");
    assert.equal(rentree.textContent!.includes("Montant cible par échéance"), true);
    assert.equal(rentree.textContent!.includes("Fiabilité de la date de début"), true);
    // « Valider ces hypothèses » enregistre les valeurs affichées telles quelles.
    act(() => Array.from(rentree.querySelectorAll("button")).find((b) => b.textContent === "Valider ces hypothèses")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(ecran.modifications.length, 1);
    ecran.demonter();
  });

  test("aucun jargon statistique à l'écran", () => {
    const ecran = rendre(construireLignesHypotheses(FLUX, new Map(), groupeDe));
    const texte = ecran.conteneur.textContent!.toLowerCase();
    for (const mot of ["bernoulli", "sigma", "variance", "écart-type", "gamma", "normal", "shrinkage", "monte carlo"]) assert.equal(texte.includes(mot), false, mot);
    ecran.demonter();
  });

  test("état vide : aucun flux sur l'horizon", () => {
    const ecran = rendre([]);
    assert.match(ecran.conteneur.textContent!, /Aucun flux sur l'horizon/);
    ecran.demonter();
  });
});
