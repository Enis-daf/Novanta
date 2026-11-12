/**
 * Écran des hypothèses de la prévision probabiliste : modèle pur (regroupement P&L, tri, filtres,
 * complétude, matérialité) et rendu du composant dans jsdom (cartouche, filtres, état vide, champs
 * selon le type de ligne).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

// jsdom doit être posé AVANT tout import de react-dom/client (voir analyseSessionContext.test.ts).
const dom = new JSDOM("<!doctype html><html><body></body></html>");
(globalThis as unknown as { window: unknown }).window = dom.window;
(globalThis as unknown as { document: Document }).document = dom.window.document as unknown as Document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act, createElement } from "react";
import HypothesesProbabilistes from "../components/HypothesesProbabilistes";
import type { FluxProjete, SourceFlux } from "./cash-engine";
import { cleLigne, HypotheseLigne } from "./probaEvenements";
import {
  CleGroupeHypotheses,
  completude,
  HypotheseEffective,
  LigneHypothese,
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
// react-dom est chargé APRÈS la mise en place de jsdom : chargé avant (import hissé), il croit ne
// pas être dans un navigateur et n'écoute pas les événements « input » des champs texte.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");

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

// Comme dans Futur : r1 est une rentrée à montant fixe, fc1 a une échéance antérieure à sa date prévue.
const OPTIONS = {
  rentreesFixes: new Set(["rentree_reguliere:r1"]),
  echeanceDe: (source: SourceFlux, id: string) => (source === "facture_client" && id === "fc1" ? "2026-11-20" : null),
};

type Enregistreur = (l: LigneHypothese, h: HypotheseEffective) => Promise<void>;

/**
 * L'écran monté comme dans Futur : un parent garde les hypothèses ENREGISTRÉES et reconstruit les
 * lignes (statut « À renseigner », filtres) seulement quand l'enregistrement a réussi.
 */
function rendre(fluxInitiaux: FluxProjete[] = FLUX, persister: Enregistreur = async () => {}) {
  const conteneur = document.createElement("div");
  document.body.appendChild(conteneur);
  const racine = createRoot(conteneur);
  const appels: { cle: string; h: HypotheseEffective }[] = [];
  function Parent() {
    const [enregistrees, setEnregistrees] = React.useState<Map<string, HypotheseLigne>>(new Map());
    const lignes = construireLignesHypotheses(fluxInitiaux, enregistrees, groupeDe, OPTIONS);
    return createElement(HypothesesProbabilistes, {
      lignes,
      completude: completude(lignes),
      montantsFixes: new Map([["rentree_reguliere:r1", 8_000]]),
      descendantsDe: () => new Set<string>(),
      onEnregistrer: async (l: LigneHypothese, h: HypotheseEffective) => {
        appels.push({ cle: l.cle, h });
        await persister(l, h);
        setEnregistrees((m) =>
          new Map(m).set(l.cle, { source: l.source, sourceId: l.sourceId, ...h, fiabiliteMontant: h.fiabiliteMontant, montantCible: h.montantCible })
        );
      },
    });
  }
  act(() => racine.render(createElement(Parent)));
  const clic = (el: Element) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const boutons = () => Array.from(conteneur.querySelectorAll("button"));
  const cliquer = (texte: string) =>
    act(() => {
      const b = boutons().find((x) => x.textContent?.replace("▾", "").trim().startsWith(texte));
      assert.ok(b, `bouton « ${texte} » introuvable`);
      clic(b!);
    });
  const ligneDe = (libelle: string) =>
    Array.from(conteneur.querySelectorAll("li.proba-ligne")).find((x) => x.querySelector(".proba-ligne__libelle span")?.textContent === libelle);
  const ouvrir = (libelle: string) => {
    const li = ligneDe(libelle)!;
    act(() => clic(li.querySelector(".proba-ligne__resume > .etage-pnl-outils__lien")!));
    return li;
  };
  const choisir = (libelle: string, suffixe: string, valeur: string) =>
    act(() => {
      const select = ligneDe(libelle)!.querySelector<HTMLSelectElement>(`select[id$="-${suffixe}"]`)!;
      select.value = valeur;
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
  const bouton = (libelle: string) =>
    Array.from(ligneDe(libelle)!.querySelectorAll<HTMLButtonElement>(".proba-editeur__valider button"))[0];
  const colonne = (libelle: string, nom: string) => ligneDe(libelle)!.querySelector(`[data-colonne="${nom}"]`)!.textContent;
  const lignesAffichees = () => Array.from(conteneur.querySelectorAll(".proba-ligne__libelle > span:first-child")).map((e) => e.textContent);
  return { conteneur, cliquer, ouvrir, choisir, bouton, colonne, ligneDe, lignesAffichees, appels, clic, demonter: () => act(() => racine.unmount()) };
}

function differe() {
  let resoudre!: () => void;
  let rejeter!: (e: Error) => void;
  const promesse = new Promise<void>((ok, ko) => {
    resoudre = ok;
    rejeter = ko;
  });
  return { promesse, resoudre, rejeter };
}

describe("Vue « À renseigner » : édition en brouillon, enregistrement explicite", () => {
  test("plusieurs champs modifiés sans que la ligne disparaisse, puis enregistrement et sortie du filtre", async () => {
    const attente = differe();
    const ecran = rendre(FLUX, () => attente.promesse);
    ecran.cliquer("À renseigner");
    assert.deepEqual(ecran.lignesAffichees().sort(), ["ad1", "fi1", "r1"]);
    ecran.ouvrir("r1");

    ecran.choisir("r1", "montant", "50");
    assert.ok(ecran.lignesAffichees().includes("r1"), "toujours visible après la certitude du montant");
    ecran.choisir("r1", "date", "75");
    assert.ok(ecran.lignesAffichees().includes("r1"), "toujours visible après la certitude de la date");
    assert.equal(ecran.appels.length, 0, "rien n'est enregistré avant « Enregistrer »");
    assert.match(ecran.ligneDe("r1")!.textContent!, /Modifications non enregistrées/);

    // Chargement : bouton désactivé, libellé d'attente, ligne toujours là.
    await act(async () => ecran.clic(ecran.bouton("r1")));
    assert.equal(ecran.bouton("r1").textContent, "Enregistrement…");
    assert.equal(ecran.bouton("r1").disabled, true);
    assert.ok(ecran.lignesAffichees().includes("r1"));

    await act(async () => {
      attente.resoudre();
      await attente.promesse;
    });
    assert.equal(ecran.appels.length, 1);
    assert.deepEqual([ecran.appels[0].cle, ecran.appels[0].h.fiabiliteMontant, ecran.appels[0].h.fiabiliteDate], ["rentree_reguliere:r1", 50, 75]);
    assert.equal(ecran.lignesAffichees().includes("r1"), false, "renseignée : elle quitte le filtre après l'enregistrement");

    ecran.cliquer("Toutes");
    assert.equal(ecran.colonne("r1", "Certitude du montant"), "Approximatif");
    assert.equal(ecran.colonne("r1", "Certitude de la date"), "Assez fiable");
    ecran.demonter();
  });

  test("échec d'enregistrement : la ligne reste, les valeurs saisies aussi, l'erreur s'affiche", async () => {
    const ecran = rendre(FLUX, async () => {
      throw new Error("L'hypothèse n'a pas pu être enregistrée.");
    });
    ecran.cliquer("À renseigner");
    ecran.ouvrir("fi1");
    ecran.choisir("fi1", "proba", "50");
    await act(async () => ecran.clic(ecran.bouton("fi1")));
    await act(async () => {});
    assert.ok(ecran.lignesAffichees().includes("fi1"));
    assert.match(ecran.ligneDe("fi1")!.querySelector(".login-erreur")!.textContent!, /pas pu être enregistrée/);
    assert.equal(ecran.ligneDe("fi1")!.querySelector<HTMLSelectElement>('select[id$="-proba"]')!.value, "50");
    assert.match(ecran.colonne("fi1", "Probabilité")!, /À renseigner/, "le statut enregistré ne change pas");
    assert.equal(ecran.bouton("fi1").disabled, false, "on peut réessayer");
    ecran.demonter();
  });

  test("brouillon conservé en fermant la ligne et en changeant de filtre", () => {
    const ecran = rendre();
    ecran.cliquer("À renseigner");
    ecran.ouvrir("r1");
    ecran.choisir("r1", "montant", "25");
    ecran.ouvrir("r1"); // « Fermer »
    assert.match(ecran.ligneDe("r1")!.textContent!, /modifications non enregistrées/);
    ecran.cliquer("Toutes");
    ecran.cliquer("À renseigner");
    ecran.ouvrir("r1");
    assert.equal(ecran.ligneDe("r1")!.querySelector<HTMLSelectElement>('select[id$="-montant"]')!.value, "25");
    ecran.demonter();
  });
});

describe("Bouton « Enregistrer »", () => {
  test("bouton primaire Novanta (btn-add), désactivé sans changement, actif dès qu'un champ change", () => {
    const ecran = rendre();
    ecran.ouvrir("fc2");
    assert.ok(ecran.bouton("fc2").classList.contains("btn-add"));
    assert.equal(ecran.bouton("fc2").textContent, "Enregistrer");
    assert.equal(ecran.bouton("fc2").disabled, true);
    ecran.choisir("fc2", "proba", "75");
    assert.equal(ecran.bouton("fc2").disabled, false);
    ecran.choisir("fc2", "proba", "100");
    assert.equal(ecran.bouton("fc2").disabled, true, "revenu à la valeur enregistrée : rien à enregistrer");
    ecran.demonter();
  });

  test("ligne « À renseigner » inchangée : l'enregistrement vaut validation, le bouton est actif", () => {
    const ecran = rendre();
    ecran.ouvrir("ad1");
    assert.equal(ecran.bouton("ad1").disabled, false);
    ecran.demonter();
  });

  test("édition hors filtre « À renseigner » : enregistrée, la ligne rejoint le bon filtre", async () => {
    const ecran = rendre();
    ecran.ouvrir("fc2");
    ecran.choisir("fc2", "proba", "75");
    await act(async () => ecran.clic(ecran.bouton("fc2")));
    assert.match(ecran.ligneDe("fc2")!.textContent!, /Hypothèse enregistrée/);
    ecran.cliquer("75 %");
    assert.deepEqual(ecran.lignesAffichees(), ["fc2"]);
    ecran.demonter();
  });
});

describe("Colonnes de certitude", () => {
  test("Certitude du montant et Certitude de la date, distinctes et côte à côte", () => {
    const ecran = rendre();
    const entete = Array.from(ecran.conteneur.querySelector(".proba-ligne__entete")!.children).map((e) => e.textContent);
    assert.deepEqual(entete, ["Ligne", "Montant", "Certitude du montant", "Date", "Certitude de la date", "Probabilité", ""]);
    ecran.demonter();
  });

  test("valeurs utilisées par le moteur, même nomenclature que l'édition", () => {
    const ecran = rendre();
    // Facture client : montant certain, date selon les habitudes de paiement (« Approximative »).
    assert.equal(ecran.colonne("fc1", "Certitude du montant"), "Certain");
    assert.equal(ecran.colonne("fc1", "Certitude de la date"), "Approximative");
    // Charge fixe : montant certain, début ferme.
    assert.equal(ecran.colonne("cf1", "Certitude du montant"), "Certain");
    assert.equal(ecran.colonne("cf1", "Certitude de la date"), "Ferme");
    assert.match(ecran.colonne("cf1", "Date")!, /début · 2 échéances/);
    ecran.demonter();
  });
});

describe("Écran des hypothèses : non-régression", () => {
  test("étages repliables avec résumé, lignes triées, cartouche « À renseigner » qui filtre", () => {
    const ecran = rendre();
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
    const ecran = rendre();
    ecran.cliquer("50 %");
    assert.equal(ecran.lignesAffichees().length, 0);
    assert.match(ecran.conteneur.textContent!, /Aucune hypothèse pour ce filtre/);
    ecran.cliquer("Toutes");
    assert.equal(ecran.lignesAffichees().length, 8);
    ecran.demonter();
  });

  test("champs selon le type : facture sans montant, rentrée avec montant cible et certitude", () => {
    const ecran = rendre();
    const facture = ecran.ouvrir("fc2");
    assert.equal(facture.querySelector(".proba-editeur")!.textContent!.includes("Certitude du montant"), false);
    assert.equal(facture.textContent!.includes("Certitude de la date"), true);
    const rentree = ecran.ouvrir("r1");
    assert.equal(rentree.textContent!.includes("Montant cible par échéance"), true);
    assert.equal(rentree.textContent!.includes("Certitude de la date de début"), true);
    ecran.demonter();
  });

  test("aucun jargon statistique à l'écran", () => {
    const ecran = rendre();
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

// ---------------------------------------------------------------------------------------------
// Perspectives pondérées : renommage, recherche, valeurs de référence
// ---------------------------------------------------------------------------------------------

describe("Onglet « Perspectives pondérées »", () => {
  test("l'onglet de Futur s'appelle exactement « Perspectives pondérées » ; l'ancien libellé a disparu", () => {
    const page = readFileSync(join(__dirname, "../app/page.tsx"), "utf8");
    assert.match(page, /\{ cle: "risque", libelle: "Perspectives pondérées" \}/);
    assert.equal(/Risque de tr[ée]so/.test(page), false);
    // Les deux autres onglets ne sont pas renommés.
    assert.match(page, /libelle: "Flux de tréso"/);
    assert.match(page, /libelle: "Fiabilité de la projection"/);
  });
});

const FLUX_TIERS: FluxProjete[] = [
  flux("facture_client", "fc1", 25_000, "2026-11-30", "FC-2026-101 — Dupont Industries"),
  flux("facture_client", "fc2", 12_000, "2026-12-03", "FC-2026-102 — Éléonore Conseil"),
  flux("facture_client", "fc3", 4_000, "2026-12-08", "FC-2026-103 — Dupont Industries"),
  flux("rentree_reguliere", "r1", 8_000, "2026-12-05", "Abonnements Dupont"),
  flux("charge_fixe", "cf1", -4_500, "2026-12-01", "Salaires"),
  flux("facture_fournisseur", "ff1", -15_000, "2026-12-10", "FF-88 — Dupuis Matériaux"),
];

describe("Recherche (modèle)", () => {
  const lignes = construireLignesHypotheses(FLUX_TIERS, new Map(), groupeDeTiers);
  const trouver = (recherche: string, filtre: Parameters<typeof grouperHypotheses>[1] = "toutes") =>
    grouperHypotheses(lignes, filtre, recherche).flatMap((g) => g.lignes.map((l) => l.sourceId));

  test("par libellé, par tiers, par numéro de facture", () => {
    assert.deepEqual(trouver("salaires"), ["cf1"]);
    assert.deepEqual(trouver("Dupont"), ["fc1", "fc3", "r1"].sort((a, b) => ["fc1", "r1", "fc3"].indexOf(a) - ["fc1", "r1", "fc3"].indexOf(b)));
    assert.deepEqual(trouver("FF-88"), ["ff1"]);
  });

  test("insensible à la casse et aux accents", () => {
    assert.deepEqual(trouver("DUPUIS"), ["ff1"]);
    assert.deepEqual(trouver("eleonore"), ["fc2"]);
  });

  test("par type de ligne, étage P&L et montant", () => {
    assert.deepEqual(trouver("charge fixe"), ["cf1"]);
    assert.deepEqual(trouver("coûts de structure"), ["cf1"]);
    assert.deepEqual(trouver("25 000"), ["fc1"]);
    assert.deepEqual(trouver("25000"), ["fc1"]);
  });

  test("combinée aux filtres, groupes vides masqués, tri par impact conservé", () => {
    // « Dupont » : 3 encaissements, triés 25 000 / 8 000 / 4 000 ; aucun autre groupe affiché.
    const groupes = grouperHypotheses(lignes, "toutes", "dupont");
    assert.deepEqual(groupes.map((g) => g.libelle), ["Encaissements"]);
    assert.deepEqual(groupes[0].lignes.map((l) => l.sourceId), ["fc1", "r1", "fc3"]);
    // + filtre « À renseigner » : seule la rentrée régulière (à renseigner par défaut).
    assert.deepEqual(trouver("dupont", "a_renseigner"), ["r1"]);
    // + filtre 100 % : les factures, pas la rentrée à renseigner.
    assert.deepEqual(trouver("dupont", 100), ["fc1", "fc3"]);
  });

  test("recherche vide : tout ; aucun résultat : aucun groupe", () => {
    assert.equal(trouver("  ").length, 6);
    assert.deepEqual(grouperHypotheses(lignes, "toutes", "zzz"), []);
  });
});

function groupeDeTiers(source: SourceFlux): CleGroupeHypotheses {
  if (source === "facture_client" || source === "rentree_reguliere") return "revenue";
  if (source === "charge_fixe") return "ebitda";
  return "gross_margin";
}

describe("Recherche (écran)", () => {
  test("barre de recherche Novanta, filtrage instantané, combinaison avec « À renseigner », effacement, aucun résultat", () => {
    const ecran = rendre(FLUX);
    const champ = ecran.conteneur.querySelector<HTMLInputElement>(".barre-recherche__input")!;
    assert.equal(champ.placeholder, "Rechercher une transaction…");
    const taper = (texte: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(champ, texte);
        champ.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    taper("FC2");
    assert.deepEqual(ecran.lignesAffichees(), ["fc2"]);
    assert.deepEqual(
      Array.from(ecran.conteneur.querySelectorAll(".proba-groupe__resume")).map((e) => e.textContent!.split(" — ")[0]),
      ["Encaissements"],
      "groupes sans résultat masqués"
    );
    taper("r1");
    ecran.cliquer("À renseigner");
    assert.deepEqual(ecran.lignesAffichees(), ["r1"]);
    assert.equal(champ.value, "r1", "le filtre ne réinitialise pas la recherche");
    taper("introuvable");
    assert.match(ecran.conteneur.textContent!, /Aucune transaction ne correspond à votre recherche\./);
    ecran.cliquer("Toutes");
    assert.equal(champ.value, "introuvable", "la recherche ne réinitialise pas le filtre ni l'inverse");
    act(() => ecran.clic(ecran.conteneur.querySelector(".barre-recherche__effacer")!));
    assert.equal(ecran.lignesAffichees().length, 8);
    ecran.demonter();
  });
});

describe("Valeurs de référence pendant le choix de la certitude", () => {
  // Espaces insécables des montants et dates formatés ramenées à des espaces simples.
  const reference = (li: Element, n: number) => Array.from(li.querySelectorAll(".proba-editeur__reference"))[n].textContent!.replace(/[\u202f\u00a0]/g, " ");

  test("date : la date prévue utilisée par le moteur, et l'échéance d'où partent les retards", () => {
    const ecran = rendre();
    const li = ecran.ouvrir("fc1");
    assert.equal(reference(li, 0), "Date prévue01 déc. 2026Échéance de la facture : 20 nov. 2026");
    ecran.choisir("fc1", "date", "25");
    assert.equal(reference(ecran.ligneDe("fc1")!, 0), "Date prévue01 déc. 2026Échéance de la facture : 20 nov. 2026", "toujours visible pendant l'édition");
    ecran.demonter();
  });

  test("date de début d'une série", () => {
    const ecran = rendre();
    const li = ecran.ouvrir("cf1");
    assert.equal(reference(li, 0), "Début prévu01 déc. 2026, puis 1 échéance");
    assert.match(li.textContent!, /Certitude de la date de début/);
    ecran.demonter();
  });

  test("montant : la valeur cible, mise à jour dès la saisie, conservée pendant le choix de la certitude, enregistrée en une fois", async () => {
    const ecran = rendre();
    ecran.cliquer("À renseigner");
    const li = ecran.ouvrir("r1");
    assert.equal(reference(li, 0), "Montant prévu8 000 € par échéance");
    act(() => {
      const champ = ecran.ligneDe("r1")!.querySelector<HTMLInputElement>('input[id$="-cible"]')!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(champ, "9000");
      champ.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(reference(ecran.ligneDe("r1")!, 0), "Montant prévu9 000 € par échéance");
    ecran.choisir("r1", "montant", "50");
    assert.equal(reference(ecran.ligneDe("r1")!, 0), "Montant prévu9 000 € par échéance");
    assert.match(ecran.ligneDe("r1")!.textContent!.replace(/[\u202f\u00a0]/g, " "), /8 fois sur 10 entre 6 750 € et 11 250 € par échéance/);
    ecran.choisir("r1", "date", "75");
    assert.equal(ecran.appels.length, 0, "rien n'est enregistré avant « Enregistrer »");
    assert.ok(ecran.lignesAffichees().includes("r1"));
    await act(async () => ecran.clic(ecran.bouton("r1")));
    assert.deepEqual(
      [ecran.appels[0].h.montantCible, ecran.appels[0].h.fiabiliteMontant, ecran.appels[0].h.fiabiliteDate],
      [9_000, 50, 75]
    );
    assert.equal(ecran.lignesAffichees().includes("r1"), false, "renseignée : sortie du filtre après l'enregistrement");
    ecran.cliquer("Toutes");
    // La colonne Montant suit la valeur cible enregistrée, comme le moteur (2 échéances × 9 000 €).
    assert.match(ecran.ligneDe("r1")!.querySelector(".proba-ligne__montant")!.textContent!, /18\s000/);
    ecran.demonter();
  });

  test("montants variables d'une échéance à l'autre : le total de l'horizon, sans montant inventé", () => {
    const lignes = construireLignesHypotheses(
      [flux("rentree_reguliere", "rs", 1_000, "2026-12-01"), flux("rentree_reguliere", "rs", 3_000, "2027-01-01")],
      new Map(),
      () => "revenue"
    );
    assert.equal(lignes[0].montantParEcheance, null);
    assert.equal(lignes[0].impact, 4_000);
  });
});
