"use client";

// DIAGNOSTIC TEMPORAIRE, lecture seule — à retirer avant toute fusion dans main. Affiche la réponse
// brute de Pennylane pour les factures listées ci-dessous (voir app/api/pennylane/diagnostic).
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, supabaseConfigured } from "@/lib/supabaseClient";
import LoginForm from "@/components/LoginForm";

const FOURNISSEURS = [
  "16-03-2026 14:50:04", "2286560009",
  "#520609672", "#534597594", "#594119819", "594119819",
  "SPA3LESU-2026-06", "SPA3LESU-2026-07", "SPA3LESU-2026-08", "SPA3LESU-2026-09",
  "FR-AEU-2026-865020", "FR-AEU-2026-902342", "FR-AEU-2026-865018", "FR-AEU-2026-923132",
  "FAC-202610887016",
  "2025-10-5607",
];
const CLIENTS = ["F20251002-15484", "F20251003-15488", "F20251021-15514", "F20260107-15582", "F20260110-15584", "F20260113-15586"];

export default function DiagnosticPennylanePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionChargee, setSessionChargee] = useState(!supabaseConfigured);
  const [enCours, setEnCours] = useState(false);
  const [resultat, setResultat] = useState("");

  useEffect(() => {
    if (!supabaseConfigured) return;
    supabase!.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionChargee(true);
    });
    const {
      data: { subscription },
    } = supabase!.auth.onAuthStateChange((_event, newSession) => setSession(newSession));
    return () => subscription.unsubscribe();
  }, []);

  if (!sessionChargee) return <main className="cockpit-chargement">Chargement…</main>;
  if (!session) return <LoginForm />;

  const lancer = async () => {
    setEnCours(true);
    setResultat("");
    try {
      const res = await fetch("/api/pennylane/diagnostic", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fournisseurs: FOURNISSEURS, clients: CLIENTS }),
      });
      setResultat(JSON.stringify(await res.json(), null, 2));
    } catch {
      setResultat("Appel impossible.");
    } finally {
      setEnCours(false);
    }
  };

  return (
    <main className="ecran-editorial">
      <h1>Diagnostic Pennylane</h1>
      <p>Lecture seule : aucune synchronisation, aucune écriture.</p>
      <button className="btn-secondaire" onClick={lancer} disabled={enCours}>
        {enCours ? "Lecture en cours…" : "Lire la réponse brute de Pennylane"}
      </button>
      {resultat && (
        <>
          <button className="btn-secondaire" onClick={() => navigator.clipboard.writeText(resultat)}>
            Copier
          </button>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{resultat}</pre>
        </>
      )}
    </main>
  );
}
