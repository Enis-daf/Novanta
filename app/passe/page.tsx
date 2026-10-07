"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import LoginForm from "@/components/LoginForm";
import NavigationModules from "@/components/NavigationModules";
import { supabase, supabaseConfigured } from "@/lib/supabaseClient";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { moduleActifPourOrganisation, ROUTE_FUTUR } from "@/lib/organizationModules";

export default function PassePage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [sessionChargee, setSessionChargee] = useState(false);
  // Fail-closed, comme le cockpit : la page ne s'affiche que si l'entitlement "past" de la société
  // courante a été explicitement confirmé. Tout autre cas (module absent/désactivé, erreur, mode
  // local sans Supabase) renvoie vers Futur.
  const [autorise, setAutorise] = useState(false);

  useEffect(() => {
    if (!supabaseConfigured) {
      router.replace(ROUTE_FUTUR);
      return;
    }

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
  }, [router]);

  useEffect(() => {
    setAutorise(false);
    if (!supabaseConfigured || !session) return;

    let annule = false;

    (async () => {
      // getUser() revérifie réellement le compte auprès de Supabase (voir app/page.tsx).
      const { data: userData, error: userError } = await supabase!.auth.getUser();
      if (annule) return;
      if (userError || !userData.user) {
        await supabase!.auth.signOut();
        return;
      }

      const company = await getOrCreateCompanyForBilling(supabase!, userData.user);
      if (annule) return;
      if (!company.accessEnabled) {
        router.replace("/account/billing");
        return;
      }

      const actif = await moduleActifPourOrganisation(supabase!, company.id, "past");
      if (annule) return;
      if (!actif) {
        router.replace(ROUTE_FUTUR);
        return;
      }
      setAutorise(true);
    })().catch((error) => {
      if (annule) return;
      console.error("Échec de la vérification d'accès au module Passé :", error);
      router.replace(ROUTE_FUTUR);
    });

    return () => {
      annule = true;
    };
  }, [session, router]);

  if (supabaseConfigured && sessionChargee && !session) {
    return <LoginForm />;
  }

  if (!session || !autorise) {
    return <main className="cockpit-chargement">Vérification de votre accès…</main>;
  }

  return (
    <main className="cockpit">
      <header className="page-intro">
        <div className="page-intro__texte">
          <h1 className="page-intro__titre-compact">
            <span className="page-intro__marque">Novanta</span>
            <span className="page-intro__produit"> — cockpit de trésorerie</span>
          </h1>
        </div>
        <div className="page-intro__actions">
          <span className="page-intro__email">{session.user.email}</span>
          <NavigationModules moduleActif="passe" passeDisponible />
          <Link href="/account/billing" className="btn-secondaire">
            Abonnement
          </Link>
          <Link href="/account/integrations" className="btn-secondaire">
            Intégrations
          </Link>
          <button type="button" className="btn-deconnexion" onClick={() => supabase!.auth.signOut()}>
            Se déconnecter
          </button>
        </div>
      </header>
    </main>
  );
}
