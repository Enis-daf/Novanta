"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { supabase, supabaseConfigured } from "@/lib/supabaseClient";
import LoginForm from "@/components/LoginForm";
import PennylaneIntegration from "@/components/PennylaneIntegration";

export default function IntegrationsPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionChargee, setSessionChargee] = useState(!supabaseConfigured);

  useEffect(() => {
    if (!supabaseConfigured) return;

    supabase!.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionChargee(true);
    });

    const {
      data: { subscription },
    } = supabase!.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (supabaseConfigured && !sessionChargee) {
    return <main className="cockpit-chargement">Chargement…</main>;
  }

  if (supabaseConfigured && !session) {
    return <LoginForm />;
  }

  return (
    <main className="billing-page">
      <div className="billing-page__header">
        <Link href="/" className="btn-secondaire">
          ← Retour au cockpit
        </Link>
        {session && <span className="billing-page__email">{session.user.email}</span>}
      </div>

      {!supabaseConfigured && (
        <div className="billing-card">
          <h1>Pennylane</h1>
          <p>L&apos;intégration Pennylane nécessite Supabase (.env.local) — non disponible en mode local.</p>
        </div>
      )}

      {supabaseConfigured && session && <PennylaneIntegration session={session} />}
    </main>
  );
}
