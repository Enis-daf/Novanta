"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { supabase, supabaseConfigured } from "@/lib/supabaseClient";
import { getOrCreateCompanyForBilling, CompanyBilling } from "@/lib/billing";
import LoginForm from "@/components/LoginForm";

const LIBELLES_STATUT: Record<string, string> = {
  active: "Actif",
  trialing: "Période d'essai",
  past_due: "Paiement en retard",
  canceled: "Résilié",
  unpaid: "Impayé",
  incomplete: "Incomplet",
  incomplete_expired: "Expiré",
};

const STATUTS_ABONNEMENT_ACTIF = new Set(["active", "trialing"]);

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
  const [actionEnCours, setActionEnCours] = useState<"checkout" | "portal" | null>(null);
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
    getOrCreateCompanyForBilling(supabase!, session.user.id)
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

  const appelerRouteBilling = async (route: string): Promise<string> => {
    const res = await fetch(route, {
      method: "POST",
      headers: { Authorization: `Bearer ${session!.access_token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Une erreur est survenue.");
    return data.url as string;
  };

  const handleSubscribe = async () => {
    setErreur(null);
    setActionEnCours("checkout");
    try {
      const url = await appelerRouteBilling("/api/billing/create-checkout-session");
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

  const abonnementActif = company ? STATUTS_ABONNEMENT_ACTIF.has(company.subscriptionStatus ?? "") : false;
  const finPeriode = formatDate(company?.subscriptionCurrentPeriodEnd ?? null);

  return (
    <main className="billing-page">
      <div className="billing-page__header">
        <Link href="/" className="btn-secondaire">
          ← Retour au cockpit
        </Link>
        {session && <span className="billing-page__email">{session.user.email}</span>}
      </div>

      <div className="billing-card">
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
                  <dt>Plan</dt>
                  <dd>{company.subscriptionPlan}</dd>
                </>
              )}

              {finPeriode && (
                <>
                  <dt>Fin de la période en cours</dt>
                  <dd>{finPeriode}</dd>
                </>
              )}
            </dl>

            <div className="billing-actions">
              {!abonnementActif && (
                <button type="button" className="btn-add" onClick={handleSubscribe} disabled={actionEnCours !== null}>
                  {actionEnCours === "checkout" ? "Redirection…" : "S'abonner"}
                </button>
              )}
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
