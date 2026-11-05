import { Offre, OFFRES } from "./offres";

// Contenu commercial des cartes de la page Abonnement : ce que chaque offre ajoute à la précédente
// (« Tout Essentiel, plus : »). Liste éditoriale, distincte de la matrice des droits de lib/offres.ts.
const CONTENU_OFFRES: Record<Offre, readonly string[]> = {
  essential: [
    "Reporting financier à partir des flux bancaires",
    "Analyse des flux de trésorerie",
    "Indicateurs clés",
    "Tableaux de bord essentiels",
  ],
  forecast: [
    "Projection de trésorerie",
    "Fiabilité de la projection",
    "Analyse des écarts réel / prévisionnel",
    "Identification des variations à surveiller",
    "Analyse du BFR",
  ],
  steering: [
    "Reporting financier à partir des données comptables",
    "Suivi des délais de paiement clients et fournisseurs",
    "Identification des leviers d'amélioration",
    "Suivi de plan d'action",
  ],
};

export const PROMESSES_OFFRES: Record<Offre, string> = {
  essential: "Suivez votre activité financière au quotidien.",
  forecast: "Anticipez votre trésorerie et comprenez vos écarts.",
  steering: "Pilotez les leviers qui ont un impact sur votre cash.",
};

export const OFFRE_RECOMMANDEE: Offre = "forecast";

function rang(offre: Offre): number {
  return OFFRES.indexOf(offre);
}

export function offrePrecedente(offre: Offre): Offre | null {
  return rang(offre) > 0 ? OFFRES[rang(offre) - 1] : null;
}

// Ce que l'offre ajoute à la précédente (« Tout Essentiel, plus : »).
export function nouveautesDeLOffre(offre: Offre): string[] {
  return [...CONTENU_OFFRES[offre]];
}

// Situation lue par GET /api/billing/offre.
export interface SituationAbonnement {
  // Offre permanente (companies.plan) ; null tant que l'accès au produit n'est pas ouvert.
  offreActuelle: Offre | null;
  // Essai Pilotage en cours (essai Stripe ou override Novanta). fin = null : sans échéance.
  essai: { fin: string | null } | null;
  // Un Checkout est possible (aucune offre Stripe déjà en cours).
  souscriptionPossible: boolean;
  // Un abonnement Stripe existe et se gère dans le portail client.
  portailDisponible: boolean;
}

export type ActionCarte = "actuelle" | "checkout" | "portail" | "aucune";

export interface EtatCarte {
  action: ActionCarte;
  // L'offre est ouverte en ce moment par l'essai Pilotage.
  incluseDansEssai: boolean;
}

// Monter de gamme : Checkout, ou portail si une offre Stripe est déjà en cours (changement d'offre).
// Descendre : seulement dans le portail, où se gèrent changement d'offre et résiliation ; sans
// abonnement Stripe (offre attribuée par Novanta), aucune action.
export function etatCarte(offre: Offre, situation: SituationAbonnement): EtatCarte {
  const actuelle = situation.offreActuelle;
  const incluseDansEssai = situation.essai !== null && offre !== "essential" && (actuelle === null || rang(offre) > rang(actuelle));

  if (offre === actuelle) return { action: "actuelle", incluseDansEssai: false };

  const montee = offre !== "essential" && (actuelle === null || rang(offre) > rang(actuelle));
  let action: ActionCarte = "aucune";
  if (montee && situation.souscriptionPossible) action = "checkout";
  else if (situation.portailDisponible && actuelle !== null) action = "portail";
  return { action, incluseDansEssai };
}

// Nombre de jours entamés avant la fin de l'essai ; null si l'essai n'a pas d'échéance lisible.
export function joursRestants(fin: string | null, maintenant: Date = new Date()): number | null {
  if (!fin) return null;
  const ms = new Date(fin).getTime() - maintenant.getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(1, Math.ceil(ms / 86_400_000));
}

export interface PrixAffiche {
  montant: number; // en centimes
  devise: string;
  intervalle: string; // day | week | month | year
  taxes: "HT" | "TTC" | null;
}

const LIBELLES_INTERVALLE: Record<string, string> = { day: "jour", week: "semaine", month: "mois", year: "an" };

export function formaterPrix(prix: PrixAffiche): { montant: string; periode: string } {
  const montant = new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: prix.devise.toUpperCase(),
    minimumFractionDigits: prix.montant % 100 === 0 ? 0 : 2,
  }).format(prix.montant / 100);
  const periode = `/ ${LIBELLES_INTERVALLE[prix.intervalle] ?? prix.intervalle}${prix.taxes ? ` ${prix.taxes}` : ""}`;
  return { montant, periode };
}
