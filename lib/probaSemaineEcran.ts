// Textes du panneau « Encaissements à sécuriser ». Fonctions pures : chaque phrase est construite à
// partir des résultats de l'analyse (jamais d'un scénario préfabriqué) et testée seule.

import { formatDate, formatMontant } from "./format";
import type { FactureASecuriser, NatureAutreFacteur, ResultatSemaine, ScenarioFacture, VulnerabiliteCertaine } from "./probaSemaine";
import type { SemaineRisque } from "./probaIndicateurs";

const pluriel = (n: number, mot: string, motPluriel = `${mot}s`) => `${n.toLocaleString("fr-FR")} ${n > 1 ? motPluriel : mot}`;

export function pourcentSemaine(x: number): string {
  const p = x * 100;
  if (p > 0 && p < 1) return "< 1 %";
  if (p < 100 && p > 99) return "> 99 %";
  return `${Math.round(p)} %`;
}

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const jourDe = (iso: string) => JOURS[new Date(`${iso}T00:00:00Z`).getUTCDay()];

/** « Semaine du lundi 14 déc. 2026 au dimanche 20 déc. 2026 » (semaine tronquée en début ou fin d'horizon). */
export function titreSemaine(s: { debut: string; fin: string }): string {
  return `Semaine du ${jourDe(s.debut)} ${formatDate(s.debut)} au ${jourDe(s.fin)} ${formatDate(s.fin)}`;
}

/** Semaine de l'horizon qui contient une date (null hors horizon). */
export function semaineDeLaDate<T extends { debut: string; fin: string }>(semaines: T[], date: string): T | null {
  return semaines.find((s) => s.debut <= date && date <= s.fin) ?? null;
}

/** Semaine la plus exposée (la plus tôt en cas d'égalité) ; null si aucun scénario négatif. */
export function semaineLaPlusExposee(semaines: SemaineRisque[]): SemaineRisque | null {
  let meilleure: SemaineRisque | null = null;
  for (const s of semaines) if (s.simulationsNegatives > 0 && (meilleure === null || s.simulationsNegatives > meilleure.simulationsNegatives)) meilleure = s;
  return meilleure;
}

export function phraseRisqueSemaine(negatives: number, total: number): string {
  if (negatives === 0) return `Aucun des ${total.toLocaleString("fr-FR")} scénarios ne passe sous 0 € cette semaine.`;
  return `${pluriel(negatives, "scénario")} sur ${total.toLocaleString("fr-FR")} ${negatives > 1 ? "passent" : "passe"} sous 0 € au moins un jour de cette semaine.`;
}

export const PHRASE_DEFINITION_RISQUE =
  "Chaque scénario est compté une seule fois, quel que soit le nombre de jours sous zéro dans la semaine. Ce risque diffère du risque d'un jour donné et du risque sur tout l'horizon.";

export function phrasePortee(r: Pick<ResultatSemaine, "simulationsNegatives" | "analysees" | "echantillon" | "couverture">): string | null {
  if (r.simulationsNegatives === 0) return null;
  if (r.couverture.arret) {
    return `Analyse partielle : ${pluriel(r.couverture.arret.analysees, "scénario négatif analysé", "scénarios négatifs analysés")} sur ${r.simulationsNegatives.toLocaleString("fr-FR")} (limite de temps de calcul atteinte). Les proportions portent sur les scénarios analysés.`;
  }
  if (r.echantillon) {
    return `Échantillon de ${r.analysees.toLocaleString("fr-FR")} scénarios négatifs sur ${r.simulationsNegatives.toLocaleString("fr-FR")}, répartis régulièrement. Les proportions portent sur cet échantillon.`;
  }
  return `Les ${pluriel(r.analysees, "scénario négatif", "scénarios négatifs")} de la semaine ont été rejoués un par un.`;
}

/** Répartition des scénarios analysés selon ce qui supprime le déficit de la semaine. */
export function lignesRepartition(r: Pick<ResultatSemaine, "repartition" | "analysees">): string[] {
  const { facture, simultane, duo, plusieurs, autres } = r.repartition;
  const lignes: string[] = [];
  if (facture > 0) lignes.push(`${pluriel(facture, "scénario")} : une seule facture, encaissée à sa date de référence, suffit à éviter le passage sous zéro (d'autres retards peuvent seulement le réduire).`);
  if (simultane > 0) lignes.push(`${pluriel(simultane, "scénario")} : plusieurs factures en retard en même temps, dont chacune, encaissée à temps, suffit à éviter le passage sous zéro.`);
  if (duo > 0) lignes.push(`${pluriel(duo, "scénario")} : aucune facture seule ne suffit, mais deux factures encaissées à temps évitent le déficit.`);
  if (plusieurs > 0) lignes.push(`${pluriel(plusieurs, "scénario")} : il faut que plus de deux encaissements arrivent à leur date pour éviter le déficit.`);
  if (autres > 0) lignes.push(`${pluriel(autres, "scénario")} : même avec toutes les factures à leur date, la trésorerie passe sous zéro (autres facteurs de tension).`);
  return lignes;
}

export function nomFactureSemaine(f: Pick<FactureASecuriser, "numero" | "client">): string {
  return f.numero ? `${f.numero} — ${f.client}` : `Facture prévisionnelle — ${f.client}`;
}

export function phraseDates(f: FactureASecuriser): string {
  const morceaux = [`Reste à encaisser ${formatMontant(f.montantRestant)}`];
  if (f.dateEcheance) morceaux.push(`échéance contractuelle ${formatDate(f.dateEcheance)}`);
  morceaux.push(`${f.dateReferenceEstimee ? "encaissement estimé au" : "encaissement prévu le"} ${formatDate(f.dateReference)}`);
  return morceaux.join(" · ");
}

/** Contribution mesurée par rejeu : ce que la correction de cette seule facture change. */
export function phraseContribution(f: FactureASecuriser, analysees: number): string {
  const parties: string[] = [];
  if (f.evite > 0) parties.push(`l'encaisser à sa date de référence évite le passage sous zéro dans ${pluriel(f.evite, "scénario")} sur ${analysees.toLocaleString("fr-FR")}`);
  if (f.reduit > 0) parties.push(`réduit le déficit sans l'éviter dans ${pluriel(f.reduit, "scénario")}`);
  if (f.dansUnDuo > 0) parties.push(`est nécessaire avec une autre facture dans ${pluriel(f.dansUnDuo, "scénario")}`);
  const debut = `En retard dans ${pluriel(f.retardee, "scénario négatif", "scénarios négatifs")}`;
  if (parties.length === 0) return `${debut} ; l'encaisser à temps ne change pas le déficit de la semaine.`;
  return `${debut} : ${parties.join(", ")}.`;
}

/** Récit du scénario représentatif (une vraie simulation rejouée). */
export function phrasesScenario(sc: ScenarioFacture, f: FactureASecuriser): string[] {
  const lignes: string[] = [];
  const encaissement =
    sc.dateSimulee === null
      ? `encaissement après la fin de l'horizon`
      : `encaissement simulé le ${formatDate(sc.dateSimulee)} (${sc.retardJours > 0 ? `+${pluriel(sc.retardJours, "jour")}` : "à la date de référence"})`;
  const passage = sc.dejaNegativeALOuverture
    ? `trésorerie déjà sous zéro depuis le ${formatDate(sc.datePassageSousZero)}`
    : `passage sous zéro le ${formatDate(sc.datePassageSousZero)}`;
  lignes.push(`Scénario n° ${(sc.simulation + 1).toLocaleString("fr-FR")} : ${encaissement}, ${passage}, déficit maximal ${formatMontant(sc.deficitMaxSemaine)} dans la semaine.`);
  if (sc.effet === "evite") lignes.push(`Encaissée le ${formatDate(f.dateReference)}, tout le reste identique, la trésorerie reste positive toute la semaine.`);
  else if (sc.effet === "reduit") lignes.push(`Encaissée le ${formatDate(f.dateReference)}, tout le reste identique, le déficit de la semaine passe à ${formatMontant(sc.deficitApresCorrection)}.`);
  else lignes.push(`Encaissée le ${formatDate(f.dateReference)}, le déficit de la semaine reste de ${formatMontant(sc.deficitApresCorrection)}.`);
  if (sc.dateLimite) lignes.push(`Dans ce scénario, tout paiement reçu jusqu'au ${formatDate(sc.dateLimite)} inclus évite le creux de la semaine.`);
  return lignes;
}

export const LIBELLES_AUTRE_FACTEUR: Record<NatureAutreFacteur, string> = {
  non_obtenu: "non obtenu",
  montant_inferieur: "montant inférieur à la prévision",
  montant_superieur: "dépense supérieure à la prévision",
  encaissement_decale: "encaissement décalé",
  depense_declenchee: "dépense conditionnelle déclenchée",
};

export function phraseVulnerabilite(v: VulnerabiliteCertaine): string {
  const quand = v.dateTestee ? `encaissé le ${formatDate(v.dateTestee)}` : "encaissé après la fin de l'horizon";
  return `Si ce paiement certain était malgré tout retardé de ${pluriel(v.retardJours, "jour")} (${quand}), la trésorerie passerait sous zéro le ${formatDate(v.datePassageSousZero)}, déficit ${formatMontant(v.deficit)}.`;
}

export function phraseResultatTest(t: { deficitSemaine: number; datePassageSousZero: string | null }, date: string): string {
  if (t.deficitSemaine === 0) return `Encaissée le ${formatDate(date)}, la trésorerie reste positive toute la semaine dans ce scénario.`;
  return `Encaissée le ${formatDate(date)}, la trésorerie passe sous zéro le ${formatDate(t.datePassageSousZero!)} ; déficit maximal de la semaine ${formatMontant(t.deficitSemaine)}.`;
}
