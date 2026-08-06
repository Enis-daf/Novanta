import { NextRequest, NextResponse } from "next/server";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { requireUser } from "@/lib/supabaseServer";
import { getOrCreateCompanyForBilling } from "@/lib/billing";

export async function POST(req: NextRequest) {
  if (!stripeConfigured || !stripe) {
    return NextResponse.json({ error: "Stripe n'est pas configuré (STRIPE_SECRET_KEY manquante)." }, { status: 501 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    return NextResponse.json({ error: "NEXT_PUBLIC_APP_URL n'est pas configuré." }, { status: 500 });
  }

  const auth = await requireUser(req);
  if (!auth) {
    return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  }
  const { supabase, user } = auth;

  try {
    const company = await getOrCreateCompanyForBilling(supabase, user.id);

    if (!company.stripeCustomerId) {
      return NextResponse.json({ error: "Aucun client Stripe associé à ce compte." }, { status: 400 });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: company.stripeCustomerId,
      return_url: `${appUrl}/account/billing`,
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error("[billing/create-portal-session] échec", error);
    return NextResponse.json({ error: "Impossible de créer la session du Customer Portal." }, { status: 500 });
  }
}
