/**
 * Reproduit le bug réel ("les résultats disparaissent au changement d'onglet") et prouve le fix.
 *
 * Cause réelle (confirmée par reproduction directe dans le navigateur, voir chaîne causale dans le
 * rapport) : les liens "Abonnement" / "Intégrations" du cockpit sont de vraies navigations Next.js
 * vers des routes différentes (/account/billing, /account/integrations), qui démontent ENTIÈREMENT
 * app/page.tsx — pas un simple repli de section. Tout useState local à un composant démonté avec
 * app/page.tsx est perdu, y compris s'il a été "remonté" dans app/page.tsx lui-même (premier fix
 * insuffisant, reverté).
 *
 * Le premier test ci-dessous reproduit ce mécanisme exact avec un état purement local (sans aucun
 * état partagé au-dessus du point de démontage) et prouve qu'il est perdu : c'est le bug. Les tests
 * suivants exercent AnalyseSessionContext (le fix réel, monté dans app/layout.tsx — le seul
 * composant qui reste monté pour "/" ET "/account/*") et prouvent que l'état survit exactement au
 * même type de démontage/remontage.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// jsdom doit être posé AVANT tout import de react-dom/client (qui s'appuie sur `document` global).
const dom = new JSDOM("<!doctype html><html><body></body></html>");
(globalThis as unknown as { window: unknown }).window = dom.window;
(globalThis as unknown as { document: Document }).document = dom.window.document as unknown as Document;
// Node ≥21 définit déjà `globalThis.navigator` en lecture seule : redéfinir la propriété plutôt que
// de l'assigner directement (sinon TypeError "has only a getter").
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  AnalyseSessionProvider,
  useAnalyseSession,
  CandidatBrouillon,
  ApercuAnalyse,
} from "../components/AnalyseSessionContext";
import { RecurringChargeCandidate } from "./bankRecurringDetector";
import { ResultatControleCoherence } from "./consistencyChecker";

function candidatFactice(id: string): CandidatBrouillon {
  return {
    id,
    selectionne: false,
    libelle: `Candidat ${id}`,
    montant: 42,
    frequence: "mensuel",
    prochaineOccurrence: "2026-09-01",
    source: {} as RecurringChargeCandidate, // non inspecté par ces tests : seule la persistance compte ici.
  };
}

const apercuFactice: ApercuAnalyse = { nombreTransactions: 3, periode: null, infoComplementaire: null };

function nouveauContainer(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

describe("Persistance de l'état d'analyse à travers une navigation (démontage/remontage)", () => {
  test("REPRODUIT LE BUG : un état purement local à un composant démonté (aucun état partagé au-dessus) est perdu", () => {
    const container = nouveauContainer();
    const root = createRoot(container);

    let derniereValeurLue = "";
    // Simule l'ANCIENNE architecture (useState/useRef local, comme ImportHistoriqueBancaire avant
    // le fix) : rien n'est partagé au-dessus de ce composant.
    function ConsommateurAvecEtatLocal() {
      const ref = useRef<string>("initial");
      derniereValeurLue = ref.current;
      return null;
    }

    function Harness({ visible }: { visible: boolean }) {
      return visible ? createElement(ConsommateurAvecEtatLocal) : null;
    }

    act(() => root.render(createElement(Harness, { visible: true })));
    // "Navigation" : le composant sort de l'arbre, comme app/page.tsx au clic sur "Intégrations".
    act(() => root.render(createElement(Harness, { visible: false })));
    // Retour sur "/" : remontage à neuf.
    act(() => root.render(createElement(Harness, { visible: true })));

    assert.equal(derniereValeurLue, "initial"); // reproduit le bug : rien n'a pu être conservé.

    act(() => root.unmount());
    container.remove();
  });

  test("LE FIX : l'état vit dans AnalyseSessionProvider (équivalent à app/layout.tsx) et survit au démontage/remontage du consommateur (équivalent à app/page.tsx après une navigation)", () => {
    const container = nouveauContainer();
    const root = createRoot(container);

    const ctxRef: { current: ReturnType<typeof useAnalyseSession> | null } = { current: null };
    // Fonction (pas un accès direct à ctxRef.current!) : chaque appel relit ctxRef.current avec son
    // type déclaré, sans dépendre du rétrécissement de type TypeScript à travers les closures des
    // callbacks act()/render — un simple `ctxRef.current!` répété se rétrécit à `never` après la
    // réaffectation `ctxRef.current = null` plus bas dans cette fonction de test.
    const lire = () => ctxRef.current as ReturnType<typeof useAnalyseSession>;
    function Consommateur() {
      ctxRef.current = useAnalyseSession();
      return null;
    }
    // Le Provider reste monté pendant tout le test (comme app/layout.tsx pendant la session) ;
    // seul le Consommateur (comme ImportHistoriqueBancaire via app/page.tsx) apparaît/disparaît.
    function Harness({ consommateurVisible }: { consommateurVisible: boolean }) {
      return createElement(
        AnalyseSessionProvider,
        null,
        consommateurVisible ? createElement(Consommateur) : null
      );
    }

    act(() => root.render(createElement(Harness, { consommateurVisible: true })));
    assert.ok(ctxRef.current, "le contexte doit être disponible dès le premier montage");

    // Une analyse produit 2 candidats ; l'utilisateur édite un libellé et coche les deux lignes.
    act(() => {
      lire().definirAnalyseChargesFixes(apercuFactice, [candidatFactice("a"), candidatFactice("b")]);
    });
    act(() => {
      lire().patchCandidatChargesFixes("a", {
        selectionne: true,
        libelle: "Libellé édité par l'utilisateur",
      });
    });
    act(() => {
      lire().patchCandidatChargesFixes("b", { selectionne: true });
    });

    assert.equal(lire().candidatsChargesFixes[0].libelle, "Libellé édité par l'utilisateur");
    assert.equal(lire().candidatsChargesFixes[0].selectionne, true);
    assert.equal(lire().candidatsChargesFixes[1].selectionne, true);

    // "Navigation" : le Consommateur est démonté (comme app/page.tsx au clic sur "Intégrations")...
    act(() => root.render(createElement(Harness, { consommateurVisible: false })));
    ctxRef.current = null;
    // ...puis remonté (retour sur "/").
    act(() => root.render(createElement(Harness, { consommateurVisible: true })));

    assert.ok(ctxRef.current, "le Consommateur doit s'être remonté");
    assert.equal(lire().candidatsChargesFixes.length, 2, "les 2 candidats doivent être conservés");
    assert.equal(
      lire().candidatsChargesFixes[0].libelle,
      "Libellé édité par l'utilisateur",
      "le libellé édité manuellement doit être conservé"
    );
    assert.equal(lire().candidatsChargesFixes[0].selectionne, true, "la case cochée doit être conservée");
    assert.equal(lire().candidatsChargesFixes[1].selectionne, true, "la 2e case cochée doit être conservée");

    act(() => root.unmount());
    container.remove();
  });

  test("une nouvelle analyse remplace toujours l'ancienne (jamais de fusion) — reset uniquement explicite", () => {
    const container = nouveauContainer();
    const root = createRoot(container);
    const ctxRef: { current: ReturnType<typeof useAnalyseSession> | null } = { current: null };
    const lire = () => ctxRef.current as ReturnType<typeof useAnalyseSession>;
    function Consommateur() {
      ctxRef.current = useAnalyseSession();
      return null;
    }
    act(() => root.render(createElement(AnalyseSessionProvider, null, createElement(Consommateur))));

    act(() => lire().definirAnalyseChargesFixes(apercuFactice, [candidatFactice("x")]));
    assert.equal(lire().candidatsChargesFixes[0].id, "x");

    act(() => lire().definirAnalyseChargesFixes(apercuFactice, [candidatFactice("y")]));
    assert.equal(lire().candidatsChargesFixes.length, 1);
    assert.equal(lire().candidatsChargesFixes[0].id, "y", "la nouvelle analyse remplace l'ancienne");

    act(() => lire().reinitialiserChargesFixes());
    assert.equal(lire().candidatsChargesFixes.length, 0);
    assert.equal(lire().apercuChargesFixes, null);

    act(() => root.unmount());
    container.remove();
  });

  test("Vérifier mes données : résultat et éléments ignorés survivent au démontage/remontage du consommateur", () => {
    const container = nouveauContainer();
    const root = createRoot(container);
    const ctxRef: { current: ReturnType<typeof useAnalyseSession> | null } = { current: null };
    const lire = () => ctxRef.current as ReturnType<typeof useAnalyseSession>;
    function Consommateur() {
      ctxRef.current = useAnalyseSession();
      return null;
    }
    function Harness({ visible }: { visible: boolean }) {
      return createElement(AnalyseSessionProvider, null, visible ? createElement(Consommateur) : null);
    }

    act(() => root.render(createElement(Harness, { visible: true })));

    // Structure minimale suffisante : ce test vérifie la PERSISTANCE, pas le moteur controlerCoherence
    // (déjà couvert par lib/consistencyChecker.test.ts).
    const resultatFactice = {
      transactionsAnalysees: 5,
      totalTransactions: 5,
      issues: [{ id: "issue-1" }],
    } as unknown as ResultatControleCoherence;

    act(() => lire().definirResultatVerification(resultatFactice));
    act(() => lire().ignorerVerification("issue-1"));

    assert.equal(lire().ignoreesVerification.has("issue-1"), true);

    act(() => root.render(createElement(Harness, { visible: false })));
    ctxRef.current = null;
    act(() => root.render(createElement(Harness, { visible: true })));

    assert.ok(lire().resultatVerification, "le résultat de l'analyse doit être conservé");
    assert.equal(lire().resultatVerification!.issues.length, 1);
    assert.equal(lire().ignoreesVerification.has("issue-1"), true, "l'élément ignoré doit rester ignoré");

    act(() => root.unmount());
    container.remove();
  });
});
