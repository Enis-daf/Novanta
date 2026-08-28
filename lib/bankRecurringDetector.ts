import { ajouterJours, ajouterMois, parseDateISO, toISODate } from "./dates";
import { NormalizedBankTransaction } from "./bankTransaction";

/**
 * Moteur de détection des dépenses récurrentes. Ne dépend QUE de NormalizedBankTransaction[] —
 * jamais du XLSX ni d'aucune autre source — pour rester réutilisable tel quel par une future
 * source Pennylane (voir bankTransaction.ts).
 *
 * Périmètre V1 : hebdomadaire et mensuel uniquement, déterministe, sans IA.
 */

export type FrequenceDetectee = "hebdomadaire" | "mensuel";

export interface OccurrenceCandidat {
  date: string; // YYYY-MM-DD
  montant: number; // valeur absolue
}

export interface RecurringChargeCandidate {
  id: string; // stable (dérivé du libellé normalisé), utilisable comme clé React
  libellePropose: string;
  montantPropose: number; // médiane des montants observés (valeur absolue)
  frequence: FrequenceDetectee;
  derniereOccurrence: string; // YYYY-MM-DD
  prochaineOccurrenceEstimee: string; // YYYY-MM-DD, dérivée de la cadence détectée
  nombreOccurrences: number;
  montantMin: number;
  montantMax: number;
  occurrences: OccurrenceCandidat[];
}

const OCCURRENCES_MINIMUM = 3;

function mediane(valeurs: number[]): number {
  const triees = [...valeurs].sort((a, b) => a - b);
  const milieu = Math.floor(triees.length / 2);
  return triees.length % 2 === 0 ? (triees[milieu - 1] + triees[milieu]) / 2 : triees[milieu];
}

/** tolérance = max(5 €, 5 % du montant médian) — la régularité temporelle prime sur l'égalité stricte. */
function toleranceMontant(montantMedian: number): number {
  return Math.max(5, montantMedian * 0.05);
}

function ecartJours(dateA: string, dateB: string): number {
  const ms = parseDateISO(dateB).getTime() - parseDateISO(dateA).getTime();
  return Math.round(ms / 86400000);
}

function moisAbsolu(dateISO: string): number {
  const d = parseDateISO(dateISO);
  return d.getFullYear() * 12 + d.getMonth();
}

/**
 * Détecte une cadence hebdomadaire (écart ~7 jours, tolérance week-ends/jours ouvrés) ou une
 * cadence mensuelle calendaire (le mois avance de 1 à chaque occurrence, sans exiger un nombre
 * de jours précis — tolère nativement le glissement de fin de mois : 31 janvier, 28 février,
 * 31 mars, 30 avril). Retourne null si aucune des deux cadences n'est cohérente sur TOUTES les
 * occurrences (donc pas de quotidien/trimestriel/annuel en V1 — hors périmètre).
 */
function detecterFrequence(datesTriees: string[]): FrequenceDetectee | null {
  if (datesTriees.length < 2) return null;

  const ecarts = datesTriees.slice(1).map((date, i) => ecartJours(datesTriees[i], date));
  if (ecarts.every((e) => e >= 5 && e <= 9)) return "hebdomadaire";

  const toutMensuel = datesTriees.every(
    (date, i) => i === 0 || moisAbsolu(date) - moisAbsolu(datesTriees[i - 1]) === 1
  );
  if (toutMensuel) return "mensuel";

  return null;
}

export function detecterChargesRecurrentes(transactions: NormalizedBankTransaction[]): RecurringChargeCandidate[] {
  // Les charges récurrentes ne sont recherchées que parmi les débits (montants négatifs).
  const debits = transactions.filter((t) => t.signedAmount < 0 && t.labelNormalized);

  const groupes = new Map<string, NormalizedBankTransaction[]>();
  for (const transaction of debits) {
    const liste = groupes.get(transaction.labelNormalized) ?? [];
    liste.push(transaction);
    groupes.set(transaction.labelNormalized, liste);
  }

  const candidats: RecurringChargeCandidate[] = [];

  for (const [cle, occurrencesBrutes] of groupes) {
    if (occurrencesBrutes.length < OCCURRENCES_MINIMUM) continue;

    const triees = [...occurrencesBrutes].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const dates = triees.map((t) => t.date);
    const montants = triees.map((t) => Math.abs(t.signedAmount));

    // Le montant ne doit surtout pas devoir être identique (ex: Shopify facturé en USD avec
    // conversion EUR variable) — mais un groupe trop variable (ex: EDF 430/912/287 €) ne doit pas
    // être proposé comme charge fixe. Référence = médiane pour éviter qu'une anomalie ponctuelle
    // ne fausse la proposition.
    const montantMedian = mediane(montants);
    const tolerance = toleranceMontant(montantMedian);
    const montantsCoherents = montants.every((m) => Math.abs(m - montantMedian) <= tolerance);
    if (!montantsCoherents) continue;

    const frequence = detecterFrequence(dates);
    if (!frequence) continue;

    const derniereOccurrence = dates[dates.length - 1];
    const prochaineOccurrenceEstimee = toISODate(
      frequence === "hebdomadaire"
        ? ajouterJours(parseDateISO(derniereOccurrence), 7)
        : ajouterMois(parseDateISO(derniereOccurrence), 1)
    );

    candidats.push({
      id: cle,
      libellePropose: triees[triees.length - 1].labelOriginal.trim(),
      montantPropose: montantMedian,
      frequence,
      derniereOccurrence,
      prochaineOccurrenceEstimee,
      nombreOccurrences: triees.length,
      montantMin: Math.min(...montants),
      montantMax: Math.max(...montants),
      occurrences: triees.map((t) => ({ date: t.date, montant: Math.abs(t.signedAmount) })),
    });
  }

  return candidats.sort(
    (a, b) => b.nombreOccurrences - a.nombreOccurrences || a.libellePropose.localeCompare(b.libellePropose)
  );
}
