/**
 * Encaissements à sécuriser : formulations et panneau rendu dans jsdom, alimenté par le vrai calcul
 * (lib/probaSemaine.ts) — les valeurs affichées sont celles de l'analyse.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(globalThis as unknown as { window: unknown }).window = dom.window;
(globalThis as unknown as { document: Document }).document = dom.window.document as unknown as Document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import React, { act, createElement } from "react";
import EncaissementsASecuriser, { EncaissementsASecuriserVue, EtatSemaine, Testeur } from "../components/EncaissementsASecuriser";
import { analyserSemaine, ParametresSemaine, testerDecalage } from "./probaSemaine";
import { calculerIndicateurs } from "./probaIndicateurs";
import { simuler } from "./probaSimulation";
import { calibrerModele } from "./probaCalibration";
import { cleTiers, ObservationRetard } from "./probaHistorique";
import { EvenementTresorerie, LigneProbabiliste } from "./probaEvenements";
import { lignesRepartition, phraseContribution, phrasePortee, phraseResultatTest, phrasesScenario, phraseVulnerabilite, semaineDeLaDate, semaineLaPlusExposee, titreSemaine } from "./probaSemaineEcran";
import type { ReponseSemaine } from "./probaApi";
import { decalerDateISO } from "./dates";
import { formatDate } from "./format";

(globalThis as unknown as { React: typeof React }).React = React;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");

// Même cas que lib/probaSemaine.test.ts : facture échue le 4 déc., prévue le 8 déc., dépense de 40 000 € le 20 déc.
const DEPART = "2026-11-30";
const SEMAINE = { debut: "2026-12-14", fin: "2026-12-20" };
function obs(retards: number[], tiers: string): ObservationRetard[] {
  return retards.map((retard, i) => ({ cote: "client", tiers, cleTiers: cleTiers(tiers), montant: 10_000, echeance: decalerDateISO("2026-03-01", i * 3), dateReglement: decalerDateISO(decalerDateISO("2026-03-01", i * 3), retard), retard }));
}
const historique = obs([2, 5, 8, 10, 12, 14, 16, 18, 20, 22, 25, 30].flatMap((x) => [x, x]), "Alpha");
const modeles = { client: calibrerModele(historique, "client", DEPART), fournisseur: calibrerModele([], "fournisseur", DEPART) };
const ligne = (cle: string): LigneProbabiliste => ({ cle, probabilite: 100, condition: null, fiabiliteMontant: 100, modeDate: "echeance", aRenseigner: false });
const evt = (cle: string, jour: number, montant: number, autres: Partial<EvenementTresorerie> = {}): EvenementTresorerie => ({
  id: `${cle}#0`,
  cleLigne: cle,
  libelle: cle === "dec" ? "Fournisseurs" : cle,
  montant: Math.abs(montant),
  sens: montant >= 0 ? "encaissement" : "decaissement",
  datePrevue: decalerDateISO(DEPART, jour),
  dateEcheance: null,
  fiabiliteDate: 100,
  tiers: null,
  etage: montant >= 0 ? "revenue" : null,
  ...autres,
});
const PARAMS: ParametresSemaine = {
  soldeInitial: 10_000,
  dateDepart: DEPART,
  horizonJours: 60,
  lignes: [ligne("f"), ligne("dec")],
  evenements: [evt("f", 8, 35_000, { dateEcheance: "2026-12-04", fiabiliteDate: 50, tiers: "Alpha" }), evt("dec", 20, -40_000)],
  modeles,
  nombreSimulations: 2_000,
  graine: 2020,
  factures: [{ cleLigne: "f", type: "facture_client", numero: "FA-1", client: "Alpha", dateEcheance: "2026-12-04" }],
  semaine: SEMAINE,
};
const RESULTAT: ReponseSemaine = { ...analyserSemaine(PARAMS), dureeRouteMs: 0, historiqueMs: 0 };
const INDICATEURS = calculerIndicateurs(simuler(PARAMS));
const RISQUE = INDICATEURS.semaines.find((s) => s.debut === SEMAINE.debut)!;

const texte = (s: string) => s.replace(/\s+/g, " ").trim();

function rendre(etat: EtatSemaine, testeur: Testeur = () => Promise.reject(new Error("non prévu"))) {
  const conteneur = document.createElement("div");
  document.body.appendChild(conteneur);
  const racine = createRoot(conteneur);
  const ouvertes: string[] = [];
  act(() =>
    racine.render(
      createElement(EncaissementsASecuriserVue, {
        semaine: SEMAINE,
        risque: RISQUE,
        nombreSimulations: 2_000,
        etat,
        testeur,
        onVoirFacture: (t: string) => ouvertes.push(t),
        onSemainePrecedente: null,
        onSemaineSuivante: () => {},
        onFermer: () => {},
      })
    )
  );
  const bouton = (libelle: string) => [...conteneur.querySelectorAll("button")].find((b) => texte(b.textContent ?? "").startsWith(libelle)) as HTMLButtonElement | undefined;
  return { conteneur, bouton, ouvertes, texte: () => texte(conteneur.textContent ?? ""), demonter: () => act(() => racine.unmount()) };
}

describe("Formulations", () => {
  test("semaine du lundi au dimanche, choisie par une date ; semaine la plus exposée", () => {
    assert.equal(titreSemaine(SEMAINE), `Semaine du lundi ${formatDate("2026-12-14")} au dimanche ${formatDate("2026-12-20")}`);
    assert.equal(semaineDeLaDate(INDICATEURS.semaines, "2026-12-17")?.debut, "2026-12-14");
    assert.equal(semaineDeLaDate(INDICATEURS.semaines, "2027-06-01"), null);
    assert.equal(semaineLaPlusExposee(INDICATEURS.semaines)?.debut, SEMAINE.debut);
    assert.equal(semaineLaPlusExposee(INDICATEURS.semaines.map((s) => ({ ...s, simulationsNegatives: 0 }))), null);
  });

  test("contribution, scénario et date limite issus de l'analyse", () => {
    const f = RESULTAT.factures[0];
    const n = RESULTAT.analysees.toLocaleString("fr-FR");
    assert.match(phraseContribution(f, RESULTAT.analysees), new RegExp(`évite le passage sous zéro dans ${n} scénarios sur ${n}`));
    const [recit, correction, limite] = phrasesScenario(f.scenario!, f);
    assert.match(recit, new RegExp(`passage sous zéro le ${formatDate("2026-12-20")}, déficit maximal 30\\s000\\s€`));
    assert.match(correction, new RegExp(`Encaissée le ${formatDate("2026-12-08")}.*reste positive toute la semaine`));
    assert.equal(limite, `Dans ce scénario, tout paiement reçu jusqu'au ${formatDate("2026-12-20")} inclus évite le creux de la semaine.`);
    assert.equal(lignesRepartition(RESULTAT)[0], `${RESULTAT.analysees} scénarios : une seule facture, encaissée à sa date de référence, suffit à éviter le passage sous zéro (d'autres retards peuvent seulement le réduire).`);
  });

  test("portée : exhaustive, échantillon, partielle (jamais présentée comme exhaustive)", () => {
    assert.equal(RESULTAT.echantillon, RESULTAT.simulationsNegatives > 400);
    assert.match(phrasePortee({ ...RESULTAT, echantillon: false, analysees: RESULTAT.simulationsNegatives })!, /rejoués un par un/);
    assert.match(phrasePortee({ ...RESULTAT, echantillon: true, analysees: 400 })!, /^Échantillon de 400 scénarios négatifs/);
    assert.match(phrasePortee({ ...RESULTAT, couverture: { ...RESULTAT.couverture, arret: { cause: "budget_temps", analysees: 12 } } })!, /^Analyse partielle : 12 scénarios/);
    assert.equal(phrasePortee({ ...RESULTAT, simulationsNegatives: 0 }), null);
  });

  test("décalage testé et vulnérabilité d'un paiement certain", () => {
    assert.match(phraseResultatTest({ deficitSemaine: 0, datePassageSousZero: null }, "2026-12-16"), /reste positive toute la semaine/);
    assert.match(phraseResultatTest({ deficitSemaine: 30_000, datePassageSousZero: "2026-12-20" }, "2026-12-22"), new RegExp(`sous zéro le ${formatDate("2026-12-20")}`));
    assert.match(
      phraseVulnerabilite({ cleLigne: "f", numero: "FA-1", client: "Alpha", montantRestant: 35_000, dateReference: "2026-12-08", retardJours: 13, dateTestee: "2026-12-21", datePassageSousZero: "2026-12-20", deficit: 30_000 }),
      /^Si ce paiement certain était malgré tout retardé de 13 jours/
    );
  });
});

describe("Panneau « Encaissements à sécuriser »", () => {
  test("en-tête : semaine, risque hebdomadaire immédiat (indicateurs) pendant l'analyse", () => {
    const v = rendre({ resultat: null, enCours: true, erreur: null });
    assert.match(v.texte(), /Encaissements à sécuriser/);
    assert.match(v.texte(), /Semaine du lundi/);
    assert.match(v.texte(), new RegExp(`${RISQUE.simulationsNegatives.toLocaleString("fr-FR").replace(/\s/g, "\\s")} scénarios sur 2\\s000 passent sous 0 €`));
    assert.match(v.texte(), /Analyse des scénarios de la semaine en cours/);
    assert.equal(v.bouton("‹ Semaine précédente")!.disabled, true);
    v.demonter();
  });

  test("facture prioritaire, dates, scénario réel, actions ; test de décalage sans enregistrement", async () => {
    const appels: [number, string, string][] = [];
    const testeur: Testeur = async (s, cle, date) => {
      appels.push([s, cle, date]);
      return testerDecalage(PARAMS, s, cle, date, SEMAINE);
    };
    const v = rendre({ resultat: RESULTAT, enCours: false, erreur: null }, testeur);
    const t = v.texte();
    assert.match(t, /FA-1 — Alpha/);
    assert.match(t, new RegExp(`échéance contractuelle ${formatDate("2026-12-04")}`));
    assert.match(t, new RegExp(`encaissement prévu le ${formatDate("2026-12-08")}`));
    assert.match(t, new RegExp(`tout paiement reçu jusqu'au ${formatDate("2026-12-20")} inclus`));
    act(() => v.bouton("Voir la facture")!.click());
    assert.deepEqual(v.ouvertes, ["FA-1"]);
    act(() => v.bouton("Voir le scénario")!.click());
    assert.match(v.texte(), /ce n'est ni la médiane ni la bande grise/);
    act(() => v.bouton("Tester un décalage")!.click());
    assert.match(v.texte(), /Rien n'est enregistré/);
    await act(async () => v.bouton("+14 jours")!.click());
    await act(async () => {});
    assert.deepEqual(appels, [[RESULTAT.factures[0].scenario!.simulation, "f", "2026-12-22"]]);
    assert.match(v.texte(), new RegExp(`Encaissée le ${formatDate("2026-12-22")}, la trésorerie passe sous zéro le ${formatDate("2026-12-20")}`));
    await act(async () => v.bouton("À la date de référence")!.click());
    await act(async () => {});
    assert.match(v.texte(), /reste positive toute la semaine dans ce scénario/);
    v.demonter();
  });

  test("erreur : jamais présentée comme une absence de risque ; analyse partielle signalée", () => {
    const e = rendre({ resultat: null, enCours: false, erreur: "Délai dépassé." });
    assert.match(e.texte(), /Délai dépassé\. Aucun résultat : cela ne signifie pas une absence de risque\./);
    e.demonter();
    const partiel = { ...RESULTAT, couverture: { ...RESULTAT.couverture, arret: { cause: "budget_temps" as const, analysees: 12 } } };
    const p = rendre({ resultat: partiel, enCours: false, erreur: null });
    assert.match(p.texte(), /Analyse partielle : 12 scénarios négatifs analysés/);
    p.demonter();
  });

  test("conteneur : une analyse par semaine, mise en cache tant que les données ne changent pas", async () => {
    const corps: { semaine: { debut: string } }[] = [];
    const fetchOrigine = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const c = JSON.parse(init.body);
      corps.push(c);
      return { ok: true, json: async () => ({ ...RESULTAT, semaine: { ...RESULTAT.semaine, debut: c.semaine.debut, fin: c.semaine.fin } }) };
    }) as unknown as typeof fetch;
    try {
      const conteneur = document.createElement("div");
      const racine = createRoot(conteneur);
      const requete = { soldeInitial: 10_000, dateDepart: DEPART, horizonJours: 60, lignes: PARAMS.lignes, evenements: PARAMS.evenements, factures: PARAMS.factures };
      const A = { debut: "2026-12-14", fin: "2026-12-20" };
      const B = { debut: "2026-12-21", fin: "2026-12-27" };
      const props = { accessToken: "jeton", requete, risque: RISQUE, nombreSimulations: 2_000, onVoirFacture: () => {}, onSemainePrecedente: null, onSemaineSuivante: null, onFermer: () => {} };
      for (const semaine of [A, B, A]) {
        await act(async () => racine.render(createElement(EncaissementsASecuriser, { ...props, semaine })));
        await act(async () => {});
      }
      assert.deepEqual(corps.map((c) => c.semaine.debut), ["2026-12-14", "2026-12-21"]);
      // Données modifiées : le cache est vidé.
      await act(async () => racine.render(createElement(EncaissementsASecuriser, { ...props, requete: { ...requete, soldeInitial: 9_000 }, semaine: A })));
      await act(async () => {});
      assert.equal(corps.length, 3);
      act(() => racine.unmount());
    } finally {
      globalThis.fetch = fetchOrigine;
    }
  });

  test("accès : route réservée à l'offre Pilotage et bloquée tant qu'une hypothèse importante manque", () => {
    const route = readFileSync(join(__dirname, "../app/api/futur/probabiliste/semaine/route.ts"), "utf8");
    assert.match(route, /accesPrevisionProbabiliste\(req, "futur\/probabiliste\/semaine"\)/);
    assert.match(route, /completudeMoteur\(/);
    assert.match(route, /status: 409/);
    // Mêmes graine et nombre de scénarios que la prévision affichée.
    assert.match(route, /graine: requete\.graine \?\? GRAINE_PAR_DEFAUT/);
    assert.match(route, /nombreSimulations: requete\.nombreSimulations \?\? NOMBRE_SIMULATIONS_PAR_DEFAUT/);
  });
});
