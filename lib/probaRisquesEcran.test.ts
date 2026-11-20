/**
 * Gestion des risques : formulations et bloc rendu dans jsdom, alimenté par le vrai calcul
 * (lib/probaRisques.ts) — les valeurs affichées sont celles du calcul.
 */
import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(globalThis as unknown as { window: unknown }).window = dom.window;
(globalThis as unknown as { document: Document }).document = dom.window.document as unknown as Document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Recharts (ResponsiveContainer) observe la taille de son conteneur : absent de jsdom.
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import React, { act, createElement } from "react";
import GestionRisques, { EtatRisques, GestionRisquesVue, GROUPES_AFFICHES } from "../components/GestionRisques";
import { analyserRisques, ParametresRisques } from "./probaRisques";
import { calibrerModele } from "./probaCalibration";
import { EvenementTresorerie, LigneProbabiliste } from "./probaEvenements";
import { messagePartiel, messageSansAlerte, phraseDeclencheur, titreGroupe } from "./probaRisquesEcran";
import type { ReponseRisques } from "./probaApi";
import { decalerDateISO } from "./dates";
import { capacitesDeLOffre } from "./offres";

(globalThis as unknown as { React: typeof React }).React = React;
// react-dom chargé après jsdom (voir lib/probaEcran.test.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");

const DEPART = "2026-11-20";
const ligne = (cle: string): LigneProbabiliste => ({ cle, probabilite: 100, condition: null, fiabiliteMontant: 100, modeDate: "echeance", aRenseigner: false });
const evt = (cle: string, jour: number, montant: number, autres: Partial<EvenementTresorerie> = {}): EvenementTresorerie => ({
  id: `${cle}#0`,
  cleLigne: cle,
  libelle: cle === "dec" ? "Échéance de prêt" : cle,
  montant: Math.abs(montant),
  sens: montant >= 0 ? "encaissement" : "decaissement",
  datePrevue: decalerDateISO(DEPART, jour),
  dateEcheance: null,
  fiabiliteDate: 50,
  tiers: `Client ${cle}`,
  etage: montant >= 0 ? "revenue" : null,
  ...autres,
});

function reponse(soldeInitial: number, flux: [string, number, number, Partial<EvenementTresorerie>?][], factures: string[]): ReponseRisques {
  const modele = calibrerModele([], "client", DEPART);
  const params: ParametresRisques = {
    soldeInitial,
    dateDepart: DEPART,
    horizonJours: 30,
    lignes: flux.map(([c]) => ligne(c)),
    evenements: flux.map(([c, d, m, e]) => evt(c, d, m, e)),
    modeles: { client: modele, fournisseur: calibrerModele([], "fournisseur", DEPART) },
    factures: factures.map((f) => ({ cleLigne: f, type: "facture_client", numero: `FC-${f.toUpperCase()}`, client: `Client ${f}`, dateEcheance: null })),
  };
  return { ...analyserRisques(params, modele), parametres: { dateDepart: DEPART, horizonJours: 30, soldeInitial, dureeMs: 1 } };
}

const CAS_DUO = (): ReponseRisques => reponse(35_000, [["a", 5, 20_000], ["b", 7, 15_000], ["dec", 10, -45_000]], ["a", "b"]);
const CAS_SEULE = (): ReponseRisques => reponse(10_000, [["a", 5, 20_000], ["dec", 10, -25_000]], ["a"]);
const CAS_DEUX_SEULES = (): ReponseRisques => reponse(5_000, [["a", 5, 20_000], ["b", 6, 20_000], ["dec", 10, -40_000]], ["a", "b"]);
const CAS_AGGRAVATION = (): ReponseRisques => reponse(0, [["dec", 3, -5_000], ["a", 5, 20_000]], ["a"]);
const CAS_SANS = (): ReponseRisques => reponse(100_000, [["a", 5, 20_000], ["dec", 10, -45_000]], ["a"]);

const texte = (s: string) => s.replace(/[  ]/g, " ");

describe("Formulations", () => {
  test("facture seule, deux factures chacune critiques, duo, aggravation : quatre messages distincts", () => {
    assert.equal(titreGroupe(CAS_SEULE().groupes[0]), "Un retard sur cette facture peut faire passer votre trésorerie sous zéro.");
    assert.equal(titreGroupe(CAS_DEUX_SEULES().groupes[0]), "Deux factures présentent chacune un risque de passage sous zéro en cas de retard.");
    assert.equal(titreGroupe(CAS_DUO().groupes[0]), "Le retard simultané de ces deux factures peut faire passer votre trésorerie sous zéro.");
    assert.equal(titreGroupe(CAS_AGGRAVATION().groupes[0]), "Le retard de cette facture aggraverait une tension déjà prévue.");
  });

  test("dates testées explicites, conditionnelles au scénario", () => {
    const r = CAS_DUO();
    assert.equal(
      texte(phraseDeclencheur(r.groupes[0].alertes[0], r.dates)),
      "Si FC-A — Client a arrive après le 30 nov. 2026 et FC-B — Client b après le 02 déc. 2026, la trésorerie passe sous zéro dans les hypothèses analysées."
    );
    const s = CAS_SEULE();
    assert.equal(
      texte(phraseDeclencheur(s.groupes[0].alertes[0], s.dates)),
      "Encaissement prévu le 25 nov. 2026. Un paiement après le 30 nov. 2026 provoquerait une tension dans les hypothèses analysées."
    );
  });

  test("date saisie comme ferme : stress présenté comme hypothétique", () => {
    const r = reponse(10_000, [["a", 5, 20_000, { fiabiliteDate: 100 }], ["dec", 10, -25_000]], ["a"]);
    assert.match(phraseDeclencheur(r.groupes[0].alertes[0], r.dates), /^Encaissement prévu le .*\. Si ce paiement était malgré tout retardé, un paiement après/);
  });

  test("aucune alerte : jamais « aucun risque » ; analyse partielle signalée avec son périmètre", () => {
    const sans = CAS_SANS();
    assert.equal(messageSansAlerte(sans.couverture), "Aucune dépendance critique à une ou deux factures détectée sur l'horizon analysé.");
    assert.equal(messagePartiel(sans.couverture), null);
    const partielle = { ...sans.couverture, partielle: true, pairesPossibles: 10, pairesEvaluees: 3, pairesEcarteesSansRisque: 1, facturesAnalysees: 5 };
    assert.match(messagePartiel(partielle)!, /^Analyse partielle : 5 factures testées seules, 4 paires sur 10 examinées/);
    assert.match(messageSansAlerte(partielle), /dans le périmètre analysé \(analyse partielle\)/);
  });
});

// ---------------------------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------------------------

function rendreVue(etat: EtatRisques, horsProjection = 0) {
  const conteneur = document.createElement("div");
  document.body.appendChild(conteneur);
  const racine = createRoot(conteneur);
  const ouvertes: string[] = [];
  act(() => racine.render(createElement(GestionRisquesVue, { etat, horsProjection, onVoirFacture: (t: string) => ouvertes.push(t) })));
  const clic = (libelle: string, n = 0) =>
    act(() => {
      const b = Array.from(conteneur.querySelectorAll("button")).filter((x) => x.textContent?.startsWith(libelle))[n];
      assert.ok(b, `bouton « ${libelle} »`);
      b.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  return { conteneur, clic, ouvertes, texte: () => texte(conteneur.textContent ?? ""), demonter: () => act(() => racine.unmount()) };
}
const pret = (resultat: ReponseRisques): EtatRisques => ({ resultat, enCours: false, aActualiser: false, erreur: null });

describe("Bloc Gestion des risques", () => {
  test("carte du duo : factures, date de tension, déficit, retard déclencheur — valeurs du calcul", () => {
    const v = rendreVue(pret(CAS_DUO()));
    const t = v.texte();
    assert.match(t, /Gestion des risques/);
    assert.match(t, /horizon analysé du 20 nov\. 2026 au 20 déc\. 2026/);
    assert.match(t, /Tension le 30 nov\. 2026 · déficit 10 000 € · 1 jour sous zéro/);
    assert.match(t, /Recevoir l'un des deux paiements à sa date de référence suffit à éviter ce creux\./);
    assert.match(t, /Ce jour-là sont aussi prévus : Échéance de prêt \(45 000 €\)\./);
    assert.doesNotMatch(t, /35 000 € à couvrir|déficit 35 000/);
    v.demonter();
  });

  test("« Voir les 2 factures » : reste à encaisser, dates de référence et testées, plausibilité, ouverture dans Flux", () => {
    const v = rendreVue(pret(CAS_DUO()));
    v.clic("Voir les 2 factures");
    const t = v.texte();
    assert.match(t, /FC-A — Client a.*Reste à encaisser 20 000 € · encaissement de référence 25 nov\. 2026 · testé le 01 déc\. 2026 \(\+6 j\)/);
    assert.match(t, /FC-B — Client b.*Reste à encaisser 15 000 €/);
    assert.match(t, /Plausibilité du retard non estimée\./);
    v.clic("Ouvrir dans Flux de tréso", 1);
    assert.deepEqual(v.ouvertes, ["FC-B"]);
    v.demonter();
  });

  test("« Voir l'impact sur la courbe » : les quatre situations du duo comparées", () => {
    const v = rendreVue(pret(CAS_DUO()));
    v.clic("Voir l'impact sur la courbe");
    const lignes = Array.from(v.conteneur.querySelectorAll(".proba-risque__situations tbody tr")).map((tr) => texte(tr.textContent ?? ""));
    assert.deepEqual(lignes, [
      "RéférenceAucun25 000 €0",
      "FC-A seule retardéeAucun5 000 €0",
      "FC-B seule retardéeAucun10 000 €0",
      "Les deux retardées30 nov. 2026-10 000 €1",
    ]);
    v.demonter();
  });

  test("regroupement : deux factures critiques séparément dans une seule carte, chacune consultable", () => {
    const v = rendreVue(pret(CAS_DEUX_SEULES()));
    assert.equal(v.conteneur.querySelectorAll(".proba-risque").length, 1);
    assert.equal(v.conteneur.querySelectorAll(".proba-risque__alerte").length, 2);
    v.demonter();
  });

  test("quelques alertes prioritaires, puis « Voir toutes les alertes »", () => {
    const base = CAS_SEULE();
    const groupes = Array.from({ length: GROUPES_AFFICHES + 2 }, (_, i) => ({ ...base.groupes[0], id: `g${i}` }));
    const v = rendreVue(pret({ ...base, groupes }));
    assert.equal(v.conteneur.querySelectorAll(".proba-risque").length, GROUPES_AFFICHES);
    v.clic("Voir toutes les alertes (5)");
    assert.equal(v.conteneur.querySelectorAll(".proba-risque").length, 5);
    v.demonter();
  });

  test("aucune alerte, factures hors projection signalées dans les hypothèses", () => {
    const v = rendreVue(pret(CAS_SANS()), 2);
    assert.match(v.texte(), /Aucune dépendance critique à une ou deux factures détectée sur l'horizon analysé\./);
    assert.doesNotMatch(v.texte(), /Aucun risque/);
    assert.match(v.texte(), /2 factures ouvertes sans date d'encaissement à venir/);
    v.demonter();
  });

  test("états : calcul en cours, résultat à actualiser, erreur (jamais présentée comme une absence de risque)", () => {
    const enCours = rendreVue({ resultat: null, enCours: true, aActualiser: false, erreur: null });
    assert.match(enCours.texte(), /Analyse des encaissements critiques en cours…/);
    enCours.demonter();
    const perime = rendreVue({ resultat: CAS_DUO(), enCours: true, aActualiser: true, erreur: null });
    assert.match(perime.texte(), /Résultats en cours d'actualisation…/);
    assert.ok(perime.conteneur.querySelector(".proba-risques__liste--perime"));
    perime.demonter();
    const erreurAvec = rendreVue({ resultat: CAS_DUO(), enCours: false, aActualiser: true, erreur: "Échec." });
    assert.match(erreurAvec.texte(), /Échec\. Le résultat affiché n'est plus à jour\./);
    erreurAvec.demonter();
    const erreurSans = rendreVue({ resultat: null, enCours: false, aActualiser: false, erreur: "Échec." });
    assert.match(erreurSans.texte(), /Aucun résultat : cela ne signifie pas une absence de risque\./);
    assert.doesNotMatch(erreurSans.texte(), /Aucune dépendance critique/);
    erreurSans.demonter();
  });

  test("analyse partielle affichée", () => {
    const r = CAS_SANS();
    const v = rendreVue(pret({ ...r, couverture: { ...r.couverture, partielle: true } }));
    assert.match(v.texte(), /Analyse partielle :/);
    v.demonter();
  });
});

describe("Actualisation", () => {
  test("recalcul quand les données changent ; un ancien calcul terminé en retard ne remplace pas le plus récent", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const attentes: { corps: { soldeInitial: number }; resoudre: (r: ReponseRisques) => void }[] = [];
    const fetchOrigine = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: { body: string; signal: AbortSignal }) =>
      new Promise((ok) => {
        attentes.push({ corps: JSON.parse(init.body), resoudre: (r) => ok(new Response(JSON.stringify(r))) });
      })) as unknown as typeof fetch;
    try {
      const conteneur = document.createElement("div");
      document.body.appendChild(conteneur);
      const racine = createRoot(conteneur);
      const requete = (soldeInitial: number) => ({ soldeInitial, dateDepart: DEPART, horizonJours: 30, lignes: [], evenements: [], factures: [] });
      const rendre = (soldeInitial: number) =>
        act(() => racine.render(createElement(GestionRisques, { accessToken: "jeton", actif: true, requete: requete(soldeInitial), horsProjection: 0, onVoirFacture: () => {} })));
      rendre(35_000);
      await act(async () => mock.timers.tick(800));
      rendre(100_000); // hypothèse validée / solde actualisé : nouveau calcul
      await act(async () => mock.timers.tick(800));
      assert.deepEqual(attentes.map((a) => a.corps.soldeInitial), [35_000, 100_000]);
      // Le récent répond d'abord (aucune alerte), l'ancien ensuite (une alerte) : l'ancien est ignoré.
      await act(async () => attentes[1].resoudre(CAS_SANS()));
      await act(async () => attentes[0].resoudre(CAS_DUO()));
      await act(async () => {});
      assert.match(texte(conteneur.textContent ?? ""), /Aucune dépendance critique/);
      assert.equal(conteneur.querySelectorAll(".proba-risque").length, 0);
      act(() => racine.unmount());
    } finally {
      globalThis.fetch = fetchOrigine;
      mock.timers.reset();
    }
  });
});

describe("Gating Pilotage", () => {
  test("route serveur : offre Pilotage revérifiée à chaque appel, seule l'offre Pilotage y accède", () => {
    const route = readFileSync(join(__dirname, "../app/api/futur/probabiliste/risques/route.ts"), "utf8");
    assert.match(route, /accesPrevisionProbabiliste\(req, "futur\/probabiliste\/risques"\)/);
    assert.match(route, /if \(!acces\.ok\) return acces\.reponse;/);
    assert.deepEqual(
      (["essential", "forecast", "steering"] as const).map((o) => capacitesDeLOffre(o).canViewProbabilisticForecast),
      [false, false, true]
    );
  });
});
