"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import LoginForm from "@/components/LoginForm";
import EnTeteCockpit from "@/components/EnTeteCockpit";
import ActionChantier from "@/components/ActionChantier";
import { supabase, supabaseConfigured } from "@/lib/supabaseClient";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { moduleActifPourOrganisation, ROUTE_FUTUR } from "@/lib/organizationModules";
import { chargerDroitsOrganisation, DroitsOrganisation } from "@/lib/offres";
import OffreVerrouillee from "@/components/OffreVerrouillee";
import { moduleActionActif } from "@/lib/featureFlags";

export default function ActionPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [sessionChargee, setSessionChargee] = useState(false);
  // Fail-closed, comme le module Passé dont il lit les données : la page ne s'affiche que si
  // l'entitlement "past" de la société courante a été explicitement confirmé. Tout autre cas (module absent/désactivé, erreur, mode
  // local sans Supabase) renvoie vers Futur.
  const [autorise, setAutorise] = useState(false);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  // Droits de l'offre : Action n'est monté que pour une offre qui l'inclut (lib/offres.ts).
  const [droits, setDroits] = useState<DroitsOrganisation | null>(null);

  useEffect(() => {
    if (!supabaseConfigured || !moduleActionActif()) {
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

  // L'accès se revérifie quand L'UTILISATEUR change, pas quand l'objet de session change : Supabase
  // réémet la session (nouvel objet, même utilisateur) à chaque retour sur l'onglet du navigateur
  // et à chaque rafraîchissement de jeton. Dépendre de `session` relançait alors la vérification,
  // repassait par l'écran d'attente et démontait tout le module — qui perdait sa période, ses
  // filtres et son onglet courant.
  const userId = session?.user.id ?? null;

  useEffect(() => {
    setAutorise(false);
    setOrganizationId(null);
    setDroits(null);
    if (!supabaseConfigured || !userId) return;

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
      const droitsOffre = await chargerDroitsOrganisation(supabase!, company.id);
      if (annule) return;
      setDroits(droitsOffre);
      setOrganizationId(company.id);
      setAutorise(true);
    })().catch((error) => {
      if (annule) return;
      console.error("Échec de la vérification d'accès au module Action :", error);
      router.replace(ROUTE_FUTUR);
    });

    return () => {
      annule = true;
    };
  }, [userId, router]);

  if (supabaseConfigured && sessionChargee && !session) {
    return <LoginForm />;
  }

  if (!session || !autorise || !organizationId || !droits) {
    return <main className="cockpit-chargement">Vérification de votre accès…</main>;
  }

  return (
    <main className="cockpit">
      <EnTeteCockpit
        moduleActif="action"
        compte={{ email: session.user.email, passeDisponible: true, onDeconnexion: () => supabase!.auth.signOut() }}
      />
      {droits.capacites.canViewActions ? (
        // `key` : une organisation = une instance du module.
        <ActionChantier key={organizationId} organizationId={organizationId} accessToken={session.access_token} droits={droits} />
      ) : (
        <OffreVerrouillee capacite="canViewActions" fonctionnalite="Le module Action" offreActuelle={droits.offreEffective} />
      )}
    </main>
  );
}
