import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import {
  accessEnabledForStatus,
  findCompanyByStripeCustomerId,
  findCompanyByStripeSubscriptionId,
  updateCompanyBilling,
} from "@/lib/billing";
import type { SupabaseClient } from "@supabase/supabase-js";

// En local, écouter avec :
//   stripe listen --forward-to localhost:3000/api/stripe/webhook
// et copier le "whsec_..." affiché dans STRIPE_WEBHOOK_SECRET.
//
// Cette route n'a pas d'utilisateur connecté : elle écrit dans companies via la
// clé service_role (contourne la RLS), après avoir vérifié la signature Stripe.
// Un événement non signé (ou mal signé) n'est jamais traité.
export async function POST(req: NextRequest) {
  if (!stripeConfigured || !stripe) {
    return NextResponse.json({ error: "Stripe n'est pas configuré (STRIPE_SECRET_KEY manquante)." }, { status: 501 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[stripe/webhook] STRIPE_WEBHOOK_SECRET manquant : impossible de vérifier les événements.");
    return NextResponse.json({ error: "STRIPE_WEBHOOK_SECRET manquant dans l'environnement." }, { status: 500 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Signature Stripe absente." }, { status: 400 });
  }

  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    console.error("[stripe/webhook] signature invalide", error);
    return NextResponse.json({ error: "Signature invalide." }, { status: 400 });
  }

  if (!supabaseAdminConfigured || !supabaseAdmin) {
    console.error("[stripe/webhook] SUPABASE_SERVICE_ROLE_KEY manquant : impossible de persister l'événement.");
    return NextResponse.json({ error: "Supabase (service_role) n'est pas configuré." }, { status: 500 });
  }
  const admin = supabaseAdmin;

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(admin, event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(admin, event.data.object as Stripe.Subscription);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(admin, event.data.object as Stripe.Subscription);
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(admin, event.data.object as Stripe.Invoice);
        break;
      default:
        console.log(`[stripe/webhook] événement non géré : ${event.type}`);
    }
  } catch (error) {
    console.error(`[stripe/webhook] échec de traitement de ${event.type}`, error);
    return NextResponse.json({ error: "Échec du traitement de l'événement." }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

async function resolveCompanyId(
  admin: SupabaseClient,
  opts: { metadataCompanyId?: string | null; subscriptionId?: string | null; customerId?: string | null }
): Promise<string | null> {
  if (opts.metadataCompanyId) return opts.metadataCompanyId;
  if (opts.subscriptionId) {
    const company = await findCompanyByStripeSubscriptionId(admin, opts.subscriptionId);
    if (company) return company.id;
  }
  if (opts.customerId) {
    const company = await findCompanyByStripeCustomerId(admin, opts.customerId);
    if (company) return company.id;
  }
  return null;
}

function periodEndIso(unixSeconds: number | null | undefined): string | null {
  return typeof unixSeconds === "number" ? new Date(unixSeconds * 1000).toISOString() : null;
}

async function handleCheckoutSessionCompleted(admin: SupabaseClient, session: Stripe.Checkout.Session) {
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;
  const metadataCompanyId = session.metadata?.company_id ?? null;

  const companyId = await resolveCompanyId(admin, { metadataCompanyId, subscriptionId, customerId });
  if (!companyId) {
    console.error("[stripe/webhook] checkout.session.completed : company introuvable", session.id);
    return;
  }

  let status: string | null = null;
  let currentPeriodEnd: string | null = null;
  let plan: string | null = null;
  if (subscriptionId && stripe) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    status = subscription.status;
    currentPeriodEnd = periodEndIso(subscription.items.data[0]?.current_period_end);
    plan = subscription.items.data[0]?.price?.id ?? null;
  }

  await updateCompanyBilling(admin, companyId, {
    stripeCustomerId: customerId ?? undefined,
    stripeSubscriptionId: subscriptionId ?? undefined,
    subscriptionStatus: status ?? undefined,
    subscriptionPlan: plan ?? undefined,
    subscriptionCurrentPeriodEnd: currentPeriodEnd,
    billingEmail: session.customer_details?.email ?? session.customer_email ?? undefined,
    accessEnabled: status ? accessEnabledForStatus(status, true) : undefined,
  });
}

async function handleSubscriptionUpdated(admin: SupabaseClient, subscription: Stripe.Subscription) {
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id ?? null;
  const metadataCompanyId = subscription.metadata?.company_id ?? null;

  const companyId = await resolveCompanyId(admin, {
    metadataCompanyId,
    subscriptionId: subscription.id,
    customerId,
  });
  if (!companyId) {
    console.error("[stripe/webhook] customer.subscription.updated : company introuvable", subscription.id);
    return;
  }

  const { data: current } = await admin
    .from("companies")
    .select("access_enabled")
    .eq("id", companyId)
    .maybeSingle();
  const accessEnabledActuel = current?.access_enabled === null || current?.access_enabled === undefined
    ? true
    : Boolean(current.access_enabled);

  await updateCompanyBilling(admin, companyId, {
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
    subscriptionPlan: subscription.items.data[0]?.price?.id ?? undefined,
    subscriptionCurrentPeriodEnd: periodEndIso(subscription.items.data[0]?.current_period_end),
    accessEnabled: accessEnabledForStatus(subscription.status, accessEnabledActuel),
  });
}

async function handleSubscriptionDeleted(admin: SupabaseClient, subscription: Stripe.Subscription) {
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id ?? null;
  const metadataCompanyId = subscription.metadata?.company_id ?? null;

  const companyId = await resolveCompanyId(admin, {
    metadataCompanyId,
    subscriptionId: subscription.id,
    customerId,
  });
  if (!companyId) {
    console.error("[stripe/webhook] customer.subscription.deleted : company introuvable", subscription.id);
    return;
  }

  // Ne supprime aucune donnée : seul le statut est mis à jour.
  await updateCompanyBilling(admin, companyId, {
    subscriptionStatus: "canceled",
    accessEnabled: false,
  });
}

async function handleInvoicePaymentFailed(admin: SupabaseClient, invoice: Stripe.Invoice) {
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null;
  const subscriptionDetails =
    invoice.parent?.type === "subscription_details" ? invoice.parent.subscription_details : null;
  const subscriptionRef = subscriptionDetails?.subscription;
  const subscriptionId = typeof subscriptionRef === "string" ? subscriptionRef : subscriptionRef?.id ?? null;

  const companyId = await resolveCompanyId(admin, { subscriptionId, customerId });
  if (!companyId) {
    console.error("[stripe/webhook] invoice.payment_failed : company introuvable", invoice.id);
    return;
  }

  // Pas de blocage brutal ni de suppression dans cette première version : on
  // trace seulement le statut past_due, access_enabled n'est pas touché ici.
  await updateCompanyBilling(admin, companyId, {
    subscriptionStatus: "past_due",
  });
}
