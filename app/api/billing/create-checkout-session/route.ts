import { NextRequest, NextResponse } from "next/server";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling, setStripeCustomerId } from "@/lib/billing";
import { abonnementOffreEnCours, estOffrePayante, prixDeLOffre } from "@/lib/offresStripe";

// La company de l'utilisateur connecté est toujours dérivée de son token (jamais
// d'un company_id envoyé par le client) : impossible de créer une session pour
// une autre société.
export async function POST(req: NextRequest) {
  if (!stripeConfigured || !stripe) {
    return NextResponse.json({ error: "Stripe n'est pas configuré (STRIPE_SECRET_KEY manquante)." }, { status: 501 });
  }

  // Le client ne choisit que le nom d'une offre payante, jamais un Price : le Price est lu côté
  // serveur, et l'offre n'est attribuée que par le webhook, une fois l'abonnement vérifié chez Stripe.
  const corps = await req.json().catch(() => null);
  const offre: unknown = corps?.offre;
  if (!estOffrePayante(offre)) {
    return NextResponse.json({ error: "Offre inconnue." }, { status: 400 });
  }
  const priceId = prixDeLOffre(offre, process.env.STRIPE_SECRET_KEY);
  // Dérivée de la requête elle-même (Host réel), jamais figée : contrairement à
  // NEXT_PUBLIC_APP_URL (une seule valeur possible dans les réglages Vercel), ça
  // correspond automatiquement à l'URL réellement utilisée — localhost:PORT en
  // local, chaque URL de preview par branche sur Vercel, ou le domaine de prod —
  // sans quoi le retour après Checkout renvoie vers une autre URL/déploiement
  // (souvent main, avec une page Abonnement qui parait identique) et la session
  // de l'utilisateur ne suit pas. NEXT_PUBLIC_APP_URL reste un filet de sécurité.
  const appUrl = req.nextUrl.origin || process.env.NEXT_PUBLIC_APP_URL;
  if (!priceId) {
    console.error(`[billing/create-checkout-session] Price live absent pour l'offre ${offre}`);
    return NextResponse.json({ error: "Cette offre n'est pas encore disponible." }, { status: 500 });
  }
  if (!appUrl) {
    return NextResponse.json({ error: "Impossible de déterminer l'URL de l'application." }, { status: 500 });
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

    if (abonnementOffreEnCours(company.subscriptionStatus, company.subscriptionPlan)) {
      return NextResponse.json({ error: "Un abonnement est déjà en cours : modifiez-le via « Gérer mon abonnement »." }, { status: 409 });
    }

    // Si un stripe_customer_id est déjà enregistré, on vérifie qu'il correspond
    // toujours à un client Stripe existant (mode test purgé, client supprimé
    // manuellement, migration entre comptes Stripe...) avant de le réutiliser —
    // sinon Checkout échoue avec "No such customer" pour un motif invisible côté
    // utilisateur. Un identifiant invalide est traité exactement comme absent :
    // un nouveau client est créé et remplace l'ancien en base.
    let customerId = company.stripeCustomerId;
    if (customerId) {
      try {
        const existing = await stripe.customers.retrieve(customerId);
        if (existing.deleted) customerId = null;
      } catch {
        customerId = null;
      }
    }
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        name: company.name,
        metadata: { company_id: company.id },
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
      metadata: { company_id: company.id },
      subscription_data: { metadata: { company_id: company.id } },
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error("[billing/create-checkout-session] échec", error);
    return NextResponse.json({ error: "Impossible de créer la session Checkout." }, { status: 500 });
  }
}
