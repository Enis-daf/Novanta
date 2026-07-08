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

function estDateValide(dateStr: string | null | undefined): dateStr is string {
  return !!dateStr && !Number.isNaN(parseDateISO(dateStr).getTime());
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
