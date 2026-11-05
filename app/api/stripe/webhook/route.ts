import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { synchroniserAbonnement } from "@/lib/stripeAbonnement";

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

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (subscriptionId) {
          await synchroniserAbonnement(
            stripe,
            supabaseAdmin,
            subscriptionId,
            session.customer_details?.email ?? session.customer_email
          );
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await synchroniserAbonnement(stripe, supabaseAdmin, (event.data.object as Stripe.Subscription).id);
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
