/**
 * Mention fiscale des montants du module Passé : ce sont des transactions bancaires, donc TTC.
 * Seul endroit où le mot est écrit ; le module Futur n'affiche jamais cette mention.
 */
export const MENTION_TTC = "TTC";

export interface OptionsMontant {
  // Préfixe « TTC » devant le montant (« TTC 125 k€ »). Réservé aux montants en euros : jamais un
  // pourcentage, un écart en points, une date ou un nombre.
  ttc?: boolean;
}

/** Préfixe « TTC » devant un montant déjà formaté — jamais deux fois. */
export function avecMentionTTC(montantFormate: string): string {
  return montantFormate === MENTION_TTC || montantFormate.startsWith(`${MENTION_TTC} `) ? montantFormate : `${MENTION_TTC} ${montantFormate}`;
}

function appliquerOptions(texte: string, options?: OptionsMontant): string {
  return options?.ttc ? avecMentionTTC(texte) : texte;
}

export function formatMontant(montant: number, options?: OptionsMontant): string {
  const texte = new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(montant);
  return appliquerOptions(texte, options);
}

/** Format compact en k€ (arrondi à 1 décimale max, sans décimale si le montant tombe juste). */
export function formatMontantK(montant: number): string {
  const valeurK = montant / 1000;
  const signe = valeurK < 0 ? -1 : 1;
  const arrondi = (Math.round(Math.abs(valeurK) * 10) / 10) * signe;
  const texte = Number.isInteger(arrondi) ? String(arrondi) : arrondi.toFixed(1).replace(".", ",");
  return `${texte} k€`;
}

/**
 * k€ des graphiques du module Passé ("12,4 k€", "1 586 k€") : séparateur de milliers et nombre de
 * décimales réglable. Distinct de formatMontantK, dont le rendu exact est celui du module Futur et
 * ne doit pas bouger.
 */
export function formatKiloEuros(montant: number, decimales = 1, options?: OptionsMontant): string {
  const facteur = 10 ** decimales;
  const arrondi = Math.round((montant / 1000) * facteur) / facteur;
  const texte = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: decimales }).format(arrondi === 0 ? 0 : arrondi);
  return appliquerOptions(`${texte} k€`, options);
}

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

/** Présentation comptable : un montant négatif s'écrit entre parenthèses, sans signe. */
export function formatMontantComptable(montant: number, options?: OptionsMontant): string {
  const arrondi = Math.round(montant);
  return appliquerOptions(arrondi < 0 ? `(${formatMontant(-arrondi)})` : formatMontant(arrondi === 0 ? 0 : arrondi), options);
}

/** Pourcentage français à une décimale ("57,6 %"). "—" si la valeur n'existe pas. */
export function formatPourcentage(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return "—";
  return new Intl.NumberFormat("fr-FR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(fraction);
}
