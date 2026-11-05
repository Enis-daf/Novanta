import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { stripe } from "@/lib/stripe";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { droitsOrganisation } from "@/lib/offres";
import { abonnementOffreEnCours, OFFRES_PAYANTES, OffrePayante, prixDeLOffre } from "@/lib/offresStripe";
import type { PrixAffiche, SituationAbonnement } from "@/lib/offresAbonnement";

// Situation d'abonnement de la société, pour la page Abonnement : les Price IDs ne sont lisibles que
// côté serveur, et les prix affichés sont ceux de Stripe. Lecture seule, n'attribue rien.
export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth) {
    return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  }

  try {
    const company = await getOrCreateCompanyForBilling(auth.supabase, auth.user);
    const { data: brute, error } = await auth.supabase
      .from("companies")
      .select("plan, plan_override, plan_override_until, subscription_status, subscription_current_period_end")
      .eq("id", company.id)
      .maybeSingle();
    if (error) throw error;
    if (!brute) throw new Error("Offre de l'organisation illisible.");

    const droits = droitsOrganisation(brute);
    // Pilotage temporaire au-dessus de l'offre permanente : essai Stripe ou override Novanta.
    const essaiPilotage =
      droits.offreEffective === "steering" && droits.offreContractuelle !== "steering" && (droits.essaiActif || droits.overrideActif);
    const fin = droits.essaiActif ? brute.subscription_current_period_end : brute.plan_override_until;

    const situation: SituationAbonnement = {
      offreActuelle: company.accessEnabled ? droits.offreContractuelle : null,
      essai: essaiPilotage ? { fin: typeof fin === "string" ? fin : null } : null,
      souscriptionPossible: !abonnementOffreEnCours(company.subscriptionStatus, company.subscriptionPlan),
      portailDisponible:
        Boolean(company.stripeCustomerId) &&
        Boolean(company.subscriptionStatus) &&
        !["canceled", "incomplete_expired"].includes(company.subscriptionStatus ?? ""),
    };

    const prix = Object.fromEntries(
      await Promise.all(OFFRES_PAYANTES.map(async (offre) => [offre, await lirePrix(offre)] as const))
    ) as Record<OffrePayante, PrixAffiche | null>;

    return NextResponse.json({ ...situation, prix });
  } catch (error) {
    console.error("[billing/offre] échec", error);
    return NextResponse.json({ error: "Impossible de lire l'offre." }, { status: 500 });
  }
}

// Prix réel du Price Stripe de l'offre ; null s'il est illisible (la carte s'affiche sans prix).
async function lirePrix(offre: OffrePayante): Promise<PrixAffiche | null> {
  const id = prixDeLOffre(offre, process.env.STRIPE_SECRET_KEY);
  if (!stripe || !id) return null;
  try {
    const prix = await stripe.prices.retrieve(id);
    if (prix.unit_amount === null) return null;
    return {
      montant: prix.unit_amount,
      devise: prix.currency,
      intervalle: prix.recurring?.interval ?? "month",
      taxes: prix.tax_behavior === "exclusive" ? "HT" : prix.tax_behavior === "inclusive" ? "TTC" : null,
    };
  } catch (error) {
    console.error(`[billing/offre] prix ${offre} illisible`, error);
    return null;
  }
}
