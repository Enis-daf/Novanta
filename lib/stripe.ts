import Stripe from "stripe";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (stripeSecretKey?.startsWith("sk_live_")) {
  throw new Error(
    "STRIPE_SECRET_KEY pointe vers une clé live (sk_live_...). " +
      "Cette intégration est en cours de développement et ne doit tourner qu'en mode test (sk_test_...)."
  );
}

export const stripe: Stripe | null = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

export const stripeConfigured = Boolean(stripe);
