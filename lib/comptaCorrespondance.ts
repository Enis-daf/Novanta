/**
 * Correspondance comptable : racine de compte -> catégorie élémentaire -> ligne du P&L comptable.
 * Fonctions pures. Distincte de la correspondance bancaire (lib/pastCategoryMapping.ts), qui alimente
 * aussi Futur et la fiabilité : aucune donnée ni aucun type partagé.
 *
 * Principe du fichier « P&L Analytique à partir d'un grand livre » : un compte suit la racine la plus
 * longue qui le couvre (6041 prime sur 604, qui prime sur 60). Un compte aboutit donc à une seule
 * catégorie, et les niveaux de marge s'additionnent à partir des catégories : pas de double compte.
 */

export const LIGNES_COMPTABLES = [
  { cle: "revenue", libelle: "Chiffre d'affaires" },
  { cle: "direct_costs", libelle: "Coûts directs" },
  { cle: "inventory_variation", libelle: "Variation de stocks" },
  { cle: "other_variable_costs", libelle: "Autres coûts variables" },
  { cle: "structure_costs", libelle: "Coûts de structure" },
  { cle: "depreciation", libelle: "Amortissements et dotations" },
  { cle: "financial", libelle: "Éléments financiers" },
  { cle: "other_items", libelle: "Autres éléments" },
  { cle: "income_tax", libelle: "Impôts" },
] as const;

export type LigneComptable = (typeof LIGNES_COMPTABLES)[number]["cle"];

// Traitement explicite d'un compte de résultat qu'on écarte du P&L, sans en faire une anomalie.
export const HORS_PERIMETRE = "out_of_scope";
export type DestinationComptable = LigneComptable | typeof HORS_PERIMETRE;

export const LIBELLE_HORS_PERIMETRE = "Hors périmètre du P&L";

export function estLigneComptable(valeur: unknown): valeur is LigneComptable {
  return LIGNES_COMPTABLES.some((l) => l.cle === valeur);
}

export function estDestinationComptable(valeur: unknown): valeur is DestinationComptable {
  return valeur === HORS_PERIMETRE || estLigneComptable(valeur);
}

export function libelleDestination(destination: DestinationComptable): string {
  return destination === HORS_PERIMETRE ? LIBELLE_HORS_PERIMETRE : LIGNES_COMPTABLES.find((l) => l.cle === destination)!.libelle;
}

export interface RegleCorrespondance {
  prefixe: string; // « 6 », « 60 », « 604 », « 6041 »
  destination: DestinationComptable;
  categorie: string; // catégorie analytique élémentaire
}

/** Numéro de compte sans espace ; vide s'il n'est pas purement numérique (jamais deviné). */
export function normaliserCompte(numero: string): string {
  const net = numero.replace(/\s+/g, "");
  return /^\d+$/.test(net) ? net : "";
}

/** Comptes de résultat : classes 6 et 7. Tout le reste (bilan, classes 8 et 9) sort du P&L. */
export function estCompteDeResultat(numero: string): boolean {
  return /^[67]/.test(numero);
}

const LONGUEUR_MAX_CATEGORIE = 80;

/** Erreur d'une règle saisie, ou null. Un compte de bilan ne peut pas être forcé dans le P&L. */
export function erreurRegle(regle: RegleCorrespondance): string | null {
  if (!/^\d{1,12}$/.test(regle.prefixe)) return "La racine doit être composée de chiffres.";
  if (!estDestinationComptable(regle.destination)) return "Ligne du P&L inconnue.";
  const categorie = regle.categorie.trim();
  if (categorie === "" || categorie.length > LONGUEUR_MAX_CATEGORIE) return "Nommez la catégorie (80 caractères au plus).";
  if (!estCompteDeResultat(regle.prefixe)) return "Seuls les comptes de résultat (classes 6 et 7) entrent dans le P&L comptable.";
  return null;
}

export type IndexRegles = ReadonlyMap<string, RegleCorrespondance>;

export function indexerRegles(regles: RegleCorrespondance[]): IndexRegles {
  return new Map(regles.map((r) => [r.prefixe, r]));
}

/** Règle applicable : la racine la plus longue qui couvre le compte, sinon null. */
export function regleDuCompte(numero: string, index: IndexRegles): RegleCorrespondance | null {
  for (let longueur = numero.length; longueur > 0; longueur--) {
    const regle = index.get(numero.slice(0, longueur));
    if (regle) return regle;
  }
  return null;
}

export type StatutCompte = "affecte" | "hors_perimetre" | "non_affecte" | "bilan";

export interface AffectationCompte {
  statut: StatutCompte;
  regle: RegleCorrespondance | null;
}

export function affecterCompte(numero: string, index: IndexRegles): AffectationCompte {
  if (!estCompteDeResultat(numero)) return { statut: "bilan", regle: null };
  const regle = regleDuCompte(numero, index);
  if (!regle) return { statut: "non_affecte", regle: null };
  return { statut: regle.destination === HORS_PERIMETRE ? "hors_perimetre" : "affecte", regle };
}

/**
 * Modèle proposé, repris du fichier Excel de référence : point de départ à appliquer et à corriger,
 * jamais une règle propre à une entreprise. Ajouts au fichier : un seul 621 (il y figurait deux fois,
 * ce qui permettrait un double compte), et les classes 70 à 79 détaillées, car un seul « 7 » rangerait
 * les produits financiers et exceptionnels dans le chiffre d'affaires.
 */
export const MODELE_CORRESPONDANCE: readonly RegleCorrespondance[] = [
  { prefixe: "70", destination: "revenue", categorie: "Ventes" },
  { prefixe: "601", destination: "direct_costs", categorie: "Matières premières" },
  { prefixe: "602", destination: "direct_costs", categorie: "Fournitures consommables" },
  { prefixe: "603", destination: "inventory_variation", categorie: "Variation de stock" },
  { prefixe: "71", destination: "inventory_variation", categorie: "Production stockée" },
  { prefixe: "607", destination: "direct_costs", categorie: "Marchandises" },
  { prefixe: "609", destination: "direct_costs", categorie: "Rabais, ristournes" },
  { prefixe: "6041", destination: "direct_costs", categorie: "Fabrication et conditionnement" },
  { prefixe: "604", destination: "other_variable_costs", categorie: "Prestations de service" },
  { prefixe: "623", destination: "other_variable_costs", categorie: "Publicité" },
  { prefixe: "624", destination: "other_variable_costs", categorie: "Préparation et expédition" },
  { prefixe: "627", destination: "other_variable_costs", categorie: "Services bancaires" },
  { prefixe: "605", destination: "structure_costs", categorie: "Matériel, équipement, travaux" },
  { prefixe: "606", destination: "structure_costs", categorie: "Achats non stockables" },
  { prefixe: "61", destination: "structure_costs", categorie: "Services extérieurs" },
  { prefixe: "621", destination: "structure_costs", categorie: "Personnel extérieur" },
  { prefixe: "622", destination: "structure_costs", categorie: "Intermédiaires et honoraires" },
  { prefixe: "625", destination: "structure_costs", categorie: "Déplacements, restauration" },
  { prefixe: "626", destination: "structure_costs", categorie: "Frais postaux et télécom" },
  { prefixe: "628", destination: "structure_costs", categorie: "Divers" },
  { prefixe: "63", destination: "structure_costs", categorie: "Impôts hors IS" },
  { prefixe: "64", destination: "structure_costs", categorie: "RH" },
  { prefixe: "65", destination: "structure_costs", categorie: "Autres charges de gestion courante" },
  { prefixe: "72", destination: "structure_costs", categorie: "Production immobilisée" },
  { prefixe: "74", destination: "structure_costs", categorie: "Subventions d'exploitation" },
  { prefixe: "75", destination: "structure_costs", categorie: "Autres produits de gestion courante" },
  { prefixe: "791", destination: "structure_costs", categorie: "Transferts de charges d'exploitation" },
  { prefixe: "681", destination: "depreciation", categorie: "Dotations d'exploitation" },
  { prefixe: "781", destination: "depreciation", categorie: "Reprises d'exploitation" },
  { prefixe: "66", destination: "financial", categorie: "Charges financières" },
  { prefixe: "686", destination: "financial", categorie: "Dotations financières" },
  { prefixe: "76", destination: "financial", categorie: "Produits financiers" },
  { prefixe: "786", destination: "financial", categorie: "Reprises financières" },
  { prefixe: "796", destination: "financial", categorie: "Transferts de charges financières" },
  { prefixe: "67", destination: "other_items", categorie: "Charges exceptionnelles" },
  { prefixe: "687", destination: "other_items", categorie: "Dotations exceptionnelles" },
  { prefixe: "77", destination: "other_items", categorie: "Produits exceptionnels" },
  { prefixe: "787", destination: "other_items", categorie: "Reprises exceptionnelles" },
  { prefixe: "797", destination: "other_items", categorie: "Transferts de charges exceptionnelles" },
  { prefixe: "69", destination: "income_tax", categorie: "Impôts sur les bénéfices" },
];
