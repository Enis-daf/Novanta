"use client";

// DIAGNOSTIC TEMPORAIRE, lecture seule — à retirer avant toute fusion dans main. Lit les factures
// fournisseurs Pennylane, puis les transactions rapprochées et paiements d'un sous-ensemble, et
// propose le tout en téléchargement (voir app/api/pennylane/diagnostic).
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, supabaseConfigured } from "@/lib/supabaseClient";
import LoginForm from "@/components/LoginForm";

const TAILLE_LOT = 8;
const PAUSE_ENTRE_LOTS_MS = 3500; // 16 appels par lot : reste sous la limite Pennylane de 25 requêtes / 5 s
const NOMBRE_TEMOINS_PAYES = 40;
// Deux objets Pennylane au numéro presque identique : doublon ou factures distinctes ?
const NUMEROS_A_COMPARER = ["#594119819", "594119819", "#534597594", "534597594", "#520609672", "520609672"];

interface FactureListe {
  id: string;
  paid: unknown;
  accounting_status: string | null;
  archived_at: string | null;
}

export default function DiagnosticPennylanePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionChargee, setSessionChargee] = useState(!supabaseConfigured);
  const [enCours, setEnCours] = useState(false);
  const [etat, setEtat] = useState("");
  const [lien, setLien] = useState<string | null>(null);
  const [brut, setBrut] = useState("");

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

  const appeler = async (corps: unknown) => {
    const res = await fetch("/api/pennylane/diagnostic", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(corps),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  const lancer = async () => {
    setEnCours(true);
    setLien(null);
    try {
      setEtat("Lecture des factures fournisseurs…");
      const liste = await appeler({ mode: "liste" });
      const factures: FactureListe[] = liste.factures;
      const actives = factures.filter((f) => f.accounting_status !== "archived" && !f.archived_at);
      // Toutes les actives que Pennylane ne dit pas payées, plus quelques actives payées comme témoins.
      const ids = [
        ...actives.filter((f) => f.paid !== true).map((f) => f.id),
        ...actives.filter((f) => f.paid === true).slice(0, NOMBRE_TEMOINS_PAYES).map((f) => f.id),
      ];
      const details: unknown[] = [];
      for (let debut = 0; debut < ids.length; debut += TAILLE_LOT) {
        setEtat(`Rapprochements et paiements : ${Math.min(debut + TAILLE_LOT, ids.length)} / ${ids.length}…`);
        const lot = await appeler({ mode: "detail", ids: ids.slice(debut, debut + TAILLE_LOT) });
        details.push(...lot.details);
        if (debut + TAILLE_LOT < ids.length) await new Promise((r) => setTimeout(r, PAUSE_ENTRE_LOTS_MS));
      }
      const blob = new Blob([JSON.stringify({ ...liste, details }, null, 1)], { type: "application/json" });
      setLien(URL.createObjectURL(blob));
      setEtat(`Terminé : ${factures.length} factures lues, ${details.length} détaillées.`);
    } catch (erreur) {
      setEtat(`Interrompu : ${erreur instanceof Error ? erreur.message : "erreur inattendue"}`);
    } finally {
      setEnCours(false);
    }
  };

  const comparer = async () => {
    setEnCours(true);
    setBrut("");
    try {
      setBrut(JSON.stringify(await appeler({ mode: "brut", numeros: NUMEROS_A_COMPARER }), null, 2));
    } catch (erreur) {
      setBrut(`Interrompu : ${erreur instanceof Error ? erreur.message : "erreur inattendue"}`);
    } finally {
      setEnCours(false);
    }
  };

  return (
    <main className="ecran-editorial">
      <h1>Diagnostic Pennylane</h1>
      <p>Lecture seule : aucune synchronisation, aucune écriture. Compter une à deux minutes.</p>
      <button className="btn-secondaire" onClick={lancer} disabled={enCours}>
        {enCours ? "Lecture en cours…" : "Lancer le diagnostic"}
      </button>
      <button className="btn-secondaire" onClick={comparer} disabled={enCours}>
        Comparer les factures Shopify
      </button>
      {brut && (
        <>
          <button className="btn-secondaire" onClick={() => navigator.clipboard.writeText(brut)}>
            Copier
          </button>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{brut}</pre>
        </>
      )}
      <p>{etat}</p>
      {lien && (
        <a className="btn-secondaire" href={lien} download="diagnostic-pennylane.json">
          Télécharger diagnostic-pennylane.json
        </a>
      )}
    </main>
  );
}
