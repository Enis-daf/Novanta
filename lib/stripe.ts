import Stripe from "stripe";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

// La clé live n'est autorisée qu'en Production Vercel (VERCEL_ENV="production",
// défini automatiquement par Vercel — absent en local, "preview" sur les
// déploiements de branche). En local et en Preview, seule une clé test
// (sk_test_...) est acceptée, pour ne jamais risquer un prélèvement réel
// pendant le développement.
if (stripeSecretKey?.startsWith("sk_live_") && process.env.VERCEL_ENV !== "production") {
  throw new Error(
    "STRIPE_SECRET_KEY pointe vers une clé live (sk_live_...) en dehors de Production. " +
      "Utilisez une clé de test (sk_test_...) en local et en Preview."
  );
}

export const stripe: Stripe | null = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

export const stripeConfigured = Boolean(stripe);
