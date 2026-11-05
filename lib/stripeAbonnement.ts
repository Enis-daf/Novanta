import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import {
  accessEnabledForStatus,
  BillingUpdate,
  findCompanyByStripeCustomerId,
  findCompanyByStripeSubscriptionId,
  updateCompanyBilling,
} from "./billing";
import { droitsOrganisation, OFFRE_ESSAI, OffreOrganisationBrute } from "./offres";
import { offreDuPrix } from "./offresStripe";

// Synchronisation companies <- abonnement Stripe, appelée par le webhook après vérification de la
// signature. Chaque événement ne sert qu'à savoir QUEL abonnement relire : l'état appliqué est
// toujours celui que Stripe renvoie à cet instant. Un événement rejoué ou reçu dans le désordre
// produit donc le même résultat.

export interface SocieteAbonnement extends OffreOrganisationBrute {
  id: string;
  stripe_subscription_id: string | null;
  access_enabled: boolean | null;
}

export interface AbonnementLu {
  id: string;
  customerId: string | null;
  status: string;
  prix: string | null;
  finPeriode: string | null;
}

export type Decision =
  | { action: "ignorer"; raison: string }
  | { action: "appliquer"; maj: BillingUpdate; aResilier: string | null };

const STATUTS_TERMINES = new Set(["canceled", "incomplete_expired"]);
const STATUTS_AVEC_OFFRE = new Set(["active", "trialing", "past_due", "unpaid"]);

export function decisionAbonnement(societe: SocieteAbonnement, abonnement: AbonnementLu, maintenant: Date): Decision {
  const offre = offreDuPrix(abonnement.prix);
  const termine = STATUTS_TERMINES.has(abonnement.status);
  const courant = societe.stripe_subscription_id;
  const remplace = courant !== abonnement.id;

  if (remplace) {
    // Ex. l'essai résilié juste après la souscription : sa fin ne doit pas couper l'abonnement payé.
    if (termine) return { action: "ignorer", raison: "abonnement terminé autre que celui de la société" };
    if (abonnement.status === "incomplete") return { action: "ignorer", raison: "paiement initial non confirmé" };
    if (offre === null && courant) return { action: "ignorer", raison: "Price inconnu, abonnement courant conservé" };
  }

  const maj: BillingUpdate = {
    stripeCustomerId: abonnement.customerId ?? undefined,
    stripeSubscriptionId: abonnement.id,
    subscriptionStatus: abonnement.status,
    subscriptionPlan: abonnement.prix ?? undefined,
    subscriptionCurrentPeriodEnd: abonnement.finPeriode,
  };

  // Souscrire pendant un essai Stripe : le statut « trialing » va être remplacé, or c'est lui qui
  // porte l'essai. Les droits Pilotage sont conservés jusqu'à la fin prévue, via l'override.
  if (remplace) {
    const droits = droitsOrganisation(societe, maintenant);
    if (droits.essaiActif) {
      maj.planOverride = OFFRE_ESSAI;
      maj.planOverrideUntil = societe.subscription_current_period_end as string;
    }
  }

  if (offre !== null && termine) {
    // Essentiel est gratuit : la fin d'un abonnement payant retire l'offre, pas l'accès au produit.
    maj.plan = "essential";
    maj.accessEnabled = true;
  } else {
    if (offre !== null && STATUTS_AVEC_OFFRE.has(abonnement.status)) maj.plan = offre;
    maj.accessEnabled = accessEnabledForStatus(abonnement.status, societe.access_enabled ?? true);
  }

  return { action: "appliquer", maj, aResilier: remplace ? courant : null };
}

function identifiant(ref: string | { id: string } | null | undefined): string | null {
  return typeof ref === "string" ? ref : ref?.id ?? null;
}

function lireAbonnement(abonnement: Stripe.Subscription): AbonnementLu {
  const ligne = abonnement.items.data[0];
  return {
    id: abonnement.id,
    customerId: identifiant(abonnement.customer),
    status: abonnement.status,
    prix: ligne?.price?.id ?? null,
    finPeriode: typeof ligne?.current_period_end === "number" ? new Date(ligne.current_period_end * 1000).toISOString() : null,
  };
}

async function retrouverSociete(admin: SupabaseClient, abonnement: Stripe.Subscription): Promise<SocieteAbonnement | null> {
  let id: string | null = abonnement.metadata?.company_id || null;
  if (!id) id = (await findCompanyByStripeSubscriptionId(admin, abonnement.id))?.id ?? null;
  if (!id) {
    const customerId = identifiant(abonnement.customer);
    if (customerId) id = (await findCompanyByStripeCustomerId(admin, customerId))?.id ?? null;
  }
  if (!id) return null;
  const { data, error } = await admin
    .from("companies")
    .select("id, stripe_subscription_id, access_enabled, plan, plan_override, plan_override_until, subscription_status, subscription_current_period_end")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as SocieteAbonnement | null;
}

// Évite une double facturation. Résilié AVANT l'écriture en base : si elle échoue, Stripe renvoie
// l'événement et l'étape est rejouée sans effet.
async function resilierAncienAbonnement(stripe: Stripe, id: string): Promise<void> {
  try {
    const ancien = await stripe.subscriptions.retrieve(id);
    if (!STATUTS_TERMINES.has(ancien.status)) await stripe.subscriptions.cancel(id);
  } catch (error) {
    // Abonnement inconnu de ce compte Stripe : il n'y a rien à résilier.
    if ((error as { code?: string }).code !== "resource_missing") throw error;
  }
}

export async function synchroniserAbonnement(
  stripe: Stripe,
  admin: SupabaseClient,
  subscriptionId: string,
  billingEmail?: string | null,
  maintenant: Date = new Date()
): Promise<void> {
  const abonnement = await stripe.subscriptions.retrieve(subscriptionId);
  const societe = await retrouverSociete(admin, abonnement);
  if (!societe) {
    console.error("[stripe/webhook] société introuvable pour l'abonnement", subscriptionId);
    return;
  }

  const decision = decisionAbonnement(societe, lireAbonnement(abonnement), maintenant);
  if (decision.action === "ignorer") {
    console.log(`[stripe/webhook] abonnement ${subscriptionId} ignoré : ${decision.raison}`);
    return;
  }

  if (decision.aResilier) await resilierAncienAbonnement(stripe, decision.aResilier);
  await updateCompanyBilling(admin, societe.id, { ...decision.maj, billingEmail: billingEmail ?? undefined });
}
