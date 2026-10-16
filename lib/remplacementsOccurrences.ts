import { toISODate } from "./dates";

/**
 * Occurrences de Charges fixes remplacées par une facture fournisseur réelle (rapprochement
 * confirmé par l'utilisateur — voir lib/rapprochementChargesFixes.ts, qui construit cette
 * structure). Module volontairement minimal : il est lu par les moteurs de calcul et par
 * lib/montantCalcule.ts, qui ne doivent rien connaître d'autre du rapprochement.
 *
 * Une occurrence remplacée ne génère plus de flux prévisionnel : la facture est la vérité pour
 * cette occurrence, qu'elle soit encore à payer ou déjà payée.
 */
export interface Remplacements {
  /** Clé cleOccurrence(chargeId, date de l'occurrence) -> montant réel de la facture remplaçante. */
  montantsReels: Map<string, number>;
}

export const AUCUN_REMPLACEMENT: Remplacements = { montantsReels: new Map() };

export function cleOccurrence(chargeFixeId: string, dateOccurrence: Date | string): string {
  return `${chargeFixeId}|${typeof dateOccurrence === "string" ? dateOccurrence : toISODate(dateOccurrence)}`;
}

export function estOccurrenceRemplacee(
  remplacements: Remplacements | undefined,
  chargeFixeId: string,
  dateOccurrence: Date | string
): boolean {
  return remplacements ? remplacements.montantsReels.has(cleOccurrence(chargeFixeId, dateOccurrence)) : false;
}

/** Montant réel remplaçant une occurrence, ou null si elle n'est pas remplacée. */
export function montantReelOccurrence(
  remplacements: Remplacements | undefined,
  chargeFixeId: string,
  dateOccurrence: Date | string
): number | null {
  return remplacements?.montantsReels.get(cleOccurrence(chargeFixeId, dateOccurrence)) ?? null;
}
