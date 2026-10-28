import type { SupabaseClient } from "@supabase/supabase-js";

// Offres commerciales de Novanta et droits qui en découlent. SEUL endroit où l'on sait ce que
// contient une offre : les écrans et les routes ne demandent qu'une capacité (« puis-je afficher
// le BFR ? »), jamais « suis-je en Pilotage ? ».
//
// Chaîne : organisation (companies.plan, plan_override, plan_override_until — voir
// supabase/migrations/20261028_organization_plan.sql) -> offre effective -> capacités -> accès.
// Les rôles utilisateur n'entrent pas ici : l'offre appartient à l'organisation.

// Ordre croissant : sert à trouver l'offre minimale qui ouvre une capacité.
export const OFFRES = ["essential", "forecast", "steering"] as const;
export type Offre = (typeof OFFRES)[number];

export const LIBELLES_OFFRES: Record<Offre, string> = {
  essential: "Essentiel",
  forecast: "Prévision",
  steering: "Pilotage",
};

// Repli pour une valeur absente ou inattendue : l'offre la plus restreinte, jamais une offre
// supérieure par défaut (fail-closed). La base l'empêche déjà (NOT NULL + CHECK).
export const OFFRE_DE_REPLI: Offre = "essential";

export const CAPACITES = [
  "canViewReporting",
  "canViewForecast",
  "canViewVarianceAnalysis",
  "canViewWorkingCapital",
  "canViewDSO",
  "canViewDPO",
  "canViewActions",
] as const;
export type Capacite = (typeof CAPACITES)[number];
export type Capacites = Record<Capacite, boolean>;

// LA matrice. Déplacer une capacité d'une offre à l'autre se fait ici, sans migration : les
// organisations ne stockent que leur offre.
//  - canViewReporting        : module Passé, onglets de reporting (Général -> Cash flow).
//  - canViewForecast         : module Futur (projection de trésorerie, fiabilité de la projection).
//  - canViewVarianceAnalysis : onglet « Analyse d'écarts » du module Passé.
//  - canViewWorkingCapital   : onglet « BFR » du module Passé.
//  - canViewDSO / canViewDPO : délais clients / fournisseurs (pas encore d'écran dédié).
//  - canViewActions          : module Action.
const OFFRES_PAR_CAPACITE: Record<Capacite, readonly Offre[]> = {
  canViewReporting: ["essential", "forecast", "steering"],
  canViewForecast: ["forecast", "steering"],
  canViewVarianceAnalysis: ["forecast", "steering"],
  canViewWorkingCapital: ["steering"],
  canViewDSO: ["steering"],
  canViewDPO: ["steering"],
  canViewActions: ["steering"],
};

export function estOffre(valeur: unknown): valeur is Offre {
  return typeof valeur === "string" && (OFFRES as readonly string[]).includes(valeur);
}

export function capacitesDeLOffre(offre: Offre): Capacites {
  const capacites = {} as Capacites;
  for (const capacite of CAPACITES) capacites[capacite] = OFFRES_PAR_CAPACITE[capacite].includes(offre);
  return capacites;
}

// Offre la plus basse qui ouvre la capacité : c'est elle qu'on nomme à l'utilisateur.
export function offreMinimale(capacite: Capacite): Offre {
  return OFFRES.find((offre) => OFFRES_PAR_CAPACITE[capacite].includes(offre)) ?? OFFRES[OFFRES.length - 1];
}

export function messageOffreRequise(capacite: Capacite): string {
  return `Disponible avec l'offre ${LIBELLES_OFFRES[offreMinimale(capacite)]}`;
}

// Colonnes de companies telles que lues en base, non encore validées.
export interface OffreOrganisationBrute {
  plan?: unknown;
  plan_override?: unknown;
  plan_override_until?: unknown;
}

export interface DroitsOrganisation {
  // Offre contractuelle (companies.plan), après repli éventuel.
  offreContractuelle: Offre;
  // Offre qui détermine les droits : l'override s'il est valide, sinon l'offre contractuelle.
  offreEffective: Offre;
  overrideActif: boolean;
  capacites: Capacites;
}

// Un override n'est retenu que s'il porte une offre connue ET que son échéance, si elle existe, est
// une date lisible encore à venir. Toute autre forme est ignorée : jamais d'accès supplémentaire
// sur une valeur douteuse.
function overrideValide(brute: OffreOrganisationBrute, maintenant: Date): Offre | null {
  if (!estOffre(brute.plan_override)) return null;
  const jusquAu = brute.plan_override_until;
  if (jusquAu === null || jusquAu === undefined) return brute.plan_override;
  if (typeof jusquAu !== "string") return null;
  const fin = new Date(jusquAu).getTime();
  if (Number.isNaN(fin) || fin <= maintenant.getTime()) return null;
  return brute.plan_override;
}

export function droitsOrganisation(brute: OffreOrganisationBrute, maintenant: Date = new Date()): DroitsOrganisation {
  const offreContractuelle = estOffre(brute.plan) ? brute.plan : OFFRE_DE_REPLI;
  const override = overrideValide(brute, maintenant);
  const offreEffective = override ?? offreContractuelle;
  return {
    offreContractuelle,
    offreEffective,
    overrideActif: override !== null,
    capacites: capacitesDeLOffre(offreEffective),
  };
}

// Lit l'offre de l'organisation avec le client de l'appelant (navigateur ou route serveur scopée à
// l'utilisateur) : la RLS de companies ne laisse lire que sa propre société. Une société illisible
// est une erreur, jamais un droit par défaut — à l'appelant d'appliquer son comportement fail-closed.
export async function chargerDroitsOrganisation(
  supabase: SupabaseClient,
  organizationId: string,
  maintenant: Date = new Date()
): Promise<DroitsOrganisation> {
  const { data, error } = await supabase
    .from("companies")
    .select("plan, plan_override, plan_override_until")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Offre de l'organisation illisible.");
  return droitsOrganisation(data, maintenant);
}

export const CODE_OFFRE_REQUISE = "offre_requise";

// Corps de la réponse 403 des routes serveur quand l'offre ne couvre pas la capacité.
export function refusOffre(capacite: Capacite): { error: string; code: string; offreRequise: Offre } {
  return { error: `${messageOffreRequise(capacite)}.`, code: CODE_OFFRE_REQUISE, offreRequise: offreMinimale(capacite) };
}
