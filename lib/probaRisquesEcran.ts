import { decalerDateISO } from "./dates";
import { formatDate, formatMontant } from "./format";
import type { AlerteRisque, CouvertureAnalyse, FactureDansAlerte, GroupeAlertes, Mesures, Plausibilite, ResultatRisques } from "./probaRisques";

/**
 * Gestion des risques — formulations de l'écran. Fonctions pures : chaque phrase dit exactement ce
 * que le calcul a montré, et rien de plus (pas de garantie, pas d'échéance contractuelle, pas de
 * probabilité inventée, pas de conclusion générale de sécurité).
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

function encaissementDeReference(f: FactureDansAlerte): string {
  return f.dateReferenceEstimee ? `Encaissement estimé au ${formatDate(f.dateReference)} (facture en retard)` : `Encaissement prévu le ${formatDate(f.dateReference)}`;
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
  return `${encaissementDeReference(f)}. ${prefixe} paiement après ${apresLe(f, dates)} ${effet} dans les hypothèses analysées.`;
}

/** Dates propres à chaque facture du scénario : référence, date testée, retard supplémentaire. */
export function datesDuScenario(f: FactureDansAlerte): string {
  const reference = `${f.dateReferenceEstimee ? "estimé au" : "prévu le"} ${formatDate(f.dateReference)}`;
  const teste = f.dateTestee ? `testé le ${formatDate(f.dateTestee)}` : "testé après la fin de l'horizon";
  return `Encaissement ${reference}, ${teste} (+${pluriel(f.retardJours, "jour")})`;
}

export const PHRASE_UN_SUFFIT = "Recevoir l'un des deux paiements à sa date de référence suffit à éviter ce creux.";
export const PHRASE_DATES_CONJOINTES = "Ces deux dates valent ensemble pour ce scénario : ce ne sont pas des limites indépendantes.";

export function phrasePlausibilite(p: Plausibilite): string {
  if (!p.estimee) return "Plausibilité du retard non estimée.";
  const source = p.source === "client" ? "de ce client" : "de votre compte";
  return `Selon l'historique de paiement ${source}, ${pourcent(p.part)} des paiements comparables arriveraient à cette date ou plus tard.`;
}

export const PHRASE_MEME_CLIENT = "Même client : un retard commun est possible. Aucune probabilité conjointe n'est calculée.";

/** Portée de la référence : l'analyse est conditionnelle à elle. */
export function phrasesReference(r: ResultatRisques["reference"]): string[] {
  const phrases = ["Analyse fondée sur la projection de référence, incluant les flux incertains prévus."];
  if (r.fluxIncertains > 0) {
    const financement = r.financementsIncertains > 0 ? `, dont ${pluriel(r.financementsIncertains, "financement")}` : "";
    phrases.push(
      `Elle inclut ${pluriel(r.fluxIncertains, "flux incertain")}${financement} : une absence d'alerte ne signifie pas que la trésorerie resterait positive sans ${r.fluxIncertains > 1 ? "eux" : "lui"}.`
    );
  }
  if (r.hypothesesARenseigner > 0) {
    phrases.push(`${pluriel(r.hypothesesARenseigner, "hypothèse")} à renseigner, prise${r.hypothesesARenseigner > 1 ? "s" : ""} telle${r.hypothesesARenseigner > 1 ? "s" : ""} que saisie${r.hypothesesARenseigner > 1 ? "s" : ""} dans Futur.`);
  }
  phrases.push("Analyse de sensibilité aux retards d'une ou deux factures : elle ne résume pas le risque des perspectives pondérées.");
  return phrases;
}

export type TypeLimite = "donnees" | "methode" | "calcul" | "affichage";

/**
 * Les quatre limites possibles, chacune avec sa phrase. « donnees », « methode » et « calcul »
 * rendent l'analyse partielle ; « affichage » ne change rien au résultat calculé.
 */
export function limitesCouverture(c: CouvertureAnalyse): { type: TypeLimite; texte: string }[] {
  const limites: { type: TypeLimite; texte: string }[] = [];
  const n = c.perimetre.aActualiser.length;
  if (n > 0) {
    limites.push({
      type: "donnees",
      texte: `${pluriel(n, "facture")} en retard sans date d'encaissement estimable : à actualiser, non testée${n > 1 ? "s" : ""}.`,
    });
  }
  if (c.restrictionMethode) limites.push({ type: "methode", texte: c.restrictionMethode });
  if (c.arret) {
    const cause = c.arret.cause === "budget_temps" ? "limite de durée du calcul atteinte" : "nombre maximal de scénarios atteint";
    const nonFaites = [
      c.facturesSeulesIncompletes > 0 ? `${pluriel(c.facturesSeulesIncompletes, "facture")} testée${c.facturesSeulesIncompletes > 1 ? "s" : ""} en partie seulement` : null,
      c.pairesNonExplorees > 0 ? `${c.pairesNonExplorees} paire${c.pairesNonExplorees > 1 ? "s" : ""} sur ${c.pairesPossibles} non explorée${c.pairesNonExplorees > 1 ? "s" : ""}` : null,
    ].filter(Boolean);
    limites.push({ type: "calcul", texte: `Calcul arrêté avant la fin (${cause})${nonFaites.length > 0 ? ` : ${nonFaites.join(", ")}` : ""}. L'absence d'alerte sur ce reste n'est pas vérifiée.` });
  }
  const masquees = c.affichage.combinaisonsNonListees;
  const condensees = c.affichage.alertesCalculees - c.affichage.alertesDetaillees;
  if (condensees > 0) {
    limites.push({
      type: "affichage",
      texte: `${c.affichage.alertesCalculees} alertes calculées, ${c.affichage.alertesDetaillees} détaillées${masquees > 0 ? `, ${masquees} non listées` : ""} : affichage condensé, le calcul est complet${c.partielle ? " dans son périmètre" : ""}.`,
    });
  }
  return limites;
}

/** Message quand il n'y a aucune alerte : jamais une conclusion générale de sécurité. */
export function messageSansAlerte(c: CouvertureAnalyse): string {
  if (c.facturesAnalysees === 0 && c.perimetre.aActualiser.length === 0) return "Aucune facture à encaisser sur l'horizon analysé : rien à tester.";
  return c.partielle
    ? "Aucune dépendance critique à une ou deux factures détectée dans le périmètre analysé — analyse partielle, voir ses limites."
    : "Aucune dépendance critique à une ou deux factures détectée sur l'horizon analysé, dans la projection de référence.";
}
