export function formatMontant(montant: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(montant);
}

/** Format compact en k€ (arrondi à 1 décimale max, sans décimale si le montant tombe juste). */
export function formatMontantK(montant: number): string {
  const valeurK = montant / 1000;
  const signe = valeurK < 0 ? -1 : 1;
  const arrondi = (Math.round(Math.abs(valeurK) * 10) / 10) * signe;
  const texte = Number.isInteger(arrondi) ? String(arrondi) : arrondi.toFixed(1).replace(".", ",");
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
