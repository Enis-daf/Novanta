"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { supabase, supabaseConfigured } from "@/lib/supabaseClient";
import { getOrCreateCompanyForBilling, CompanyBilling } from "@/lib/billing";
import type { OffrePayante } from "@/lib/offresStripe";
import type { PrixAffiche, SituationAbonnement } from "@/lib/offresAbonnement";
import LoginForm from "@/components/LoginForm";
import ChoixOffre from "@/components/ChoixOffre";

const LIBELLES_STATUT: Record<string, string> = {
  active: "Actif",
  trialing: "Période d'essai",
  past_due: "Paiement en retard",
  canceled: "Résilié",
  unpaid: "Impayé",
  incomplete: "Incomplet",
  incomplete_expired: "Expiré",
  paused: "En pause — moyen de paiement requis",
};

// Lue par /api/billing/offre : les Price IDs et les prix ne sont connus que du serveur.
type OffreAbonnement = SituationAbonnement & { prix: Partial<Record<OffrePayante, PrixAffiche | null>> };

// Situation affichée tant que la lecture n'a pas abouti (ou sans Supabase) : aucune action proposée.
const SITUATION_VIDE: OffreAbonnement = {
  offreActuelle: null,
  essai: null,
  souscriptionPossible: false,
  portailDisponible: false,
  prix: {},
};

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" });
}

export default function BillingPage() {
  return (
    <Suspense fallback={<main className="cockpit-chargement">Chargement…</main>}>
      <BillingPageContent />
    </Suspense>
  );
}

function BillingPageContent() {
  const searchParams = useSearchParams();
  const success = searchParams.get("success") === "true";
  const canceled = searchParams.get("canceled") === "true";

  const [session, setSession] = useState<Session | null>(null);
  const [sessionChargee, setSessionChargee] = useState(!supabaseConfigured);
  const [company, setCompany] = useState<CompanyBilling | null>(null);
  const [chargementCompany, setChargementCompany] = useState(true);
  const [offreAbonnement, setOffreAbonnement] = useState<OffreAbonnement | null>(null);
  const [actionEnCours, setActionEnCours] = useState<OffrePayante | "portal" | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

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

  useEffect(() => {
    if (!supabaseConfigured || !session) {
      setChargementCompany(false);
      return;
    }
    let annule = false;
    setChargementCompany(true);
    Promise.all([
      getOrCreateCompanyForBilling(supabase!, session.user),
      fetch("/api/billing/offre", { headers: { Authorization: `Bearer ${session.access_token}` } }).then(async (res) => {
        if (!res.ok) throw new Error("Lecture de l'offre impossible.");
        return (await res.json()) as OffreAbonnement;
      }),
    ])
      .then(([c, o]) => {
        if (annule) return;
        setCompany(c);
        setOffreAbonnement(o);
      })
      .catch((error) => {
        console.error("Échec du chargement de la facturation :", error);
        if (!annule) setErreur("Impossible de charger votre abonnement.");
      })
      .finally(() => {
        if (!annule) setChargementCompany(false);
      });
    return () => {
      annule = true;
    };
  }, [session]);

  const appelerRouteBilling = async (route: string, corps?: { offre: OffrePayante }): Promise<string> => {
    const res = await fetch(route, {
      method: "POST",
      headers: { Authorization: `Bearer ${session!.access_token}`, "Content-Type": "application/json" },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Une erreur est survenue.");
    return data.url as string;
  };

  const handleSubscribe = async (offre: OffrePayante) => {
    setErreur(null);
    setActionEnCours(offre);
    try {
      const url = await appelerRouteBilling("/api/billing/create-checkout-session", { offre });
      window.location.href = url;
    } catch (error) {
      setErreur(error instanceof Error ? error.message : "Impossible de démarrer l'abonnement.");
      setActionEnCours(null);
    }
  };

  const handleManage = async () => {
    setErreur(null);
    setActionEnCours("portal");
    try {
      const url = await appelerRouteBilling("/api/billing/create-portal-session");
      window.location.href = url;
    } catch (error) {
      setErreur(error instanceof Error ? error.message : "Impossible d'ouvrir le portail de gestion.");
      setActionEnCours(null);
    }
  };

  if (supabaseConfigured && !sessionChargee) {
    return <main className="cockpit-chargement">Chargement…</main>;
  }

  if (supabaseConfigured && !session) {
    return <LoginForm />;
  }

  const statut = company?.subscriptionStatus ?? null;
  const finPeriode = formatDate(company?.subscriptionCurrentPeriodEnd ?? null);
  const statutAbonnement = statut
    ? `Abonnement : ${LIBELLES_STATUT[statut] ?? statut}${finPeriode ? ` · période en cours jusqu'au ${finPeriode}` : ""}`
    : null;

  return (
    <main className="ecran-editorial ecran-editorial--large">
      <div className="billing-page__header billing-page__header--large">
        <Link href="/" className="btn-secondaire">
          ← Retour au cockpit
        </Link>
        {session && <span className="billing-page__email">{session.user.email}</span>}
      </div>

      <section className="abonnement">
        <div className="abonnement__intro">
          <h1>Votre offre Novanta</h1>
          <p className="abonnement__sous-titre">Choisissez le niveau adapté à votre pilotage financier.</p>
        </div>

        {success && (
          <div className="login-info">Paiement reçu. Votre abonnement est en cours d&apos;activation.</div>
        )}
        {canceled && (
          <div className="login-erreur">Le paiement a été annulé. Aucun abonnement n&apos;a été activé.</div>
        )}
        {statut === "paused" && (
          <div className="login-info">
            Votre période d&apos;essai est terminée. Choisissez une offre pour retrouver l&apos;accès.
          </div>
        )}
        {erreur && <div className="login-erreur">{erreur}</div>}

        {chargementCompany ? (
          <p className="abonnement__sous-titre">Chargement de votre abonnement…</p>
        ) : (
          <ChoixOffre
            situation={offreAbonnement ?? SITUATION_VIDE}
            prix={(offreAbonnement ?? SITUATION_VIDE).prix}
            enCours={actionEnCours}
            onSouscrire={handleSubscribe}
            onPortail={handleManage}
            statutAbonnement={statutAbonnement}
          />
        )}
      </section>
    </main>
  );
}
