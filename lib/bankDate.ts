import { toISODate } from "./dates";

/**
 * Parsing déterministe des dates bancaires. Priorité 1 : vraie date Excel (objet Date, déjà
 * résolue par la lib xlsx avec cellDates: true). Priorité 2 : texte au format jour/mois/année
 * avec séparateur /, . ou - et année sur 2 ou 4 chiffres.
 *
 * Ne tente JAMAIS une interprétation MM/DD (format US) : le premier groupe est toujours le jour.
 * Valide que la date construite ne "déborde" pas silencieusement (ex: 30 février) — sinon null.
 */

const REGEX_DATE_TEXTE = /^(\d{1,2})([./-])(\d{1,2})\2(\d{2}|\d{4})$/;

function anneeComplete(anneeBrute: string): number {
  if (anneeBrute.length === 4) return Number(anneeBrute);
  const n = Number(anneeBrute);
  // Convention standard : 00-69 -> 2000-2069, 70-99 -> 1970-1999.
  return n < 70 ? 2000 + n : 1900 + n;
}

export function analyserDateBancaire(valeurCellule: unknown): string | null {
  if (valeurCellule instanceof Date) {
    return Number.isNaN(valeurCellule.getTime()) ? null : toISODate(valeurCellule);
  }

  const texte = String(valeurCellule ?? "").trim();
  if (!texte) return null;

  const correspondance = texte.match(REGEX_DATE_TEXTE);
  if (!correspondance) return null;

  const jour = Number(correspondance[1]);
  const mois = Number(correspondance[3]);
  const annee = anneeComplete(correspondance[4]);

  if (mois < 1 || mois > 12 || jour < 1 || jour > 31) return null;

  const date = new Date(annee, mois - 1, jour);
  // new Date() "déborde" silencieusement les jours/mois invalides (ex: 30 février -> 2 mars) :
  // on rejette explicitement tout débordement plutôt que d'accepter une date déplacée.
  if (date.getFullYear() !== annee || date.getMonth() !== mois - 1 || date.getDate() !== jour) return null;

  return toISODate(date);
}
