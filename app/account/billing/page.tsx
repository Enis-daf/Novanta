"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { supabase, supabaseConfigured } from "@/lib/supabaseClient";
import { getOrCreateCompanyForBilling, CompanyBilling } from "@/lib/billing";
import { LIBELLES_OFFRES } from "@/lib/offres";
import { abonnementOffreEnCours, offreDuPrix, OFFRES_PAYANTES, OffrePayante } from "@/lib/offresStripe";
import LoginForm from "@/components/LoginForm";

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

// Abonnements souscrits avant les offres : un seul prix, sans offre associée.
const LIBELLE_ANCIEN_PLAN = "Novanta — 9,99 € / mois";

function libellePlan(prix: string): string {
  const offre = offreDuPrix(prix);
  return offre ? LIBELLES_OFFRES[offre] : LIBELLE_ANCIEN_PLAN;
}

function libelleStatut(statut: string | null): string {
  if (!statut) return "Aucun abonnement";
  return LIBELLES_STATUT[statut] ?? statut;
}

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
    getOrCreateCompanyForBilling(supabase!, session.user)
      .then((c) => {
        if (!annule) setCompany(c);
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

  const peutDemarrerNouvelAbonnement = !abonnementOffreEnCours(company?.subscriptionStatus, company?.subscriptionPlan);
  const finPeriode = formatDate(company?.subscriptionCurrentPeriodEnd ?? null);

  return (
    <main className="ecran-editorial">
      <div className="billing-page__header">
        <Link href="/" className="btn-secondaire">
          ← Retour au cockpit
        </Link>
        {session && <span className="billing-page__email">{session.user.email}</span>}
      </div>

      <div className="carte-editoriale billing-card">
        <p className="eyebrow">
          Novanta
          <span className="carte-editoriale__rubrique">Compte</span>
        </p>
        <h1>Abonnement</h1>

        {success && (
          <div className="login-info">Paiement reçu. Votre abonnement est en cours d&apos;activation.</div>
        )}
        {canceled && (
          <div className="login-erreur">Le paiement a été annulé. Aucun abonnement n&apos;a été activé.</div>
        )}
        {erreur && <div className="login-erreur">{erreur}</div>}

        {chargementCompany ? (
          <p>Chargement de votre abonnement…</p>
        ) : (
          <>
            <dl className="billing-status">
              <dt>Statut</dt>
              <dd>{libelleStatut(company?.subscriptionStatus ?? null)}</dd>

              {company?.subscriptionPlan && (
                <>
                  <dt>Offre</dt>
                  <dd>{libellePlan(company.subscriptionPlan)}</dd>
                </>
              )}

              {finPeriode && (
                <>
                  <dt>Fin de la période en cours</dt>
                  <dd>{finPeriode}</dd>
                </>
              )}
            </dl>

            {company?.subscriptionStatus === "paused" && (
              <p className="login-info">
                Votre période d&apos;essai est terminée. Souscrivez à une offre pour retrouver l&apos;accès.
              </p>
            )}

            <div className="billing-actions">
              {peutDemarrerNouvelAbonnement &&
                OFFRES_PAYANTES.map((offre) => (
                  <button
                    key={offre}
                    type="button"
                    className="btn-add"
                    onClick={() => handleSubscribe(offre)}
                    disabled={actionEnCours !== null}
                  >
                    {actionEnCours === offre ? "Redirection…" : `Souscrire à ${LIBELLES_OFFRES[offre]}`}
                  </button>
                ))}
              {company?.stripeCustomerId && (
                <button
                  type="button"
                  className="btn-secondaire"
                  onClick={handleManage}
                  disabled={actionEnCours !== null}
                >
                  {actionEnCours === "portal" ? "Redirection…" : "Gérer mon abonnement"}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
