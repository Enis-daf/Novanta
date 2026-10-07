export function formatMontant(montant: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(montant);
}

/**
 * Format compact en k€ ("12,4 k€"), arrondi à `decimales` décimales au plus (1 par défaut), sans
 * décimale si le montant tombe juste.
 */
export function formatMontantK(montant: number, decimales = 1): string {
  const facteur = 10 ** decimales;
  const arrondi = Math.round((montant / 1000) * facteur) / facteur;
  const texte = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: decimales }).format(arrondi === 0 ? 0 : arrondi);
  return `${texte} k€`;
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
export function formatMontantComptable(montant: number): string {
  const arrondi = Math.round(montant);
  return arrondi < 0 ? `(${formatMontant(-arrondi)})` : formatMontant(arrondi === 0 ? 0 : arrondi);
}

/** Pourcentage français à une décimale ("57,6 %"). "—" si la valeur n'existe pas. */
export function formatPourcentage(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return "—";
  return new Intl.NumberFormat("fr-FR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(fraction);
}
