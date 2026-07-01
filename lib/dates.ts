export function parseDateISO(dateStr: string): Date {
  return new Date(dateStr + "T00:00:00");
}

export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
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
