import { ChargeFixe, RentreeReguliere } from "./types";

export function parseDateISO(dateStr: string): Date {
  return new Date(dateStr + "T00:00:00");
}

export function toISODate(date: Date): string {
  const annee = date.getFullYear();
  const mois = String(date.getMonth() + 1).padStart(2, "0");
  const jour = String(date.getDate()).padStart(2, "0");
  return `${annee}-${mois}-${jour}`;
}

export function ajouterJours(date: Date, jours: number): Date {
  const resultat = new Date(date);
  resultat.setDate(resultat.getDate() + jours);
  return resultat;
}

export function decalerDateISO(dateISO: string, jours: number): string {
  return toISODate(ajouterJours(parseDateISO(dateISO), jours));
}

export function ajouterMois(date: Date, mois: number): Date {
  const resultat = new Date(date);
  resultat.setMonth(resultat.getMonth() + mois);
  return resultat;
}

export function todayISO(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return toISODate(d);
}

export function estDateValide(dateStr: string | null | undefined): dateStr is string {
  return !!dateStr && !Number.isNaN(parseDateISO(dateStr).getTime());
}

export type FrequenceRecurrence = ChargeFixe["recurrence"] | RentreeReguliere["frequence"];

/**
 * Génère les dates d'occurrence d'une ligne récurrente entre sa date de début et la borne
 * "fin" (bornée aussi par dateFin si elle est plus tôt). Partagé par le moteur de projection,
 * la synthèse mensuelle, le contrôle mensuel, le bandeau de période et le moteur de montant
 * calculé — c'est la seule source de vérité pour "quelles dates couvre cette ligne".
 */
export function genererOccurrencesRecurrentes(
  dateDebut: string,
  frequence: FrequenceRecurrence,
  dateFin: string | null,
  fin: Date
): Date[] {
  if (!estDateValide(dateDebut)) return [];

  const debut = parseDateISO(dateDebut);
  if (frequence === "ponctuel") return [debut];

  const borneFin = dateFin && parseDateISO(dateFin) < fin ? parseDateISO(dateFin) : fin;
  const pas =
    frequence === "quotidien"
      ? (d: Date) => ajouterJours(d, 1)
      : frequence === "hebdomadaire"
        ? (d: Date) => ajouterJours(d, 7)
        : (d: Date) => ajouterMois(d, 1);

  const occurrences: Date[] = [];
  let curseur = debut;
  while (curseur <= borneFin) {
    occurrences.push(curseur);
    curseur = pas(curseur);
  }
  return occurrences;
}

/** Trie une copie du tableau par date croissante (les dates absentes/invalides passent en dernier). */
export function trierParDate<T>(items: T[], dateDe: (item: T) => string | null | undefined): T[] {
  return [...items].sort((a, b) => {
    const dateA = dateDe(a);
    const dateB = dateDe(b);
    const validA = estDateValide(dateA);
    const validB = estDateValide(dateB);
    if (!validA && !validB) return 0;
    if (!validA) return 1;
    if (!validB) return -1;
    return dateA < dateB ? -1 : dateA > dateB ? 1 : 0;
  });
}

/** Une facture est en retard si sa date est passée, non payée et non litigieuse. Affichage uniquement. */
export function estEnRetard(datePrevue: string | null | undefined, payee: boolean, litigieuse: boolean): boolean {
  if (payee || litigieuse) return false;
  if (!estDateValide(datePrevue)) return false;
  return datePrevue < todayISO();
}

/** Format d'affichage court jj/mm/aaaa, celui utilisé dans les champs date. "" si date vide/invalide. */
export function formatDateCourte(dateISO: string): string {
  if (!estDateValide(dateISO)) return "";
  const date = parseDateISO(dateISO);
  const jour = String(date.getDate()).padStart(2, "0");
  const mois = String(date.getMonth() + 1).padStart(2, "0");
  return `${jour}/${mois}/${date.getFullYear()}`;
}

/** Trie une copie du tableau par montant décroissant (montants absents/invalides passent en dernier). */
export function trierParMontant<T>(items: T[], montantDe: (item: T) => number): T[] {
  return [...items].sort((a, b) => {
    const montantA = montantDe(a);
    const montantB = montantDe(b);
    const validA = Number.isFinite(montantA);
    const validB = Number.isFinite(montantB);
    if (!validA && !validB) return 0;
    if (!validA) return 1;
    if (!validB) return -1;
    return montantB - montantA;
  });
}

export const JOURS_VISIBILITE_APRES_PAIEMENT = 7;

/**
 * Une facture payée depuis plus de 7 jours doit disparaître des tableaux actifs
 * (affichage uniquement — jamais du calcul, déjà exclu dès payee=true, ni de Supabase).
 * Règle la plus sûre pour les factures déjà payées avant l'ajout de paid_at : tant que
 * paid_at est absent, on ne masque jamais (pas de disparition surprise d'anciennes données).
 */
export function estMasqueeApresPaiement(payee: boolean, paidAt: string | null): boolean {
  if (!payee || !paidAt) return false;
  const date = new Date(paidAt);
  if (Number.isNaN(date.getTime())) return false;
  const limite = new Date();
  limite.setDate(limite.getDate() - JOURS_VISIBILITE_APRES_PAIEMENT);
  return date < limite;
}
