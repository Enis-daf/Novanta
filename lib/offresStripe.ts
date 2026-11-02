import type { Offre } from "./offres";

// Correspondance Price Stripe <-> offre Novanta. SEUL endroit où figurent les Price IDs. Essentiel
// est gratuit et l'offre Test est gérée côté Novanta : ni l'une ni l'autre n'a de Price.
//
// Les valeurs écrites ici sont celles du compte Stripe de TEST. Un Price n'existe que dans le compte
// et le mode où il a été créé : la Production (clé live, autre compte) doit fournir les siens via
// NEXT_PUBLIC_STRIPE_PRICE_FORECAST et NEXT_PUBLIC_STRIPE_PRICE_STEERING. Un Price ID n'est pas un
// secret ; le préfixe NEXT_PUBLIC_ permet à la page Abonnement de lire la même correspondance.
export const OFFRES_PAYANTES = ["forecast", "steering"] as const;
export type OffrePayante = (typeof OFFRES_PAYANTES)[number];

const PRIX_DE_TEST: Record<OffrePayante, string> = {
  forecast: "price_1UXO6KV05PdV9lFGeC5ZHjFt",
  steering: "price_1UXO6qV05PdV9lFGjcqvzirH",
};

const PRIX_CONFIGURES: Record<OffrePayante, string | undefined> = {
  forecast: process.env.NEXT_PUBLIC_STRIPE_PRICE_FORECAST || undefined,
  steering: process.env.NEXT_PUBLIC_STRIPE_PRICE_STEERING || undefined,
};

export function estOffrePayante(valeur: unknown): valeur is OffrePayante {
  return typeof valeur === "string" && (OFFRES_PAYANTES as readonly string[]).includes(valeur);
}

// Price à utiliser pour un Checkout. Avec une clé live, null tant que le Price live n'est pas
// configuré : les Price de test y répondraient « No such price ».
export function prixDeLOffre(offre: OffrePayante, cleSecrete: string | undefined): string | null {
  const configure = PRIX_CONFIGURES[offre];
  if (configure) return configure;
  return cleSecrete?.startsWith("sk_live_") ? null : PRIX_DE_TEST[offre];
}

// Offre d'un Price reçu de Stripe ; null pour un Price inconnu (ancien abonnement à prix unique).
export function offreDuPrix(prix: string | null | undefined): Offre | null {
  if (!prix) return null;
  for (const offre of OFFRES_PAYANTES) {
    if (prix === PRIX_CONFIGURES[offre] || prix === PRIX_DE_TEST[offre]) return offre;
  }
  return null;
}

const STATUTS_EN_COURS = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);

// Un abonnement Prévision ou Pilotage en cours se modifie dans le portail Stripe : un second Checkout
// le doublerait. Un ancien abonnement à prix unique (dont l'essai Stripe) peut, lui, être remplacé.
export function abonnementOffreEnCours(statut: string | null | undefined, prix: string | null | undefined): boolean {
  return offreDuPrix(prix) !== null && STATUTS_EN_COURS.has(statut ?? "");
}
