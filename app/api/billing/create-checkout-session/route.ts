import { NextRequest, NextResponse } from "next/server";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling, setStripeCustomerId } from "@/lib/billing";

// La company de l'utilisateur connecté est toujours dérivée de son token (jamais
// d'un company_id envoyé par le client) : impossible de créer une session pour
// une autre société.
export async function POST(req: NextRequest) {
  if (!stripeConfigured || !stripe) {
    return NextResponse.json({ error: "Stripe n'est pas configuré (STRIPE_SECRET_KEY manquante)." }, { status: 501 });
  }

  const priceId = process.env.STRIPE_PRICE_ID;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!priceId) {
    return NextResponse.json({ error: "STRIPE_PRICE_ID n'est pas configuré." }, { status: 500 });
  }
  if (!appUrl) {
    return NextResponse.json({ error: "NEXT_PUBLIC_APP_URL n'est pas configuré." }, { status: 500 });
  }
  if (!supabaseAdminConfigured || !supabaseAdmin) {
    return NextResponse.json({ error: "Supabase (service_role) n'est pas configuré." }, { status: 500 });
  }

  const auth = await requireUser(req);
  if (!auth) {
    return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  }
  const { supabase, user } = auth;

  try {
    const company = await getOrCreateCompanyForBilling(supabase, user);

    let customerId = company.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        name: company.name,
        metadata: { company_id: company.id, user_id: user.id },
      });
      customerId = customer.id;
      // stripe_customer_id est une colonne protégée (migration
      // 20260806_restrict_billing_columns_and_access_default) : seule la clé
      // service_role peut l'écrire, jamais la connexion de l'utilisateur.
      await setStripeCustomerId(supabaseAdmin, company.id, customerId);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/account/billing?success=true`,
      cancel_url: `${appUrl}/account/billing?canceled=true`,
      allow_promotion_codes: true,
      metadata: { company_id: company.id, user_id: user.id },
      subscription_data: {
        metadata: { company_id: company.id, user_id: user.id },
      },
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error("[billing/create-checkout-session] échec", error);
    return NextResponse.json({ error: "Impossible de créer la session Checkout." }, { status: 500 });
  }
}
