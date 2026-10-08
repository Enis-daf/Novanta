import { estDateValide, parseDateISO, toISODate } from "./dates";
import { Periode } from "./pastTransactions";

/**
 * Périodes fiscales du module "Passé" : exercice propre à chaque organisation et périodes
 * prédéfinies qui en découlent. Fonctions pures — seule source des bornes de date des presets,
 * pour tous les onglets.
 */

/** Règle récurrente de début d'exercice (sans année). */
export interface ConfigExercice {
  mois: number; // 1 à 12
  jour: number; // 1 à jourMaxDebutExercice(mois)
}

export const EXERCICE_PAR_DEFAUT: ConfigExercice = { mois: 1, jour: 1 };

// Dernier jour de chaque mois qui existe TOUS les ans (février : 28). Un début d'exercice est une
// règle annuelle récurrente : le 29 février ou le 31 avril ne peuvent pas en être un, et aucune
// règle de repli n'est appliquée en silence — la combinaison est simplement refusée.
const DERNIER_JOUR_RECURRENT = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Plus grand jour acceptable comme début d'exercice pour ce mois (0 si le mois est invalide). */
export function jourMaxDebutExercice(mois: number): number {
  return DERNIER_JOUR_RECURRENT[mois - 1] ?? 0;
}

export function configExerciceValide(config: ConfigExercice): boolean {
  return (
    Number.isInteger(config.mois) &&
    Number.isInteger(config.jour) &&
    config.mois >= 1 &&
    config.mois <= 12 &&
    config.jour >= 1 &&
    config.jour <= jourMaxDebutExercice(config.mois)
  );
}

/** Config exploitable à partir de valeurs lues en base ; le défaut (1er janvier) si elles sont absentes ou invalides. */
export function normaliserConfigExercice(mois: unknown, jour: unknown): ConfigExercice {
  const config = { mois: Number(mois), jour: Number(jour) };
  return configExerciceValide(config) ? config : EXERCICE_PAR_DEFAUT;
}

/**
 * Date située `decalageMois` mois après le début d'exercice de l'année donnée. Le jour de début
 * est conservé quand il existe dans le mois d'arrivée ; sinon c'est le dernier jour de ce mois
 * (un exercice au 31 mars a ses trimestres au 30 juin, 30 septembre et 31 décembre).
 */
function borneExercice(annee: number, config: ConfigExercice, decalageMois = 0): Date {
  const premierDuMois = new Date(annee, config.mois - 1 + decalageMois, 1);
  const dernierJour = new Date(premierDuMois.getFullYear(), premierDuMois.getMonth() + 1, 0).getDate();
  return new Date(premierDuMois.getFullYear(), premierDuMois.getMonth(), Math.min(config.jour, dernierJour));
}

/** Exercice (ou tranche d'exercice) repéré par l'année civile de son début. */
interface RepereExercice {
  annee: number;
  config: ConfigExercice;
}

/** Période de `nombreMois` mois commençant `decalageMois` mois après le début de l'exercice. */
function tranche(repere: RepereExercice, decalageMois: number, nombreMois: number): Periode {
  const fin = borneExercice(repere.annee, repere.config, decalageMois + nombreMois);
  fin.setDate(fin.getDate() - 1);
  return { debut: toISODate(borneExercice(repere.annee, repere.config, decalageMois)), fin: toISODate(fin) };
}

/** Début de l'exercice qui contient la date donnée. */
function debutExerciceContenant(dateISO: string, config: ConfigExercice): RepereExercice {
  const date = parseDateISO(dateISO);
  const annee = date >= borneExercice(date.getFullYear(), config) ? date.getFullYear() : date.getFullYear() - 1;
  return { annee, config };
}

/** Exercice contenant la date donnée : du début d'exercice à la veille du suivant. */
export function getFiscalYearRange(dateISO: string, config: ConfigExercice): Periode {
  return tranche(debutExerciceContenant(dateISO, config), 0, 12);
}

/** Exercice immédiatement précédent celui qui contient la date donnée. */
export function getPreviousFiscalYearRange(dateISO: string, config: ConfigExercice): Periode {
  return tranche(debutExerciceContenant(dateISO, config), -12, 12);
}

/** Semestre (1 ou 2) de l'exercice contenant la date donnée — de l'exercice, pas de l'année civile. */
export function getFiscalSemesterRange(dateISO: string, config: ConfigExercice, semestre: 1 | 2): Periode {
  return tranche(debutExerciceContenant(dateISO, config), (semestre - 1) * 6, 6);
}

/** Trimestre (1 à 4) de l'exercice contenant la date donnée. */
export function getFiscalQuarterRange(dateISO: string, config: ConfigExercice, trimestre: 1 | 2 | 3 | 4): Periode {
  return tranche(debutExerciceContenant(dateISO, config), (trimestre - 1) * 3, 3);
}

/** Tranche (semestre ou trimestre) de l'exercice courant qui contient la date donnée — peut être en cours. */
function trancheContenant(dateISO: string, config: ConfigExercice, nombreMois: 3 | 6): Periode {
  const debut = debutExerciceContenant(dateISO, config);
  for (let decalage = 0; decalage < 12; decalage += nombreMois) {
    const periode = tranche(debut, decalage, nombreMois);
    if (dateISO <= periode.fin) return periode;
  }
  return tranche(debut, 12 - nombreMois, nombreMois);
}

/** Trimestre fiscal contenant la date donnée (potentiellement incomplet). */
export function getCurrentFiscalQuarterRange(dateISO: string, config: ConfigExercice): Periode {
  return trancheContenant(dateISO, config, 3);
}

/** Semestre fiscal contenant la date donnée (potentiellement incomplet). */
export function getCurrentFiscalSemesterRange(dateISO: string, config: ConfigExercice): Periode {
  return trancheContenant(dateISO, config, 6);
}

/**
 * Dernière occurrence ENTIÈREMENT achevée d'une tranche de l'exercice : celle de l'exercice
 * courant si elle est terminée (dernier jour strictement passé), sinon celle de l'exercice
 * précédent. Jamais une tranche en cours ni à venir.
 */
function derniereTrancheAchevee(dateISO: string, config: ConfigExercice, decalageMois: number, nombreMois: number): Periode {
  const debut = debutExerciceContenant(dateISO, config);
  const courante = tranche(debut, decalageMois, nombreMois);
  return courante.fin < dateISO ? courante : tranche(debut, decalageMois - 12, nombreMois);
}

/** Dernier trimestre fiscal n° `trimestre` entièrement achevé à la date donnée. */
export function getLastCompletedFiscalQuarterRange(dateISO: string, config: ConfigExercice, trimestre: 1 | 2 | 3 | 4): Periode {
  return derniereTrancheAchevee(dateISO, config, (trimestre - 1) * 3, 3);
}

/** Dernier semestre fiscal n° `semestre` entièrement achevé à la date donnée. */
export function getLastCompletedFiscalSemesterRange(dateISO: string, config: ConfigExercice, semestre: 1 | 2): Periode {
  return derniereTrancheAchevee(dateISO, config, (semestre - 1) * 6, 6);
}

// --- Périodes prédéfinies ---

/**
 * Deux familles à ne pas confondre :
 *  - « Semestre actuel » / « Trimestre actuel » : la tranche qui contient aujourd'hui, donc
 *    potentiellement incomplète ;
 *  - S1, S2, Q1 à Q4 : la DERNIÈRE occurrence entièrement achevée — jamais une tranche partielle
 *    présentée comme un trimestre ou un semestre plein.
 */
export const PRESETS_PERIODE = [
  { cle: "exercice", libelle: "Exercice", groupe: "Exercice" },
  { cle: "exercice_n1", libelle: "Exercice N-1", groupe: "Exercice" },
  { cle: "semestre_actuel", libelle: "Semestre actuel", groupe: "Semestres" },
  { cle: "s1", libelle: "S1", groupe: "Semestres" },
  { cle: "s2", libelle: "S2", groupe: "Semestres" },
  { cle: "trimestre_actuel", libelle: "Trimestre actuel", groupe: "Trimestres" },
  { cle: "q1", libelle: "Q1", groupe: "Trimestres" },
  { cle: "q2", libelle: "Q2", groupe: "Trimestres" },
  { cle: "q3", libelle: "Q3", groupe: "Trimestres" },
  { cle: "q4", libelle: "Q4", groupe: "Trimestres" },
] as const;

/**
 * Mois civils, indépendants de l'exercice : proposés en plus des périodes fiscales là où l'analyse
 * est mensuelle (comparaison de périodes), jamais à leur place.
 */
export const PRESETS_MENSUELS = [
  { cle: "mois_m1", libelle: "Dernier mois terminé", groupe: "Mois" },
  { cle: "mois_m2", libelle: "Mois précédent (M-2)", groupe: "Mois" },
] as const;

/** Catalogue de presets proposé par un sélecteur de période. */
export type CataloguePresets = readonly { cle: PresetPeriode; libelle: string; groupe: string }[];

export const PRESETS_AVEC_MOIS: CataloguePresets = [...PRESETS_MENSUELS, ...PRESETS_PERIODE];

export type PresetPeriode = (typeof PRESETS_PERIODE)[number]["cle"] | (typeof PRESETS_MENSUELS)[number]["cle"];
export type ChoixPeriode = PresetPeriode | "personnalise";

export const PRESET_PAR_DEFAUT: PresetPeriode = "exercice";

export function estPresetPeriode(valeur: unknown): valeur is PresetPeriode {
  return PRESETS_AVEC_MOIS.some((p) => p.cle === valeur);
}

/** Mois civil entier situé `decalage` mois avant (négatif) celui de la date donnée. */
function moisCivil(dateISO: string, decalage: number): Periode {
  const date = parseDateISO(dateISO);
  return {
    debut: toISODate(new Date(date.getFullYear(), date.getMonth() + decalage, 1)),
    fin: toISODate(new Date(date.getFullYear(), date.getMonth() + decalage + 1, 0)),
  };
}

/** Dernier mois civil entièrement terminé à la date donnée (M-1). */
export function getLastCompletedMonthRange(dateISO: string): Periode {
  return moisCivil(dateISO, -1);
}

/** Bornes d'un preset à la date `aujourdhui`, d'après le début d'exercice de l'organisation. */
export function periodeDuPreset(preset: PresetPeriode, aujourdhui: string, config: ConfigExercice): Periode {
  switch (preset) {
    case "mois_m1":
      return getLastCompletedMonthRange(aujourdhui);
    case "mois_m2":
      return moisCivil(aujourdhui, -2);
    case "exercice":
      return getFiscalYearRange(aujourdhui, config);
    case "exercice_n1":
      return getPreviousFiscalYearRange(aujourdhui, config);
    case "semestre_actuel":
      return getCurrentFiscalSemesterRange(aujourdhui, config);
    case "s1":
      return getLastCompletedFiscalSemesterRange(aujourdhui, config, 1);
    case "s2":
      return getLastCompletedFiscalSemesterRange(aujourdhui, config, 2);
    case "trimestre_actuel":
      return getCurrentFiscalQuarterRange(aujourdhui, config);
    case "q1":
      return getLastCompletedFiscalQuarterRange(aujourdhui, config, 1);
    case "q2":
      return getLastCompletedFiscalQuarterRange(aujourdhui, config, 2);
    case "q3":
      return getLastCompletedFiscalQuarterRange(aujourdhui, config, 3);
    case "q4":
      return getLastCompletedFiscalQuarterRange(aujourdhui, config, 4);
  }
}

/**
 * Preset dont les bornes sont EXACTEMENT celles de la période, sinon null (période personnalisée).
 * Jamais de rapprochement vers le preset le plus proche.
 */
export function presetCorrespondant(
  periode: Periode,
  aujourdhui: string,
  config: ConfigExercice,
  catalogue: CataloguePresets = PRESETS_PERIODE
): PresetPeriode | null {
  for (const { cle } of catalogue) {
    const bornes = periodeDuPreset(cle, aujourdhui, config);
    if (bornes.debut === periode.debut && bornes.fin === periode.fin) return cle;
  }
  return null;
}

/** Période choisie dans le module : un preset (dont les dates se recalculent) ou des dates libres. */
export interface SelectionPeriode {
  choix: ChoixPeriode;
  // Dates de la période personnalisée. Conservées même quand un preset est actif, pour retrouver
  // la dernière saisie libre en revenant sur "Personnalisé".
  personnalisee: Periode;
}

/** Bornes effectives d'une sélection. Un preset suit la config d'exercice et la date du jour. */
export function periodeDeLaSelection(selection: SelectionPeriode, aujourdhui: string, config: ConfigExercice): Periode {
  return selection.choix === "personnalise" ? selection.personnalisee : periodeDuPreset(selection.choix, aujourdhui, config);
}

export function selectionDuPreset(preset: PresetPeriode, aujourdhui: string, config: ConfigExercice): SelectionPeriode {
  return { choix: preset, personnalisee: periodeDuPreset(preset, aujourdhui, config) };
}

export function selectionParDefaut(aujourdhui: string, config: ConfigExercice): SelectionPeriode {
  return selectionDuPreset(PRESET_PAR_DEFAUT, aujourdhui, config);
}

/**
 * Sélection après la saisie libre d'une date : « Personnalisé », sauf si les dates tombent
 * EXACTEMENT sur un preset du catalogue — jamais de rapprochement vers le plus proche.
 */
export function selectionApresSaisie(
  dates: Periode,
  aujourdhui: string,
  config: ConfigExercice,
  catalogue: CataloguePresets = PRESETS_PERIODE
): SelectionPeriode {
  return { choix: presetCorrespondant(dates, aujourdhui, config, catalogue) ?? "personnalise", personnalisee: dates };
}

/**
 * Sélection après un choix dans la liste : un preset garde en réserve la dernière période libre ;
 * « Personnalisé » part des dates actuellement affichées.
 */
export function selectionApresChoix(
  choix: ChoixPeriode,
  courante: SelectionPeriode,
  aujourdhui: string,
  config: ConfigExercice
): SelectionPeriode {
  return {
    choix,
    personnalisee: choix === "personnalise" ? periodeDeLaSelection(courante, aujourdhui, config) : courante.personnalisee,
  };
}

// --- Durée d'une période, pour comparer deux périodes de longueurs différentes ---

/** Durée fiscale naturelle de chaque preset, en mois. */
const DUREE_MOIS_PRESET: Record<PresetPeriode, number> = {
  mois_m1: 1,
  mois_m2: 1,
  exercice: 12,
  exercice_n1: 12,
  semestre_actuel: 6,
  s1: 6,
  s2: 6,
  trimestre_actuel: 3,
  q1: 3,
  q2: 3,
  q3: 3,
  q4: 3,
};

/** Nombre de jours calendaires d'une période, bornes incluses. */
export function nombreDeJours(periode: Periode): number {
  const jour = 24 * 60 * 60 * 1000;
  return Math.round((parseDateISO(periode.fin).getTime() - parseDateISO(periode.debut).getTime()) / jour) + 1;
}

export interface DureePeriode {
  // Durée fiscale naturelle d'un preset ; null pour des dates libres, qui n'ont pas de nombre de
  // mois exact — on ne leur en invente pas un.
  mois: number | null;
  jours: number;
}

export function dureeDeLaSelection(selection: SelectionPeriode, aujourdhui: string, config: ConfigExercice): DureePeriode {
  return {
    mois: selection.choix === "personnalise" ? null : DUREE_MOIS_PRESET[selection.choix],
    jours: nombreDeJours(periodeDeLaSelection(selection, aujourdhui, config)),
  };
}

/**
 * Mise à l'échelle de deux périodes de durées différentes : la plus LONGUE est ramenée à la durée
 * de la plus courte (coefficient = durée courte / durée longue). Unité : le mois quand les deux
 * périodes sont des presets (un mois vaut un mois, qu'il ait 30 ou 31 jours), le jour dès que
 * l'une des deux est faite de dates libres. Durées égales : aucun coefficient, tout reste réel.
 */
export interface Normalisation {
  coefficientA: number;
  coefficientB: number;
  // null quand rien n'est normalisé.
  detail: { cote: "A" | "B"; duree: string } | null;
}

export function normaliserDurees(a: DureePeriode, b: DureePeriode): Normalisation {
  const enMois = a.mois !== null && b.mois !== null;
  const dureeA = enMois ? (a.mois as number) : a.jours;
  const dureeB = enMois ? (b.mois as number) : b.jours;
  if (dureeA === dureeB || dureeA <= 0 || dureeB <= 0) return { coefficientA: 1, coefficientB: 1, detail: null };
  const courte = Math.min(dureeA, dureeB);
  const duree = enMois ? `${courte} mois` : `${courte} jour${courte > 1 ? "s" : ""}`;
  return dureeA > dureeB
    ? { coefficientA: dureeB / dureeA, coefficientB: 1, detail: { cote: "A", duree } }
    : { coefficientA: 1, coefficientB: dureeA / dureeB, detail: { cote: "B", duree } };
}

// --- Persistance locale de la dernière période utilisée, PAR ORGANISATION ---

/** Clé de stockage local : une par organisation, pour ne jamais mélanger les périodes de deux sociétés. */
export function cleStockagePeriode(organizationId: string): string {
  return `past_reporting_period_${organizationId}`;
}

export function serialiserSelection(selection: SelectionPeriode): string {
  return JSON.stringify(selection);
}

/** Sélection relue du stockage local, ou null si elle est absente, illisible ou incohérente. */
export function deserialiserSelection(brut: string | null): SelectionPeriode | null {
  if (!brut) return null;
  try {
    const valeur = JSON.parse(brut) as { choix?: unknown; personnalisee?: { debut?: unknown; fin?: unknown } };
    const { choix, personnalisee } = valeur;
    if (choix !== "personnalise" && !estPresetPeriode(choix)) return null;
    const debut = personnalisee?.debut;
    const fin = personnalisee?.fin;
    if (typeof debut !== "string" || typeof fin !== "string" || !estDateValide(debut) || !estDateValide(fin)) return null;
    return { choix, personnalisee: { debut, fin } };
  } catch {
    return null;
  }
}

const NOMS_MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export function nomMoisExercice(mois: number): string {
  return NOMS_MOIS[mois - 1] ?? "";
}

/** "Votre exercice va du 1er octobre au 30 septembre." */
export function descriptionExercice(config: ConfigExercice): string {
  // Année de référence choisie pour que l'exercice ne contienne aucun 29 février : la fin d'un
  // exercice débutant le 1er mars s'énonce "28 février".
  const exercice = tranche({ annee: 2022, config }, 0, 12);
  const libelle = (dateISO: string) => {
    const date = parseDateISO(dateISO);
    const jour = date.getDate();
    return `${jour === 1 ? "1er" : jour} ${NOMS_MOIS[date.getMonth()]}`;
  };
  return `Votre exercice va du ${libelle(exercice.debut)} au ${libelle(exercice.fin)}.`;
}
