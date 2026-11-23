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
import { COURBE } from "../components/ImpactRisqueChart";
import { analyserRisques, ParametresRisques, PerimetreFactures } from "./probaRisques";
import { calibrerModele } from "./probaCalibration";
import { EvenementTresorerie, LigneProbabiliste } from "./probaEvenements";
import { dateTensionDuo, limitesCouverture, messageSansAlerte, phraseDeclencheur, phrasesReference, resumeTension, titreGroupe } from "./probaRisquesEcran";
import type { ReponseRisques } from "./probaApi";
import { decalerDateISO } from "./dates";
import { formatDate } from "./format";
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

function reponse(soldeInitial: number, flux: [string, number, number, Partial<EvenementTresorerie>?][], factures: string[], perimetre?: PerimetreFactures): ReponseRisques {
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
  return {
    ...analyserRisques({ ...params, ...(perimetre ? { perimetre } : {}) }, modele),
    parametres: { dateDepart: DEPART, horizonJours: 30, soldeInitial, dureeMs: 1 },
    dureesRoute: { historiqueMs: 0, preparationMs: 0, analyseMs: 0, totalMs: 1 },
  };
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
    const duo = CAS_DUO();
    assert.equal(texte(titreGroupe(duo.groupes[0], duo.dates)), "Le retard simultané de ces deux factures peut faire passer votre trésorerie sous zéro le 30 nov. 2026.");
    assert.equal(titreGroupe(CAS_AGGRAVATION().groupes[0]), "Le retard de cette facture aggraverait une tension déjà prévue.");
  });

  test("dates testées explicites, conditionnelles au scénario", () => {
    const r = CAS_DUO();
    assert.equal(
      texte(phraseDeclencheur(r.groupes[0].alertes[0], r.dates)),
      "Si FC-A — Client a arrive après le 30 nov. 2026 et FC-B — Client b après le 30 nov. 2026, la trésorerie passe sous zéro dans les hypothèses analysées."
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
    assert.equal(messageSansAlerte(sans.couverture), "Aucune dépendance critique à une ou deux factures détectée sur l'horizon analysé, dans la projection de référence.");
    assert.deepEqual(limitesCouverture(sans.couverture), []);
    const partielle = { ...sans.couverture, partielle: true };
    assert.match(messageSansAlerte(partielle), /dans le périmètre analysé — analyse partielle, voir ses limites\./);
  });
});

// ---------------------------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------------------------

function rendreVue(etat: EtatRisques) {
  const conteneur = document.createElement("div");
  document.body.appendChild(conteneur);
  const racine = createRoot(conteneur);
  const ouvertes: string[] = [];
  act(() => racine.render(createElement(GestionRisquesVue, { etat, onVoirFacture: (t: string) => ouvertes.push(t) })));
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
    assert.match(t, /FC-A — Client a.*Reste à encaisser 20 000 €.*Encaissement prévu le 25 nov\. 2026, testé le 01 déc\. 2026 \(\+6 jours\)/);
    assert.match(t, /FC-B — Client b.*Encaissement prévu le 27 nov\. 2026, testé le 01 déc\. 2026 \(\+4 jours\)/);
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

  test("aucune alerte : message contextualisé, portée de la référence visible à côté", () => {
    const v = rendreVue(pret(CAS_SANS()));
    assert.match(v.texte(), /Aucune dépendance critique à une ou deux factures détectée sur l'horizon analysé, dans la projection de référence\./);
    assert.match(v.texte(), /Analyse fondée sur la projection de référence, incluant les flux incertains prévus\./);
    assert.doesNotMatch(v.texte(), /Aucun risque/);
    v.demonter();
  });

  test("factures à actualiser : visibles avec leur raison, analyse partielle, lien vers l'édition existante", () => {
    const perimetre: PerimetreFactures = {
      enRetardEstimees: 1,
      aActualiser: [{ cleLigne: "facture_client:z", numero: "FC-Z", client: "Zeta", montant: 12_000, raison: "historique de paiement insuffisant pour estimer une date" }],
      litigieusesExclues: 1,
      horsHorizon: 0,
    };
    const v = rendreVue(pret(reponse(100_000, [["a", 5, 20_000], ["dec", 10, -45_000]], ["a"], perimetre)));
    const t = v.texte();
    assert.match(t, /Analyse partielle/);
    assert.match(t, /Données · 1 facture en retard sans date d'encaissement estimable : à actualiser, non testée\./);
    assert.match(t, /FC-Z — Zeta · 12 000 € · historique de paiement insuffisant pour estimer une date/);
    assert.match(t, /dans le périmètre analysé — analyse partielle/);
    v.clic("Actualiser la date");
    assert.deepEqual(v.ouvertes, ["FC-Z"]);
    assert.match(t, /1 facture litigieuse : exclue de la projection/);
    assert.match(t, /1 facture en retard placée à une date estimée/);
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

  test("quatre limites distinctes : données, méthode, calcul, affichage", () => {
    const r = CAS_SANS();
    const c = {
      ...r.couverture,
      partielle: true,
      perimetre: { ...r.couverture.perimetre, aActualiser: [{ cleLigne: "x", numero: "FC-X", client: "X", montant: 1, raison: "r" }] },
      restrictionMethode: "Méthode restreinte.",
      arret: { cause: "budget_temps" as const, evaluations: 1000 },
      pairesNonExplorees: 3,
      pairesPossibles: 10,
      affichage: { alertesCalculees: 14, alertesDetaillees: 10, combinaisonsListees: 4, combinaisonsNonListees: 0 },
    };
    assert.deepEqual(limitesCouverture(c).map((l) => l.type), ["donnees", "methode", "calcul", "affichage"]);
    assert.match(limitesCouverture(c)[2].texte, /limite de durée du calcul atteinte\) : 3 paires sur 10 non explorées/);
    const v = rendreVue(pret({ ...r, couverture: c }));
    assert.match(v.texte(), /Analyse partielle.*Données · .*Méthode · Méthode restreinte\..*Calcul · Calcul arrêté.*Affichage · 14 alertes calculées, 10 détaillées/);
    v.demonter();
  });

  test("affichage condensé seul : pas d'analyse partielle", () => {
    const r = CAS_SANS();
    const c = { ...r.couverture, affichage: { alertesCalculees: 14, alertesDetaillees: 10, combinaisonsListees: 4, combinaisonsNonListees: 0 } };
    assert.deepEqual(limitesCouverture(c).map((l) => l.type), ["affichage"]);
    const v = rendreVue(pret({ ...r, couverture: c }));
    assert.doesNotMatch(v.texte(), /Analyse partielle/);
    v.demonter();
  });

  test("portée de la référence : flux et financement incertains, hypothèses à renseigner", () => {
    assert.deepEqual(phrasesReference({ soldes: [], mesures: CAS_SANS().reference.mesures, fluxIncertains: 2, financementsIncertains: 1, hypothesesARenseigner: 3 }), [
      "Analyse fondée sur la projection de référence, incluant les flux incertains prévus.",
      "Elle inclut 2 flux incertains, dont 1 financement : une absence d'alerte ne signifie pas que la trésorerie resterait positive sans eux.",
      "3 hypothèses à renseigner, prises telles que saisies dans Futur.",
      "Analyse de sensibilité aux retards d'une ou deux factures : elle ne résume pas le risque des perspectives pondérées.",
    ]);
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
        act(() => racine.render(createElement(GestionRisques, { accessToken: "jeton", actif: true, requete: requete(soldeInitial), onVoirFacture: () => {} })));
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
    for (const nom of ["risques", "estimations"]) {
      const route = readFileSync(join(__dirname, `../app/api/futur/probabiliste/${nom}/route.ts`), "utf8");
      assert.match(route, new RegExp(`accesPrevisionProbabiliste\\(req, "futur/probabiliste/${nom}"\\)`));
      assert.match(route, /if \(!acces\.ok\) return acces\.reponse;/);
      // Société toujours dérivée de l'utilisateur connecté (isolation des comptes).
      assert.match(route, /acces\.companyId|const \{ companyId \} = acces;/);
    }
    assert.deepEqual(
      (["essential", "forecast", "steering"] as const).map((o) => capacitesDeLOffre(o).canViewProbabilisticForecast),
      [false, false, true]
    );
  });
});

describe("Date de passage sous zéro dans le titre du duo", () => {
  const verifierCoherence = (r: ReponseRisques, attendue: string) => {
    const groupe = r.groupes.find((g) => g.type === "duo")!;
    const alerte = groupe.alertes[0];
    const conjoint = alerte.situations[alerte.situations.length - 1];
    assert.equal(conjoint.libelle, "Les deux retardées");
    // Premier jour négatif du scénario conjoint, tel que le détail et la courbe l'affichent.
    assert.equal(r.dates[conjoint.mesures.episodeDebut!], attendue);
    assert.equal(dateTensionDuo(groupe, r.dates), attendue);
    assert.equal(groupe.dateTension, attendue);
    assert.match(texte(resumeTension(alerte.mesures, r.dates)), new RegExp(`^Tension le ${texte(formatDate(attendue))}`));
    assert.ok(texte(titreGroupe(groupe, r.dates)).endsWith(`sous zéro le ${texte(formatDate(attendue))}.`));
    // Premier solde négatif de la courbe « Les deux retardées » = cette date.
    const premierNegatif = conjoint.soldes.findIndex((x, j) => x < 0 && r.reference.soldes[j] >= 0);
    assert.equal(r.dates[premierNegatif], attendue);
  };

  test("cas de référence (A le 25/11, B le 27/11, −45 000 € le 30/11) : 30 novembre", () => {
    verifierCoherence(CAS_DUO(), decalerDateISO(DEPART, 10));
  });

  test("cas asymétrique (A +11 j, B +2 j) : J11", () => {
    const r = reponse(35_000, [["a", 1, 20_000], ["b", 10, 15_000], ["d1", 11, -45_000], ["d2", 15, -15_000]], ["a", "b"]);
    verifierCoherence(r, decalerDateISO(DEPART, 11));
    assert.match(texte(titreGroupe(r.groupes.find((g) => g.type === "duo")!, r.dates)), /sous zéro le 01 déc\. 2026\.$/);
  });

  test("tension déjà prévue plus tôt : la date est celle de la tension CRÉÉE par le duo", () => {
    // Référence négative les 23-24/11 ; le duo crée une nouvelle tension le 30/11.
    const r = reponse(0, [["dec0", 3, -5_000], ["c", 5, 20_000], ["a", 6, 6_000], ["b", 7, 6_000], ["dec", 10, -18_000]], ["a", "b"]);
    const groupe = r.groupes.find((g) => g.type === "duo")!;
    const conjoint = groupe.alertes[0].situations[3];
    assert.equal(conjoint.mesures.premierNegatif, 3, "le scénario conjoint passe d'abord sous zéro avec la tension déjà prévue");
    assert.equal(dateTensionDuo(groupe, r.dates), decalerDateISO(DEPART, 10));
    assert.match(texte(titreGroupe(groupe, r.dates)), /sous zéro le 30 nov\. 2026\.$/);
  });

  test("date de début de la tension, pas du point bas ; date absente : aucune date inventée", () => {
    const base = CAS_DUO().groupes[0];
    const dates = CAS_DUO().dates;
    const decale = { ...base, alertes: [{ ...base.alertes[0], mesures: { ...base.alertes[0].mesures, episodeDebut: 10, jourMinimum: 12 } }] };
    assert.equal(dateTensionDuo(decale, dates), decalerDateISO(DEPART, 10));
    const sansDate = { ...base, alertes: [{ ...base.alertes[0], mesures: { ...base.alertes[0].mesures, episodeDebut: null } }] };
    assert.equal(dateTensionDuo(sansDate, dates), null);
    assert.equal(titreGroupe(sansDate, dates), "Le retard simultané de ces deux factures peut faire passer votre trésorerie sous zéro.");
    assert.doesNotMatch(titreGroupe(sansDate, dates), /\[Date\]| le \./);
  });

  test("carte rendue : la date figure dans le titre, sans ouvrir le détail", () => {
    const v = rendreVue(pret(CAS_DUO()));
    assert.equal(texte(v.conteneur.querySelector(".proba-risque__titre")!.textContent!), "Le retard simultané de ces deux factures peut faire passer votre trésorerie sous zéro le 30 nov. 2026.");
    v.demonter();
  });
});

describe("Courbes lissées de « Voir l'impact sur la courbe »", () => {
  // Chemin SVG exact que Recharts trace pour une ligne de type COURBE (même fonction interne).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getPath } = require("recharts/lib/shape/Curve") as { getPath: (p: { type: string; points: { x: number; y: number }[]; layout: string }) => string };

  /** Segments cubiques du chemin : [y0, c1, c2, y1] (le y SVG est ici le solde lui-même). */
  function segments(soldes: number[]) {
    const chemin = getPath({ type: COURBE, layout: "horizontal", points: soldes.map((y, x) => ({ x, y })) });
    const nombres = chemin.replace(/^M/, "").split(/[C,L]/).map(Number);
    const pts: [number, number][] = [];
    for (let i = 0; i < nombres.length; i += 2) pts.push([nombres[i], nombres[i + 1]]);
    const resultat: { y0: number; c1: number; c2: number; y1: number }[] = [];
    for (let i = 0; i + 3 < pts.length; i += 3) resultat.push({ y0: pts[i][1], c1: pts[i + 1][1], c2: pts[i + 2][1], y1: pts[i + 3][1] });
    return resultat;
  }

  for (const [nom, cas] of [
    ["cas de référence", CAS_DUO],
    ["cas asymétrique", () => reponse(35_000, [["a", 1, 20_000], ["b", 10, 15_000], ["d1", 11, -45_000], ["d2", 15, -15_000]], ["a", "b"])],
  ] as const) {
    test(`${nom} : chaque solde journalier exact, aucun dépassement entre deux jours, paliers horizontaux`, () => {
      const r = cas();
      const alerte = r.groupes.find((g) => g.type === "duo")!.alertes[0];
      assert.equal(alerte.situations.length, 4);
      for (const s of alerte.situations) {
        const segs = segments(s.soldes);
        assert.equal(segs.length, s.soldes.length - 1);
        segs.forEach((g, j) => {
          // La courbe passe exactement par les soldes du jour j et du jour j + 1.
          assert.equal(g.y0, s.soldes[j]);
          assert.equal(g.y1, s.soldes[j + 1]);
          // Bézier contenue dans l'enveloppe de ses points de contrôle : ceux-ci restent entre les
          // deux soldes, donc la courbe aussi — pas de creux sous zéro entre deux soldes positifs.
          const bas = Math.min(g.y0, g.y1) - 1e-6;
          const haut = Math.max(g.y0, g.y1) + 1e-6;
          assert.ok(g.c1 >= bas && g.c1 <= haut && g.c2 >= bas && g.c2 <= haut, `${s.libelle}, jour ${j}`);
          if (g.y0 === g.y1) assert.ok(g.c1 === g.y0 && g.c2 === g.y0, "palier horizontal");
          if (g.y0 >= 0 && g.y1 >= 0) assert.ok(Math.min(g.c1, g.c2) >= -1e-6);
        });
      }
      // Données, tableau et mesures inchangés par le lissage (il n'agit que sur le tracé).
      assert.deepEqual(alerte.situations.map((s) => s.mesures.minimum), cas === CAS_DUO ? [25_000, 5_000, 10_000, -10_000] : [10_000, 5_000, 10_000, -10_000]);
    });
  }

  test("les quatre trajectoires utilisent la même interpolation monotone", () => {
    const source = readFileSync(join(__dirname, "../components/ImpactRisqueChart.tsx"), "utf8");
    assert.equal(COURBE, "monotone");
    assert.equal((source.match(/type=\{COURBE\}/g) ?? []).length, 2, "ligne du scénario et lignes de référence / intermédiaires");
    assert.doesNotMatch(source, /stepAfter|"basis"|"natural"|"cardinal"/);
  });
});
