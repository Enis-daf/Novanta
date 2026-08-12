import { genererOccurrencesRecurrentes } from "./dates";
import { ProfilSaisonnalite, RentreeReguliere } from "./types";

export const NOMBRE_MOIS = 12;
export const TOLERANCE_MIN = 99.9;
export const TOLERANCE_MAX = 100.1;

function arrondirCentimes(montant: number): number {
  return Math.round(montant * 100) / 100;
}

/**
 * Répartition uniforme des 12 mois, en pleine précision flottante — jamais arrondie à 2
 * décimales en stockage. La somme de 12 × (100/12) vaut ~99,999999999999986 en double
 * précision (écart de l'ordre de 10⁻¹⁴), totalement négligeable face à la tolérance de 0,1
 * point demandée : aucune astuce de répartition du reste n'est nécessaire.
 */
export function repartitionUniforme(): number[] {
  return Array(NOMBRE_MOIS).fill(100 / NOMBRE_MOIS);
}

export function totalPonderations(ponderations: number[]): number {
  return ponderations.reduce((acc, p) => acc + p, 0);
}

export function totalDansTolerance(total: number): boolean {
  return total >= TOLERANCE_MIN && total <= TOLERANCE_MAX;
}

/**
 * Normalisation proportionnelle : chaque pondération non nulle est mise à l'échelle par
 * 100/total, préservant les proportions relatives choisies par l'utilisateur. Un poids à 0
 * reste strictement à 0 (0 × n'importe quel facteur = 0) — jamais transformé en valeur positive
 * par la correction.
 */
export function normaliserPonderations(ponderations: number[]): number[] {
  const total = totalPonderations(ponderations);
  if (total === 0) return ponderations.slice();
  const facteur = 100 / total;
  return ponderations.map((p) => (p === 0 ? 0 : p * facteur));
}

/** État du total des pondérations, pour l'affichage du panneau — jamais utilisé par le moteur. */
export type EtatTotalPonderations = "exact" | "normalisable" | "invalide";

export function etatTotalPonderations(total: number): EtatTotalPonderations {
  if (Math.abs(total - 100) < 1e-9) return "exact";
  if (totalDansTolerance(total)) return "normalisable";
  return "invalide";
}

/**
 * Montant d'un mois donné (0 = janvier ... 11 = décembre) d'un profil de saisonnalité —
 * indépendant de toute année précise, puisque le profil se répète à l'identique chaque année.
 * Normalise les pondérations à la lecture seulement (jamais en écrivant le profil). null =
 * indisponible (profil incomplet, ou total hors tolérance [99,90 %, 100,10 %]). C'est la valeur
 * utilisée par le moteur de calcul (jamais une valeur mise en cache).
 */
export function montantMoisSaisonnalise(profil: ProfilSaisonnalite, moisIndex: number): number | null {
  if (!Number.isFinite(profil.montantAnnuel) || profil.montantAnnuel < 0) return null;
  if (profil.ponderationsMensuelles.length !== NOMBRE_MOIS) return null;

  const total = totalPonderations(profil.ponderationsMensuelles);
  if (!totalDansTolerance(total)) return null;

  const ponderationsEffectives = normaliserPonderations(profil.ponderationsMensuelles);
  const ponderationMois = ponderationsEffectives[moisIndex];
  if (!Number.isFinite(ponderationMois)) return null;

  return arrondirCentimes(profil.montantAnnuel * (ponderationMois / 100));
}

/**
 * Montant BRUT d'un mois : montant annuel × pondération telle que saisie, sans normalisation ni
 * garde-fou de tolérance. Utilisé uniquement pour l'affichage/l'édition du panneau (le montant
 * mensuel doit toujours être éditable, même quand le total n'est pas encore à 100 %) — jamais
 * par le moteur de calcul, qui utilise montantMoisSaisonnalise.
 */
export function montantMoisBrut(profil: ProfilSaisonnalite, moisIndex: number): number {
  return arrondirCentimes(profil.montantAnnuel * (profil.ponderationsMensuelles[moisIndex] / 100));
}

/**
 * Dérive un profil { montantAnnuel, ponderationsMensuelles } à partir de 12 montants mensuels
 * (ex. après édition manuelle d'un montant) : le montant annuel devient la somme des 12
 * montants, et chaque pondération = montant du mois / montant annuel × 100. Les 12 pourcentages
 * obtenus totalisent alors exactement 100 % par construction (somme / somme × 100), sans qu'une
 * normalisation séparée soit nécessaire. Un montant annuel nul laisse toutes les pondérations à 0.
 */
export function profilDepuisMontants(montantsMensuels: number[]): ProfilSaisonnalite {
  const montantAnnuel = montantsMensuels.reduce((acc, m) => acc + m, 0);
  const ponderationsMensuelles =
    montantAnnuel === 0
      ? montantsMensuels.map(() => 0)
      : montantsMensuels.map((m) => (m / montantAnnuel) * 100);
  return { montantAnnuel, ponderationsMensuelles };
}

function premierJourMois(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function dernierJourMois(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

/**
 * Montant d'UNE occurrence d'une Rentrée régulière : montant fixe en mode "fixe" (comportement
 * strictement inchangé), ou dérivé de la saisonnalité en mode "saisonnalise".
 *
 * Règle centrale : la saisonnalité est TOUJOURS mensuelle (montant annuel × pondération du
 * mois — voir montantMoisSaisonnalise). La fréquence de la rentrée ne sert qu'à répartir ENSUITE
 * ce montant mensuel sur les occurrences réelles de la rentrée tombant dans ce même mois
 * calendaire : une seule occurrence pour "mensuel"/"ponctuel" (le montant mensuel entier), ou
 * réparti à parts égales entre les N occurrences du mois pour "quotidien"/"hebdomadaire" — en
 * réutilisant le même moteur de génération d'occurrences que le reste de l'application, jamais
 * une nouvelle logique de calendrier. Jamais une valeur mise en cache — toujours recalculé.
 * null = indisponible ; l'appelant doit alors exclure l'occurrence du calcul.
 */
export function montantOccurrenceRentreeReguliere(rentree: RentreeReguliere, dateOccurrence: Date): number | null {
  if (rentree.modeMontant === "fixe") return rentree.montant;
  if (!rentree.profilSaisonnalite) return null;

  const montantMensuel = montantMoisSaisonnalise(rentree.profilSaisonnalite, dateOccurrence.getMonth());
  if (montantMensuel === null) return null;

  if (rentree.frequence === "mensuel" || rentree.frequence === "ponctuel") return montantMensuel;

  const debutMois = premierJourMois(dateOccurrence);
  const finMois = dernierJourMois(dateOccurrence);
  const occurrencesDuMois = genererOccurrencesRecurrentes(
    rentree.dateDebut,
    rentree.frequence,
    rentree.dateFin,
    finMois
  ).filter((d) => d >= debutMois);

  if (occurrencesDuMois.length === 0) return null;
  return arrondirCentimes(montantMensuel / occurrencesDuMois.length);
}
