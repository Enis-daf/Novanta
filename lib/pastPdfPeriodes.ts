import { formatDateCourte, parseDateISO, toISODate } from "./dates";
import { ConfigExercice, getFiscalYearRange, getPreviousFiscalYearRange } from "./fiscalPeriods";
import { finDeMois } from "./pastAdjustments";
import { moisGlissants } from "./pastBfr";
import { libelleMois } from "./pastDetail";
import { Periode } from "./pastTransactions";

/**
 * Périodes du rapport PDF du module "Passé" — fonctions pures. L'utilisateur choisit UNE période à
 * l'export (un mois civil ou un exercice) ; chaque section en déduit la sienne selon sa nature :
 *
 *  - P&L (Général, Encaissements, marges, EBITDA, Cash flow) : la période choisie, telle quelle
 *    (un mois ou un exercice en cours ne contient que les transactions à ce jour) ;
 *  - BFR : une photographie de fin de mois, jamais un agrégat — la fin du mois choisi, ou la
 *    dernière fin de mois de l'exercice ; si elle n'est pas encore passée, la dernière fin de mois
 *    terminée (dans l'exercice pour un exercice), et c'est dit ;
 *  - Analyse d'écarts : la période choisie (B) face à la période précédente comparable (A) — le
 *    mois précédent, l'exercice précédent ; une période en cours est comparée à la MÊME PORTION de
 *    la précédente, jamais à une période entière.
 */

export type ChoixRapport =
  | { type: "mois"; mois: string } // YYYY-MM
  | { type: "exercice"; debut: string }; // YYYY-MM-DD, premier jour de l'exercice

export interface PlanBfr {
  mois: string; // YYYY-MM de la situation
  date: string; // YYYY-MM-DD, dernier jour de ce mois
  // true : la fin de période demandée n'est pas encore passée, c'est la dernière fin de mois terminée.
  dernierMoisComplet: boolean;
}

export interface PlanEcarts {
  a: Periode;
  b: Periode;
  libelleA: string;
  libelleB: string;
  // « Septembre 2026 vs août 2026 » : B, la période du rapport, d'abord.
  libelle: string;
  // true : période en cours comparée à la même portion de la précédente.
  portion: boolean;
}

export interface PlanRapport {
  choix: ChoixRapport;
  libelle: string; // « Septembre 2026 », « Exercice 2026 », « Exercice 2026/2027 »
  periode: Periode; // période des sections P&L
  enCours: boolean;
  libellePnl: string; // « septembre 2026 », « octobre 2026, à date (15/10/2026) »
  bfr: PlanBfr | null; // null : aucune fin de mois terminée dans la période
  libelleBfr: string;
  ecarts: PlanEcarts;
}

const NOMS_MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** « 30 septembre 2026 », « 1er mars 2026 ». */
export function dateEnLettres(dateISO: string): string {
  const date = parseDateISO(dateISO);
  const jour = date.getDate();
  return `${jour === 1 ? "1er" : jour} ${NOMS_MOIS[date.getMonth()]} ${date.getFullYear()}`;
}

const moisDe = (dateISO: string) => dateISO.slice(0, 7);
const moisAvant = (mois: string) => moisGlissants(mois, 2)[0];
const minuscule = (texte: string) => texte.charAt(0).toLowerCase() + texte.slice(1);

/** Même jour, `mois` mois plus tôt ; borné au dernier jour du mois d'arrivée (31/03 -> 28/02). */
function memeJourAvant(dateISO: string, mois: number): string {
  const date = parseDateISO(dateISO);
  const premier = new Date(date.getFullYear(), date.getMonth() - mois, 1);
  const dernier = new Date(premier.getFullYear(), premier.getMonth() + 1, 0).getDate();
  return toISODate(new Date(premier.getFullYear(), premier.getMonth(), Math.min(date.getDate(), dernier)));
}

/** Dernier mois civil entièrement terminé à la date du jour. */
export function dernierMoisTermine(aujourdhui: string): string {
  return moisAvant(moisDe(aujourdhui));
}

/** « Exercice 2026 » (exercice civil), sinon « Exercice 2026/2027 ». */
export function libelleExercice(periode: Periode): string {
  const debut = Number(periode.debut.slice(0, 4));
  const fin = Number(periode.fin.slice(0, 4));
  return debut === fin ? `Exercice ${debut}` : `Exercice ${debut}/${fin}`;
}

/** Mois proposables à l'export, du plus récent au plus ancien : du mois en cours à celui de la première donnée. */
export function moisProposes(premiereDate: string | null, aujourdhui: string): string[] {
  const courant = moisDe(aujourdhui);
  const premier = premiereDate && moisDe(premiereDate) < courant ? moisDe(premiereDate) : courant;
  const mois: string[] = [];
  for (let m = courant; m >= premier; m = moisAvant(m)) mois.push(m);
  return mois;
}

/** Exercices proposables à l'export (leur premier jour), du plus récent au plus ancien. */
export function exercicesProposes(premiereDate: string | null, aujourdhui: string, config: ConfigExercice): Periode[] {
  const exercices: Periode[] = [getFiscalYearRange(aujourdhui, config)];
  const borne = premiereDate && premiereDate < aujourdhui ? premiereDate : aujourdhui;
  while (exercices[exercices.length - 1].debut > borne) exercices.push(getPreviousFiscalYearRange(exercices[exercices.length - 1].debut, config));
  return exercices;
}

/**
 * Dernière fin de mois de la période déjà passée. Un mois en cours se rabat sur le mois précédent
 * (dernier mois complet) ; un exercice ne sort jamais de ses bornes (`dansLaPeriode`) — null alors
 * s'il n'a encore aucune fin de mois terminée.
 */
function moisBfr(periode: Periode, aujourdhui: string, dansLaPeriode: boolean): string | null {
  const limite = dernierMoisTermine(aujourdhui);
  let mois = moisDe(periode.fin);
  if (finDeMois(mois) > periode.fin) mois = moisAvant(mois);
  if (mois > limite) mois = limite;
  return !dansLaPeriode || finDeMois(mois) >= periode.debut ? mois : null;
}

function planBfr(periode: Periode, aujourdhui: string, dansLaPeriode: boolean): { bfr: PlanBfr | null; libelleBfr: string } {
  const mois = moisBfr(periode, aujourdhui, dansLaPeriode);
  if (mois === null) return { bfr: null, libelleBfr: "aucune fin de mois terminée sur la période" };
  const date = finDeMois(mois);
  // La fin de période demandée (fin du mois, ou dernière fin de mois de l'exercice) n'est pas passée.
  const dernierMoisComplet = mois !== moisBfr(periode, "9999-12-31", dansLaPeriode);
  return {
    bfr: { mois, date, dernierMoisComplet },
    libelleBfr: `situation au ${dateEnLettres(date)}${dernierMoisComplet ? ", dernier mois complet disponible" : ""}`,
  };
}

const bornes = (p: Periode) => `${formatDateCourte(p.debut)} → ${formatDateCourte(p.fin)}`;

/** Plan du rapport : la période choisie, traduite pour chaque section. */
export function planRapport(choix: ChoixRapport, aujourdhui: string, config: ConfigExercice): PlanRapport {
  if (choix.type === "mois") {
    const periode = { debut: `${choix.mois}-01`, fin: finDeMois(choix.mois) };
    const enCours = periode.fin >= aujourdhui;
    const libelle = libelleMois(choix.mois);
    const precedent = moisAvant(choix.mois);
    const libellePrecedent = minuscule(libelleMois(precedent));
    const ecarts: PlanEcarts = enCours
      ? {
          b: { debut: periode.debut, fin: aujourdhui },
          a: { debut: `${precedent}-01`, fin: memeJourAvant(aujourdhui, 1) },
          libelleB: `${libelle} à date`,
          libelleA: `même portion de ${libellePrecedent}`,
          libelle: `${libelle} à date vs même portion de ${libellePrecedent}`,
          portion: true,
        }
      : {
          b: periode,
          a: { debut: `${precedent}-01`, fin: finDeMois(precedent) },
          libelleB: libelle,
          libelleA: libellePrecedent,
          libelle: `${libelle} vs ${libellePrecedent}`,
          portion: false,
        };
    return {
      choix,
      libelle,
      periode,
      enCours,
      libellePnl: enCours ? `${minuscule(libelle)}, à date (${formatDateCourte(aujourdhui)})` : minuscule(libelle),
      ...planBfr(periode, aujourdhui, false),
      ecarts,
    };
  }

  const periode = getFiscalYearRange(choix.debut, config);
  const precedent = getPreviousFiscalYearRange(choix.debut, config);
  const enCours = periode.fin >= aujourdhui;
  const libelle = libelleExercice(periode);
  const libellePrecedent = minuscule(libelleExercice(precedent));
  const ecarts: PlanEcarts = enCours
    ? {
        b: { debut: periode.debut, fin: aujourdhui },
        a: { debut: precedent.debut, fin: memeJourAvant(aujourdhui, 12) },
        libelleB: `${libelle} à date`,
        libelleA: `même portion de l'${libellePrecedent}`,
        libelle: `${libelle} à date vs même portion de l'${libellePrecedent}`,
        portion: true,
      }
    : { b: periode, a: precedent, libelleB: libelle, libelleA: libellePrecedent, libelle: `${libelle} vs ${libellePrecedent}`, portion: false };
  return {
    choix,
    libelle,
    periode,
    enCours,
    libellePnl: enCours ? `${minuscule(libelle)}, à date (${formatDateCourte(aujourdhui)})` : `${minuscule(libelle)} (${bornes(periode)})`,
    ...planBfr(periode, aujourdhui, true),
    ecarts,
  };
}

/** Lignes du résumé affiché avant l'export : ce que chaque section va réellement utiliser. */
export function resumeDuPlan(plan: PlanRapport): string[] {
  const { ecarts } = plan;
  return [
    `Reporting P&L : ${plan.libellePnl}`,
    `BFR : ${plan.bfr ? plan.libelleBfr : `non disponible — ${plan.libelleBfr}`}`,
    `Analyse d'écarts : ${ecarts.libelle} (${bornes(ecarts.b)} vs ${bornes(ecarts.a)})`,
  ];
}
