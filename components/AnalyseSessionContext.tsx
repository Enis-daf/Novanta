"use client";

/**
 * État TEMPORAIRE de session partagé par "Identifier mes charges fixes" et "Vérifier mes données".
 *
 * POURQUOI ICI (monté dans app/layout.tsx, au-dessus de {children}) ET PAS DANS app/page.tsx :
 * app/page.tsx n'est PAS le parent qui reste réellement monté pendant la session. Les liens
 * "Abonnement" / "Intégrations" en haut du cockpit sont de vraies navigations Next.js vers des
 * routes différentes (/account/billing, /account/integrations) — pas des onglets internes. Une
 * navigation de route démonte ENTIÈREMENT app/page.tsx (confirmé par reproduction directe : les
 * refs React de l'arbre changent totalement après un aller-retour), donc tout useState local à
 * ImportHistoriqueBancaire / VerifierMesDonnees, ou même remonté dans app/page.tsx lui-même, est
 * perdu au retour sur "/". app/layout.tsx (RootLayout) est le SEUL composant qui reste monté pour
 * toute la durée de la session de navigation interne — il enveloppe "/" ET "/account/*" — d'où ce
 * Context placé juste au-dessus de {children} dans RootLayout.
 *
 * Portée volontairement V1 : mémoire uniquement (aucun sessionStorage/localStorage, aucune
 * persistance Supabase, aucune migration). Perdu à un rechargement complet de page — explicitement
 * accepté. Remplacé uniquement par une nouvelle analyse explicite (reinitialiserXxx est appelé par
 * les composants au tout début de chaque nouvel import XLSX / clic "Analyser Pennylane", et après
 * validation des Charges fixes) — jamais par un changement de section ou de route.
 */
// Import par défaut de React conservé (contrairement au reste du codebase, qui s'appuie sur le
// runtime JSX automatique) : lib/analyseSessionContext.test.ts exécute ce fichier via `tsx` en
// dehors du build Next.js, où le JSX est transformé en `React.createElement(...)` classique faute
// d'indication explicite dans tsconfig.json (jsx: "preserve", pensé pour SWC/Next). Sans cet import,
// le test échoue avec "React is not defined". Totalement inoffensif sous Next.js (import inutilisé
// mais sans effet).
import React, { createContext, ReactNode, useCallback, useContext, useState } from "react";
import { FrequenceDetectee, RecurringChargeCandidate } from "@/lib/bankRecurringDetector";
import { ResultatControleCoherence } from "@/lib/consistencyChecker";

export interface CandidatBrouillon {
  id: string;
  selectionne: boolean;
  libelle: string;
  montant: number;
  frequence: FrequenceDetectee;
  prochaineOccurrence: string;
  source: RecurringChargeCandidate;
}

// Résumé de la période analysée, indépendant de la source (XLSX ou Pennylane).
export interface ApercuAnalyse {
  nombreTransactions: number;
  periode: { debut: string; fin: string } | null;
  infoComplementaire: string | null;
}

interface AnalyseSessionValue {
  // Identifier mes charges fixes
  apercuChargesFixes: ApercuAnalyse | null;
  candidatsChargesFixes: CandidatBrouillon[];
  definirAnalyseChargesFixes: (apercu: ApercuAnalyse, candidats: CandidatBrouillon[]) => void;
  patchCandidatChargesFixes: (id: string, patch: Partial<CandidatBrouillon>) => void;
  reinitialiserChargesFixes: () => void;

  // Vérifier mes données
  resultatVerification: ResultatControleCoherence | null;
  ignoreesVerification: Set<string>;
  definirResultatVerification: (resultat: ResultatControleCoherence) => void;
  ignorerVerification: (id: string) => void;
  reinitialiserVerification: () => void;
}

const AnalyseSessionContext = createContext<AnalyseSessionValue | null>(null);

export function AnalyseSessionProvider({ children }: { children: ReactNode }) {
  const [apercuChargesFixes, setApercuChargesFixes] = useState<ApercuAnalyse | null>(null);
  const [candidatsChargesFixes, setCandidatsChargesFixes] = useState<CandidatBrouillon[]>([]);
  const [resultatVerification, setResultatVerification] = useState<ResultatControleCoherence | null>(null);
  const [ignoreesVerification, setIgnoreesVerification] = useState<Set<string>>(new Set());

  const definirAnalyseChargesFixes = useCallback((apercu: ApercuAnalyse, candidats: CandidatBrouillon[]) => {
    setApercuChargesFixes(apercu);
    setCandidatsChargesFixes(candidats);
  }, []);

  const patchCandidatChargesFixes = useCallback((id: string, patch: Partial<CandidatBrouillon>) => {
    setCandidatsChargesFixes((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const reinitialiserChargesFixes = useCallback(() => {
    setApercuChargesFixes(null);
    setCandidatsChargesFixes([]);
  }, []);

  const definirResultatVerification = useCallback((resultat: ResultatControleCoherence) => {
    setResultatVerification(resultat);
    setIgnoreesVerification(new Set());
  }, []);

  const ignorerVerification = useCallback((id: string) => {
    setIgnoreesVerification((prev) => new Set(prev).add(id));
  }, []);

  const reinitialiserVerification = useCallback(() => {
    setResultatVerification(null);
    setIgnoreesVerification(new Set());
  }, []);

  return (
    <AnalyseSessionContext.Provider
      value={{
        apercuChargesFixes,
        candidatsChargesFixes,
        definirAnalyseChargesFixes,
        patchCandidatChargesFixes,
        reinitialiserChargesFixes,
        resultatVerification,
        ignoreesVerification,
        definirResultatVerification,
        ignorerVerification,
        reinitialiserVerification,
      }}
    >
      {children}
    </AnalyseSessionContext.Provider>
  );
}

export function useAnalyseSession(): AnalyseSessionValue {
  const ctx = useContext(AnalyseSessionContext);
  if (!ctx) {
    throw new Error("useAnalyseSession doit être utilisé sous AnalyseSessionProvider (voir app/layout.tsx).");
  }
  return ctx;
}
