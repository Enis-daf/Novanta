import { decalerDateISO } from "./dates";
import { formatDate, formatMontant } from "./format";
import type { AlerteRisque, CouvertureAnalyse, FactureDansAlerte, GroupeAlertes, Mesures, Plausibilite } from "./probaRisques";

/**
 * Gestion des risques — formulations de l'écran. Fonctions pures : chaque phrase dit exactement ce
 * que le calcul a montré, et rien de plus (pas de garantie, pas d'échéance contractuelle, pas de
 * probabilité inventée).
 */

const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? "s" : ""}`;
const pourcent = (x: number) => (x > 0 && x < 0.01 ? "moins de 1 %" : x > 0.99 && x < 1 ? "plus de 99 %" : `${Math.round(x * 100)} %`);

export function titreGroupe(g: GroupeAlertes): string {
  if (g.type === "seule") return "Un retard sur cette facture peut faire passer votre trésorerie sous zéro.";
  if (g.type === "seules_multiples") {
    return g.nombreTotal === 2
      ? "Deux factures présentent chacune un risque de passage sous zéro en cas de retard."
      : `${g.nombreTotal} factures présentent chacune un risque de passage sous zéro en cas de retard.`;
  }
  if (g.type === "duo") {
    return g.nombreTotal === 1
      ? "Le retard simultané de ces deux factures peut faire passer votre trésorerie sous zéro."
      : `Le retard simultané de deux de ces factures peut faire passer votre trésorerie sous zéro (${g.nombreTotal} combinaisons).`;
  }
  return g.nombreTotal === 1
    ? "Le retard de cette facture aggraverait une tension déjà prévue."
    : `Le retard de l'une de ces ${g.nombreTotal} factures aggraverait une tension déjà prévue.`;
}

/** « Tension le 30 nov. 2026 · déficit 10 000 € · 1 jour sous zéro ». */
export function resumeTension(m: Mesures, dates: string[]): string {
  const jour = m.episodeDebut ?? m.premierNegatif;
  const quand = jour !== null ? `Tension le ${formatDate(dates[jour])}` : "Tension";
  const duree = m.retourPositif ? `${pluriel(m.dureeJours, "jour")} sous zéro` : "pas de retour au-dessus de zéro avant la fin de l'horizon";
  return `${quand} · déficit ${formatMontant(m.deficitMax)} · ${duree}`;
}

export function nomFacture(f: Pick<FactureDansAlerte, "numero" | "client">): string {
  return f.numero ? `${f.numero} — ${f.client}` : `Facture prévisionnelle — ${f.client}`;
}

/** Dernier jour de paiement qui ne crée pas la tension : la veille de la date testée. */
function apresLe(f: FactureDansAlerte, dates: string[]): string {
  return f.dateTestee === null ? `la fin de l'horizon (${formatDate(dates[dates.length - 1])})` : `le ${formatDate(decalerDateISO(f.dateTestee, -1))}`;
}

/** La phrase du retard déclencheur, conditionnelle au scénario analysé. */
export function phraseDeclencheur(a: AlerteRisque, dates: string[]): string {
  if (a.type === "duo") {
    const [x, y] = a.factures;
    return `Si ${nomFacture(x)} arrive après ${apresLe(x, dates)} et ${nomFacture(y)} après ${apresLe(y, dates)}, la trésorerie passe sous zéro dans les hypothèses analysées.`;
  }
  const f = a.factures[0];
  const prefixe = f.dateCertaine ? "Si ce paiement était malgré tout retardé, un" : "Un";
  const effet = a.type === "aggravation" ? "aggraverait la tension déjà prévue" : "provoquerait une tension";
  return `Encaissement prévu le ${formatDate(f.dateReference)}. ${prefixe} paiement après ${apresLe(f, dates)} ${effet} dans les hypothèses analysées.`;
}

export const PHRASE_UN_SUFFIT = "Recevoir l'un des deux paiements à sa date de référence suffit à éviter ce creux.";

export function phrasePlausibilite(p: Plausibilite): string {
  if (!p.estimee) return "Plausibilité du retard non estimée.";
  const source = p.source === "client" ? "de ce client" : "de votre compte";
  return `Selon l'historique de paiement ${source}, ${pourcent(p.part)} des paiements comparables arriveraient à cette date ou plus tard.`;
}

export const PHRASE_MEME_CLIENT = "Même client : un retard commun est possible. Aucune probabilité conjointe n'est calculée.";

/** Message quand il n'y a aucune alerte : jamais « aucun risque ». */
export function messageSansAlerte(c: CouvertureAnalyse): string {
  if (c.facturesAnalysees === 0) return "Aucune facture à encaisser sur l'horizon analysé : rien à tester.";
  return c.partielle
    ? "Aucune dépendance critique à une ou deux factures détectée dans le périmètre analysé (analyse partielle)."
    : "Aucune dépendance critique à une ou deux factures détectée sur l'horizon analysé.";
}

export function messagePartiel(c: CouvertureAnalyse): string | null {
  if (!c.partielle) return null;
  return `Analyse partielle : ${pluriel(c.facturesAnalysees, "facture")} testée${c.facturesAnalysees > 1 ? "s" : ""} seule${c.facturesAnalysees > 1 ? "s" : ""}, ${c.pairesEvaluees + c.pairesEcarteesSansRisque} paire${c.pairesEvaluees + c.pairesEcarteesSansRisque > 1 ? "s" : ""} sur ${c.pairesPossibles} examinée${c.pairesPossibles > 1 ? "s" : ""} avant la limite de calcul. L'absence d'alerte sur le reste n'est pas vérifiée.`;
}
