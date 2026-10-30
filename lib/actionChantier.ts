import { parseDateISO, toISODate } from "./dates";
import { formatKiloEuros, MENTION_HT_ESTIME, MENTION_TTC } from "./format";
import {
  ConfigExercice,
  getCurrentFiscalQuarterRange,
  getCurrentFiscalSemesterRange,
  getFiscalYearRange,
} from "./fiscalPeriods";
import { AjustementGestion, ajustementsDeLaPeriode, finDeMois, moisDe } from "./pastAdjustments";
import { calculerPnlComptable, PnlComptable, SoldeCompte, soldesDeLaPeriode, SourceStock } from "./comptaPnl";
import { LigneComptable, RegleCorrespondance } from "./comptaCorrespondance";
import type { AjustementComptable } from "./comptaStocks";
import { MappingCategorie } from "./pastCategoryMapping";
import { BaseMontants, calculerPnlEnBase, IndicateurEconomique, PnlEnBase } from "./pastHtEstime";
import { libelleMois, moisDeLaPeriode } from "./pastDetail";
import { PastTransactionStockee, Periode } from "./pastTransactions";

/**
 * Module "Action" : LE chantier de rentabilité prioritaire. Passé → Action → Futur. Fonctions
 * pures ; la persistance est dans lib/actionRepository.ts.
 *
 * Un chantier = une priorité, une période (mois, trimestre, semestre ou année de l'exercice),
 * exactement 3 indicateurs dont au plus 1 personnalisé (saisie manuelle). Chaque indicateur a une
 * référence historique figée au lancement et une cible FIXE — aucune trajectoire mensuelle, aucun
 * score global : les trois indicateurs restent indépendants.
 *
 * Les indicateurs automatiques ne recalculent rien eux-mêmes : ils lisent le P&L du module Passé
 * (calculerPnlEnBase, mêmes transactions, même correspondance P&L, mêmes ajustements de gestion),
 * sur la période du chantier. Un chiffre d'Action est donc celui que l'onglet Général affiche pour
 * les mêmes dates. Le BFR lit les situations VALIDÉES du module Passé, jamais un recalcul.
 *
 * Mois clos / mois en cours : Novanta n'a pas de clôture comptable. Comme le module Passé
 * (moisTerminesDeLaPeriode), un mois est clos quand son dernier jour est passé ; le mois qui
 * contient aujourd'hui est en cours, donc provisoire ; un mois à venir n'a jamais de valeur.
 */

export type TypePeriode = "month" | "quarter" | "semester" | "year";
export type Sens = "up" | "down";
export type FamilleKpi = "performance" | "comptable" | "bfr" | "custom";
// D'où vient un indicateur. Une référence et un réalisé ont toujours la même source : un montant HT
// estimé ne se compare jamais à une valeur comptable.
export type SourceKpi = "cash_estime" | "comptable" | "tresorerie" | "bfr" | "manuel";
// cumulatif : un montant qui s'additionne depuis le début du chantier ;
// taux : un ratio recalculé sur les montants agrégés depuis le début du chantier, jamais une somme
//        de pourcentages ;
// situation : un point de situation mensuel (BFR), jamais cumulé ;
// manuel : la valeur saisie pour le mois (indicateur personnalisé).
export type NatureSerie = "cumulatif" | "taux" | "situation" | "manuel";
export type Unite = "eur" | "pct";

export const TYPES_PERIODE: { cle: TypePeriode; libelle: string; mois: number }[] = [
  { cle: "month", libelle: "Mois", mois: 1 },
  { cle: "quarter", libelle: "Trimestre", mois: 3 },
  { cle: "semester", libelle: "Semestre", mois: 6 },
  { cle: "year", libelle: "Année", mois: 12 },
];

export function nombreMoisDuType(type: TypePeriode): number {
  return TYPES_PERIODE.find((t) => t.cle === type)!.mois;
}

export function estTypePeriode(valeur: unknown): valeur is TypePeriode {
  return TYPES_PERIODE.some((t) => t.cle === valeur);
}

export const CLE_PERSONNALISE = "custom";

export type CleKpiAuto =
  | "encaissements"
  | "marge_brute"
  | "taux_marge_brute"
  | "marge_contributive"
  | "taux_marge_contributive"
  | "ebitda"
  | "taux_ebitda"
  | "cash_flow_operationnel"
  | "bfr"
  | "compta_chiffre_affaires"
  | "compta_marge_brute"
  | "compta_taux_marge_brute"
  | "compta_marge_contributive"
  | "compta_ebitda"
  | "compta_resultat_exploitation"
  | "compta_resultat_net"
  | "compta_marge_nette";

export interface DefinitionKpi {
  cle: CleKpiAuto;
  libelle: string;
  famille: Exclude<FamilleKpi, "custom">;
  nature: Exclude<NatureSerie, "manuel">;
  sens: Sens;
  unite: Unite;
  // Lecture des montants : HT estimé (lecture par défaut du module Passé, celle des objectifs) ou
  // TTC (le cash flow est toujours lu en TTC dans Novanta). Sans objet pour le BFR (HT, factures).
  base: BaseMontants;
  source: SourceKpi;
  description: string;
}

// Seuls les indicateurs que Novanta calcule déjà. Aucun n'est ajouté ici sans source réelle.
export const CATALOGUE_KPI: Record<CleKpiAuto, DefinitionKpi> = {
  encaissements: {
    cle: "encaissements",
    libelle: "Encaissements",
    famille: "performance",
    nature: "cumulatif",
    sens: "up",
    unite: "eur",
    base: "ht",
    source: "cash_estime",
    description: "Encaissements clients cumulés sur la période.",
  },
  marge_brute: {
    cle: "marge_brute",
    libelle: "Marge brute",
    famille: "performance",
    nature: "cumulatif",
    sens: "up",
    unite: "eur",
    base: "ht",
    source: "cash_estime",
    description: "Encaissements moins coûts directs, cumulés sur la période.",
  },
  taux_marge_brute: {
    cle: "taux_marge_brute",
    libelle: "Taux de marge brute",
    famille: "performance",
    nature: "taux",
    sens: "up",
    unite: "pct",
    base: "ht",
    source: "cash_estime",
    description: "Marge brute rapportée aux encaissements, depuis le début de la période.",
  },
  marge_contributive: {
    cle: "marge_contributive",
    libelle: "Marge contributive",
    famille: "performance",
    nature: "cumulatif",
    sens: "up",
    unite: "eur",
    base: "ht",
    source: "cash_estime",
    description: "Marge brute moins autres coûts variables, cumulée sur la période.",
  },
  taux_marge_contributive: {
    cle: "taux_marge_contributive",
    libelle: "Taux de marge contributive",
    famille: "performance",
    nature: "taux",
    sens: "up",
    unite: "pct",
    base: "ht",
    source: "cash_estime",
    description: "Marge contributive rapportée aux encaissements, depuis le début de la période.",
  },
  ebitda: {
    cle: "ebitda",
    libelle: "EBITDA",
    famille: "performance",
    nature: "cumulatif",
    sens: "up",
    unite: "eur",
    base: "ht",
    source: "cash_estime",
    description: "Marge contributive moins coûts de structure, cumulée sur la période.",
  },
  taux_ebitda: {
    cle: "taux_ebitda",
    libelle: "Taux d'EBITDA",
    famille: "performance",
    nature: "taux",
    sens: "up",
    unite: "pct",
    base: "ht",
    source: "cash_estime",
    description: "EBITDA rapporté aux encaissements, depuis le début de la période.",
  },
  cash_flow_operationnel: {
    cle: "cash_flow_operationnel",
    libelle: "Cash flow opérationnel",
    famille: "performance",
    nature: "cumulatif",
    sens: "up",
    unite: "eur",
    base: "ttc",
    source: "tresorerie",
    description: "Trésorerie générée par l'activité (hors financement), cumulée sur la période.",
  },
  bfr: {
    cle: "bfr",
    libelle: "BFR",
    famille: "bfr",
    nature: "situation",
    sens: "down",
    unite: "eur",
    base: "ht",
    source: "bfr",
    description: "Situation BFR validée en fin de mois (créances + stocks − dettes fournisseurs, HT).",
  },
  compta_chiffre_affaires: {
    cle: "compta_chiffre_affaires",
    libelle: "Chiffre d'affaires comptable",
    famille: "comptable",
    nature: "cumulatif",
    sens: "up",
    unite: "eur",
    base: "ht",
    source: "comptable",
    description: "Chiffre d'affaires reconnu en comptabilité, cumulé sur la période.",
  },
  compta_marge_brute: {
    cle: "compta_marge_brute",
    libelle: "Marge brute comptable",
    famille: "comptable",
    nature: "cumulatif",
    sens: "up",
    unite: "eur",
    base: "ht",
    source: "comptable",
    description: "Marge brute du P&L comptable, cumulée sur la période.",
  },
  compta_taux_marge_brute: {
    cle: "compta_taux_marge_brute",
    libelle: "Taux de marge brute comptable",
    famille: "comptable",
    nature: "taux",
    sens: "up",
    unite: "pct",
    base: "ht",
    source: "comptable",
    description: "Marge brute comptable rapportée au chiffre d'affaires, depuis le début de la période.",
  },
  compta_marge_contributive: {
    cle: "compta_marge_contributive",
    libelle: "Marge contributive comptable",
    famille: "comptable",
    nature: "cumulatif",
    sens: "up",
    unite: "eur",
    base: "ht",
    source: "comptable",
    description: "Marge contributive du P&L comptable, cumulée sur la période.",
  },
  compta_ebitda: {
    cle: "compta_ebitda",
    libelle: "EBITDA comptable",
    famille: "comptable",
    nature: "cumulatif",
    sens: "up",
    unite: "eur",
    base: "ht",
    source: "comptable",
    description: "EBITDA du P&L comptable, cumulé sur la période.",
  },
  compta_resultat_exploitation: {
    cle: "compta_resultat_exploitation",
    libelle: "Résultat d'exploitation",
    famille: "comptable",
    nature: "cumulatif",
    sens: "up",
    unite: "eur",
    base: "ht",
    source: "comptable",
    description: "Résultat d'exploitation du P&L comptable, cumulé sur la période.",
  },
  compta_resultat_net: {
    cle: "compta_resultat_net",
    libelle: "Résultat net",
    famille: "comptable",
    nature: "cumulatif",
    sens: "up",
    unite: "eur",
    base: "ht",
    source: "comptable",
    description: "Résultat net du P&L comptable, cumulé sur la période.",
  },
  compta_marge_nette: {
    cle: "compta_marge_nette",
    libelle: "Marge nette",
    famille: "comptable",
    nature: "taux",
    sens: "up",
    unite: "pct",
    base: "ht",
    source: "comptable",
    description: "Résultat net rapporté au chiffre d'affaires comptable, depuis le début de la période.",
  },
};

export const CLES_KPI_AUTO = Object.keys(CATALOGUE_KPI) as CleKpiAuto[];

/** Indicateurs proposés à la création : les comptables seulement si le P&L comptable est accessible. */
export function clesKpiProposees(comptableDisponible: boolean): CleKpiAuto[] {
  return CLES_KPI_AUTO.filter((cle) => comptableDisponible || CATALOGUE_KPI[cle].source !== "comptable");
}

export function estKpiComptable(cle: KpiChantier["cle"]): boolean {
  return cle !== CLE_PERSONNALISE && CATALOGUE_KPI[cle].source === "comptable";
}

/**
 * Source d'un indicateur enregistré : celle persistée, sinon celle de sa clé au catalogue. Une ligne
 * antérieure à la colonne kpi_source garde ainsi sa définition d'origine, sans conversion.
 */
export function sourceDuKpi(kpi: Pick<KpiChantier, "cle" | "source">): SourceKpi {
  if (kpi.source) return kpi.source;
  return kpi.cle === CLE_PERSONNALISE ? "manuel" : CATALOGUE_KPI[kpi.cle].source;
}

export const VERSION_DEFINITION_KPI = 1;

/** Définition figée au lancement du chantier, dans action_initiative_kpis.kpi_definition. */
export function definitionPersistee(cle: KpiChantier["cle"]): Record<string, unknown> | null {
  if (cle === CLE_PERSONNALISE) return null;
  const { libelle, nature, unite, base, source, sens } = CATALOGUE_KPI[cle];
  // Un montant comptable n'est ni un HT estimé ni un TTC : la définition enregistrée le dit.
  return { version: VERSION_DEFINITION_KPI, libelle, nature, unite, base: source === "comptable" ? "comptable" : base, source, sens };
}

export function estCleKpiAuto(valeur: unknown): valeur is CleKpiAuto {
  return typeof valeur === "string" && valeur in CATALOGUE_KPI;
}

/** Indicateurs prévus mais que Novanta ne sait pas encore calculer : affichés, jamais simulés. */
/** Résultat net et marge nette existent dès lors que le P&L comptable est accessible. */
export function kpiNonDisponibles(comptableDisponible: boolean): typeof KPI_NON_DISPONIBLES {
  return KPI_NON_DISPONIBLES.filter((k) => !comptableDisponible || (k.libelle !== "Résultat net" && k.libelle !== "Marge nette"));
}

export const KPI_NON_DISPONIBLES: { libelle: string; famille: Exclude<FamilleKpi, "custom">; raison: string }[] = [
  { libelle: "Résultat net", famille: "performance", raison: "Le P&L de Novanta s'arrête à l'EBITDA : ni amortissements, ni impôts." },
  { libelle: "Marge nette", famille: "performance", raison: "Nécessite le résultat net, pas encore calculé." },
  { libelle: "DSO", famille: "bfr", raison: "Délai clients pas encore calculé par l'onglet BFR." },
  { libelle: "DPO", famille: "bfr", raison: "Délai fournisseurs pas encore calculé par l'onglet BFR." },
];

export const LIBELLES_FAMILLE: Record<FamilleKpi, string> = {
  performance: "Performance financière",
  comptable: "P&L comptable",
  bfr: "BFR et délais de paiement",
  custom: "Personnalisé",
};

// --- Modèle ----------------------------------------------------------------------------------

export type OrigineReference = "equivalent" | "previous" | "indicative" | "situation" | "manual" | "none";

export interface Reference {
  valeur: number | null;
  libelle: string | null;
  origine: OrigineReference;
  periode: Periode | null;
}

export const SANS_REFERENCE: Reference = { valeur: null, libelle: null, origine: "none", periode: null };

export interface KpiChantier {
  id: string;
  position: 1 | 2 | 3;
  cle: CleKpiAuto | typeof CLE_PERSONNALISE;
  // Personnalisé seulement.
  nomPersonnalise: string | null;
  unitePersonnalisee: string | null;
  sens: Sens;
  reference: Reference;
  // Unité d'affichage : € pour un montant, points de % pour un taux (48 = 48 %), unité libre
  // pour le personnalisé.
  cible: number;
  // Source persistée au lancement ; null ou absente pour un chantier antérieur (voir sourceDuKpi).
  source?: SourceKpi | null;
}

export interface Chantier {
  id: string;
  titre: string;
  changement: string;
  typePeriode: TypePeriode;
  periode: Periode;
  statut: "active" | "completed";
  kpis: KpiChantier[];
}

export interface ValeurManuelle {
  kpiId: string;
  mois: string; // YYYY-MM
  valeur: number;
}

// --- Règles de composition -------------------------------------------------------------------

export const NOMBRE_KPI = 3;
export const MAX_KPI_MANUELS = 1;

export interface ChoixKpi {
  cle: CleKpiAuto | typeof CLE_PERSONNALISE;
}

/** Erreur de composition des indicateurs, ou null si la sélection est valide. */
export function erreurCompositionKpis(choix: ChoixKpi[]): string | null {
  const manuels = choix.filter((c) => c.cle === CLE_PERSONNALISE).length;
  if (manuels > MAX_KPI_MANUELS) return "Un seul indicateur personnalisé (saisie manuelle) par chantier.";
  if (new Set(choix.map((c) => c.cle)).size !== choix.length) return "Chaque indicateur ne peut être choisi qu'une fois.";
  if (choix.some((c) => c.cle !== CLE_PERSONNALISE && !estCleKpiAuto(c.cle))) return "Indicateur inconnu.";
  if (choix.length !== NOMBRE_KPI) return `Choisissez exactement ${NOMBRE_KPI} indicateurs (${choix.length} sélectionné${choix.length > 1 ? "s" : ""}).`;
  return null;
}

/** Peut-on encore cocher cet indicateur ? (Jamais plus de 3, jamais un 2e personnalisé.) */
export function peutAjouterKpi(choix: ChoixKpi[], cle: ChoixKpi["cle"]): boolean {
  if (choix.some((c) => c.cle === cle)) return false;
  if (choix.length >= NOMBRE_KPI) return false;
  if (cle === CLE_PERSONNALISE && choix.some((c) => c.cle === CLE_PERSONNALISE)) return false;
  return true;
}

/** Un seul chantier actif : refuse d'en lancer un second tant que le premier n'est pas clôturé. */
export function erreurChantierActif(chantierActif: Pick<Chantier, "statut"> | null): string | null {
  return chantierActif?.statut === "active" ? "Un chantier est déjà en cours : clôturez-le avant d'en lancer un autre." : null;
}

/**
 * Erreur de cible, ou null. La cible est une valeur finale fixe ; elle doit aller dans le sens
 * d'amélioration depuis la référence (ou l'égaler : objectif de maintien). Un objectif cumulé
 * est un montant à atteindre sur la période : il doit être strictement positif.
 */
export function erreurCible(cible: number | null, sens: Sens, reference: number | null, nature: NatureSerie): string | null {
  if (cible === null || !Number.isFinite(cible)) return "Saisissez l'objectif à atteindre.";
  if (nature === "cumulatif" && cible <= 0) return "Un objectif cumulé est un montant à atteindre sur la période : il doit être positif.";
  if (nature === "taux" && (cible < -100 || cible > 100)) return "Un taux s'exprime entre -100 % et 100 %.";
  if (reference !== null && nature !== "cumulatif") {
    if (sens === "up" && cible < reference) return "Plus haut = mieux : l'objectif ne peut pas être inférieur à la référence.";
    if (sens === "down" && cible > reference) return "Plus bas = mieux : l'objectif ne peut pas être supérieur à la référence.";
  }
  return null;
}

// --- Pourcentage d'atteinte ------------------------------------------------------------------

export type Atteinte =
  | { etat: "sans_valeur" }
  | { etat: "sans_reference" }
  // Cible égale au point de départ : il n'y a pas de chemin à parcourir, seulement un niveau à tenir.
  | { etat: "maintien"; atteint: boolean }
  | {
      etat: "calcule";
      // Fraction du chemin parcouru (0,67 = 67 %). Peut dépasser 1 (objectif dépassé) ou être
      // négative (recul par rapport au point de départ) : jamais plafonnée ici.
      fraction: number;
      // Remplissage de la jauge : la fraction bornée entre 0 et 1.
      jauge: number;
      recul: boolean;
      depasse: boolean;
    };

/**
 * Chemin parcouru entre le point de départ et la cible :
 *   plus haut = mieux : (réalisé − départ) / (cible − départ)
 *   plus bas = mieux  : (départ − réalisé) / (départ − cible)
 * Les deux formules sont la même une fois le sens appliqué. Valeurs négatives comprises : seul
 * l'écart compte, jamais le signe des valeurs elles-mêmes.
 */
export function calculerAtteinte(depart: number | null, cible: number, realise: number | null, sens: Sens): Atteinte {
  if (realise === null || !Number.isFinite(realise)) return { etat: "sans_valeur" };
  if (depart === null || !Number.isFinite(depart)) return { etat: "sans_reference" };
  const signe = sens === "up" ? 1 : -1;
  const chemin = (cible - depart) * signe;
  const parcouru = (realise - depart) * signe;
  if (chemin === 0) return { etat: "maintien", atteint: parcouru >= 0 };
  // Cible du mauvais côté du départ (refusée à la saisie, mais possible si les données ont
  // changé) : le chemin n'a pas de sens, on ne l'invente pas.
  if (chemin < 0) return { etat: "sans_reference" };
  const fraction = parcouru / chemin;
  return { etat: "calcule", fraction, jauge: Math.min(1, Math.max(0, fraction)), recul: fraction < 0, depasse: fraction > 1 };
}

/**
 * Point de départ du chemin d'un indicateur. Pour un cumul, c'est zéro : le cumul repart de zéro à
 * chaque période, et la référence (le total d'une période passée) n'est pas un point de départ
 * mais un repère de comparaison. Pour les autres natures, c'est la référence.
 */
export function departDuChemin(nature: NatureSerie, reference: number | null): number | null {
  return nature === "cumulatif" ? 0 : reference;
}

// --- Périodes --------------------------------------------------------------------------------

function estDernierJourDuMois(date: Date): boolean {
  const lendemain = new Date(date);
  lendemain.setDate(date.getDate() + 1);
  return lendemain.getDate() === 1;
}

/** Décale une date de `mois` mois ; un dernier jour de mois reste un dernier jour de mois. */
export function decalerMois(dateISO: string, mois: number): string {
  const date = parseDateISO(dateISO);
  const finDeMoisSource = estDernierJourDuMois(date);
  const cible = new Date(date.getFullYear(), date.getMonth() + mois, 1);
  const dernierJour = new Date(cible.getFullYear(), cible.getMonth() + 1, 0).getDate();
  cible.setDate(finDeMoisSource ? dernierJour : Math.min(date.getDate(), dernierJour));
  return toISODate(cible);
}

function lendemain(dateISO: string): string {
  const date = parseDateISO(dateISO);
  date.setDate(date.getDate() + 1);
  return toISODate(date);
}

function veille(dateISO: string): string {
  const date = parseDateISO(dateISO);
  date.setDate(date.getDate() - 1);
  return toISODate(date);
}

function premierDuMois(dateISO: string): string {
  return `${dateISO.slice(0, 7)}-01`;
}

/** Période du type demandé qui contient la date (mois civil, ou tranche de l'exercice). */
export function periodeContenant(type: TypePeriode, dateISO: string, config: ConfigExercice): Periode {
  switch (type) {
    case "month":
      return { debut: premierDuMois(dateISO), fin: finDeMois(moisDe(dateISO)) };
    case "quarter":
      return getCurrentFiscalQuarterRange(dateISO, config);
    case "semester":
      return getCurrentFiscalSemesterRange(dateISO, config);
    case "year":
      return getFiscalYearRange(dateISO, config);
  }
}

export interface PeriodeProposee {
  cle: "en_cours" | "suivante";
  periode: Periode;
  libelle: string;
}

/** Les deux périodes proposées à la création : celle en cours et la suivante. */
export function periodesProposees(type: TypePeriode, aujourdhui: string, config: ConfigExercice): PeriodeProposee[] {
  const enCours = periodeContenant(type, aujourdhui, config);
  const suivante = periodeContenant(type, lendemain(enCours.fin), config);
  return [
    { cle: "en_cours", periode: enCours, libelle: libellePeriode(type, enCours, config) },
    { cle: "suivante", periode: suivante, libelle: libellePeriode(type, suivante, config) },
  ];
}

const exerciceCivil = (config: ConfigExercice) => config.mois === 1 && config.jour === 1;

/**
 * Nom court d'une période : « Octobre 2026 », « T4 2026 », « S2 2026 », « Exercice 2026 » sur un
 * exercice civil ; sur un exercice décalé, le rang dans l'exercice (« T2 · exercice 2026-27 »).
 * Les dates exactes sont toujours affichées à côté.
 */
export function libellePeriode(type: TypePeriode, periode: Periode, config: ConfigExercice): string {
  if (type === "month") return libelleMois(moisDe(periode.debut));
  const exercice = getFiscalYearRange(periode.debut, config);
  const rang = Math.floor(moisEcartes(exercice.debut, periode.debut) / nombreMoisDuType(type)) + 1;
  const anneeDebut = exercice.debut.slice(0, 4);
  if (exerciceCivil(config)) {
    if (type === "year") return `Exercice ${anneeDebut}`;
    return `${type === "quarter" ? "T" : "S"}${rang} ${anneeDebut}`;
  }
  const nomExercice = `exercice ${anneeDebut}-${exercice.fin.slice(2, 4)}`;
  if (type === "year") return `${nomExercice.charAt(0).toUpperCase()}${nomExercice.slice(1)}`;
  return `${type === "quarter" ? "T" : "S"}${rang} · ${nomExercice}`;
}

function moisEcartes(a: string, b: string): number {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
}

function moisSuivant(mois: string): string {
  return moisDe(decalerMois(`${mois}-01`, 1));
}

const NOMS_MOIS_COURTS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/** « juin–sept. 2026 », « nov. 2025–févr. 2026 », « sept. 2026 ». */
export function libellePlageMois(premier: string, dernier: string): string {
  const court = (m: string) => NOMS_MOIS_COURTS[Number(m.slice(5, 7)) - 1];
  if (premier === dernier) return `${court(premier)} ${premier.slice(0, 4)}`;
  if (premier.slice(0, 4) === dernier.slice(0, 4)) return `${court(premier)}–${court(dernier)} ${dernier.slice(0, 4)}`;
  return `${court(premier)} ${premier.slice(0, 4)}–${court(dernier)} ${dernier.slice(0, 4)}`;
}

// --- Données du module Passé -----------------------------------------------------------------

/** Ce qu'Action lit du module Passé — les mêmes entrées que l'onglet Général. */
export interface DonneesPasse {
  transactions: PastTransactionStockee[];
  axeId: string | null;
  mappings: ReadonlyMap<string, MappingCategorie>;
  // Tous les ajustements de gestion (saisis + variations de stock), toutes dates.
  ajustements: AjustementGestion[];
  // Date de la toute première transaction de l'organisation (null : aucune).
  premiereOperation: string | null;
  // Situations BFR validées : fin de mois -> BFR HT.
  situationsBfr: { date: string; bfr: number }[];
  // P&L comptable : absent ou null sans accès, ou sans écriture. Jamais déduit des transactions.
  comptable?: DonneesComptables | null;
}

export interface DonneesComptables {
  soldes: SoldeCompte[];
  regles: RegleCorrespondance[];
  variationsStock: AjustementGestion[];
  // Décision par mois, prise sur l'exercice entier par le serveur (lib/comptaServeur.ts).
  arbitrageStock: Record<string, SourceStock | "aucune">;
  conflitStock: boolean;
  ajustements: AjustementComptable[];
  lignesEcarteesParMois: Record<string, string[]>;
  premiereEcriture: string | null;
}

function transactionsDe(transactions: PastTransactionStockee[], periode: Periode): PastTransactionStockee[] {
  return transactions.filter((t) => t.transactionDate >= periode.debut && t.transactionDate <= periode.fin);
}

function pnlSur(donnees: DonneesPasse, periode: Periode, base: BaseMontants): PnlEnBase {
  return calculerPnlEnBase(
    transactionsDe(donnees.transactions, periode),
    donnees.axeId,
    donnees.mappings,
    ajustementsDeLaPeriode(donnees.ajustements, periode),
    base
  );
}

const INDICATEUR_DU_KPI: Partial<Record<CleKpiAuto, IndicateurEconomique>> = {
  encaissements: "ca",
  marge_brute: "margeBrute",
  taux_marge_brute: "margeBrute",
  marge_contributive: "margeContributive",
  taux_marge_contributive: "margeContributive",
  ebitda: "ebitda",
  taux_ebitda: "ebitda",
};

export interface Mesure {
  valeur: number | null;
  // Raison d'une valeur absente, compréhensible par l'utilisateur.
  raison: string | null;
  // Avertissements sur une valeur présente mais incomplète (TVA, catégories non rattachées).
  avertissements: string[];
}

/**
 * Valeur d'un indicateur P&L sur une période, lue dans le P&L du module Passé. Un taux est le
 * ratio du P&L (montants agrégés), exprimé en points de % ; jamais une somme de taux.
 */
export function mesurerSurPeriode(cle: Exclude<CleKpiAuto, "bfr">, donnees: DonneesPasse, periode: Periode): Mesure {
  const definition = CATALOGUE_KPI[cle];
  if (definition.source === "comptable") return mesurerComptable(cle, donnees, periode);
  const pnl = pnlSur(donnees, periode, definition.base);
  const avertissements: string[] = [];
  const indicateur = INDICATEUR_DU_KPI[cle];
  if (indicateur && pnl.couvertures && !pnl.couvertures[indicateur].complete) {
    avertissements.push("TVA non renseignée sur une partie des catégories : montant HT estimé partiel.");
  }
  if (pnl.nonMappees.nombreCategories > 0) {
    const n = pnl.nonMappees.nombreCategories;
    avertissements.push(`${n} catégorie${n > 1 ? "s" : ""} sans correspondance P&L, exclue${n > 1 ? "s" : ""} du calcul.`);
  }
  const ratio = (r: number | null): Mesure =>
    r === null
      ? { valeur: null, raison: "Encaissements nuls : taux non calculable.", avertissements }
      : { valeur: r * 100, raison: null, avertissements };
  switch (cle) {
    case "encaissements":
      return { valeur: pnl.ca, raison: null, avertissements };
    case "marge_brute":
      return { valeur: pnl.margeBrute, raison: null, avertissements };
    case "marge_contributive":
      return { valeur: pnl.margeContributive, raison: null, avertissements };
    case "ebitda":
      return { valeur: pnl.ebitda, raison: null, avertissements };
    case "cash_flow_operationnel":
      return { valeur: pnl.cashFlowOperationnel, raison: null, avertissements };
    case "taux_marge_brute":
      return ratio(pnl.ratios.margeBrute);
    case "taux_marge_contributive":
      return ratio(pnl.ratios.margeContributive);
    case "taux_ebitda":
      return ratio(pnl.ratios.ebitda);
    default:
      return { valeur: null, raison: "Indicateur non calculable depuis le module Passé.", avertissements };
  }
}

const VALEUR_COMPTABLE: Partial<Record<CleKpiAuto, (pnl: PnlComptable) => number | null>> = {
  compta_chiffre_affaires: (pnl) => pnl.chiffreAffaires,
  compta_marge_brute: (pnl) => pnl.margeBrute,
  compta_taux_marge_brute: (pnl) => (pnl.ratios.margeBrute === null ? null : pnl.ratios.margeBrute * 100),
  compta_marge_contributive: (pnl) => pnl.margeContributive,
  compta_ebitda: (pnl) => pnl.ebitda,
  compta_resultat_exploitation: (pnl) => pnl.resultatExploitation,
  compta_resultat_net: (pnl) => pnl.resultatNet,
  compta_marge_nette: (pnl) => (pnl.ratios.resultatNet === null ? null : pnl.ratios.resultatNet * 100),
};

/** Valeur lue dans le P&L comptable, sans jamais retomber sur les transactions bancaires. */
function mesurerComptable(cle: CleKpiAuto, donnees: DonneesPasse, periode: Periode): Mesure {
  const comptable = donnees.comptable;
  if (!comptable) return { valeur: null, raison: "Aucune écriture comptable disponible.", avertissements: [] };
  const pnl = calculerPnlComptable({
    soldes: soldesDeLaPeriode(comptable.soldes, periode),
    regles: comptable.regles,
    variationsStockNovanta: ajustementsDeLaPeriode(comptable.variationsStock, periode),
    arbitrageStockParMois: new Map(Object.entries(comptable.arbitrageStock)),
    conflitStock: comptable.conflitStock,
    ajustements: comptable.ajustements.filter((a) => a.date >= periode.debut && a.date <= periode.fin),
    lignesEcarteesParMois: new Map(Object.entries(comptable.lignesEcarteesParMois).map(([m, l]) => [m, new Set(l as LigneComptable[])])),
  });
  if (!pnl.aDesEcritures) return { valeur: null, raison: "Aucune écriture comptable sur cette période.", avertissements: [] };
  const avertissements: string[] = [];
  const n = pnl.nonAffectes.comptes.length;
  if (n > 0) avertissements.push(`${n} compte${n > 1 ? "s" : ""} sans correspondance comptable, exclu${n > 1 ? "s" : ""} du calcul.`);
  if (pnl.stock.conflit) avertissements.push("Variation de stocks : deux sources à arbitrer dans le P&L comptable.");
  const valeur = VALEUR_COMPTABLE[cle]!(pnl);
  return valeur === null
    ? { valeur: null, raison: "Chiffre d'affaires nul : taux non calculable.", avertissements }
    : { valeur, raison: null, avertissements };
}

/** Début de l'historique de la source de l'indicateur : transactions, ou écritures comptables. */
function premiereDonnee(donnees: DonneesPasse, cle: KpiChantier["cle"]): string | null {
  return estKpiComptable(cle) ? (donnees.comptable?.premiereEcriture ?? null) : donnees.premiereOperation;
}

/** Mois couverts par l'historique : à partir du mois de la première donnée connue de cette source. */
function historiqueCouvre(donnees: DonneesPasse, periode: Periode, cle: KpiChantier["cle"]): boolean {
  const premiere = premiereDonnee(donnees, cle);
  return premiere !== null && moisDe(premiere) <= moisDe(periode.debut);
}

/** Mois entièrement écoulés (dernier jour passé), couverts par l'historique, avant `avant`. */
function moisCompletsDisponiblesAvant(donnees: DonneesPasse, avant: string, aujourdhui: string, cle: KpiChantier["cle"]): string[] {
  const premiere = premiereDonnee(donnees, cle);
  if (premiere === null) return [];
  const mois: string[] = [];
  for (let m = moisDe(premiere); m < moisDe(avant); m = moisSuivant(m)) {
    if (finDeMois(m) < aujourdhui) mois.push(m);
  }
  return mois;
}

export interface ReferenceProposee extends Reference {
  avertissements: string[];
  // Pourquoi aucune référence n'a pu être proposée.
  raison: string | null;
}

/**
 * Référence historique d'un indicateur automatique, dans cet ordre :
 *  1. la période équivalente passée (mêmes dates, un an plus tôt), si elle est écoulée et couverte ;
 *  2. sinon la dernière période complète comparable (la période de même durée juste avant) ;
 *  3. sinon une référence INDICATIVE sur les mois complets disponibles, dite comme telle : un
 *     taux y est recalculé sur ces mois ; un cumul y est ramené à la durée du chantier par la
 *     moyenne mensuelle, et le libellé le dit (« moyenne de 4 mois ramenée à 12 mois ») ;
 *  4. sinon aucune référence — jamais un zéro.
 * Pour le BFR : la situation validée de la fin du mois précédant le chantier, sinon la dernière
 * situation validée antérieure, datée.
 */
export function proposerReference(
  cle: CleKpiAuto,
  type: TypePeriode,
  periode: Periode,
  libelleDuType: (p: Periode) => string,
  donnees: DonneesPasse,
  aujourdhui: string
): ReferenceProposee {
  if (cle === "bfr") return referenceBfr(periode, donnees);

  const n = nombreMoisDuType(type);
  const candidates: { origine: "equivalent" | "previous"; periode: Periode; libelle: (p: Periode) => string }[] = [
    {
      origine: "equivalent",
      periode: { debut: decalerMois(periode.debut, -12), fin: decalerMois(periode.fin, -12) },
      libelle: libelleDuType,
    },
    {
      origine: "previous",
      // Même durée, finissant la veille du début du chantier.
      periode: { debut: decalerMois(periode.debut, -n), fin: veille(periode.debut) },
      libelle: (p) => `${LIBELLE_PERIODE_PRECEDENTE[type]} (${libelleDuType(p)})`,
    },
  ];

  let raisonEchec: string | null = null;
  for (const candidate of candidates) {
    if (candidate.periode.fin >= aujourdhui) continue;
    if (!historiqueCouvre(donnees, candidate.periode, cle)) continue;
    const mesure = mesurerSurPeriode(cle, donnees, candidate.periode);
    if (mesure.valeur === null) {
      raisonEchec = mesure.raison;
      continue;
    }
    return {
      valeur: arrondirReference(mesure.valeur),
      libelle: candidate.libelle(candidate.periode),
      origine: candidate.origine,
      periode: candidate.periode,
      avertissements: mesure.avertissements,
      raison: null,
    };
  }

  const disponibles = moisCompletsDisponiblesAvant(donnees, periode.debut, aujourdhui, cle).slice(-n);
  if (disponibles.length > 0) {
    const plage: Periode = { debut: `${disponibles[0]}-01`, fin: finDeMois(disponibles[disponibles.length - 1]) };
    const mesure = mesurerSurPeriode(cle, donnees, plage);
    const k = disponibles.length;
    const nomPlage = libellePlageMois(disponibles[0], disponibles[k - 1]);
    if (mesure.valeur !== null) {
      const cumulRamene = CATALOGUE_KPI[cle].nature === "cumulatif" && k !== n;
      return {
        valeur: arrondirReference(cumulRamene ? (mesure.valeur / k) * n : mesure.valeur),
        libelle: cumulRamene
          ? `Indicative : moyenne de ${k} mois (${nomPlage}) ramenée à ${n} mois`
          : `Indicative : sur ${k === 1 ? "le seul mois disponible" : `les ${k} mois disponibles`} (${nomPlage})`,
        origine: "indicative",
        periode: plage,
        avertissements: mesure.avertissements,
        raison: null,
      };
    }
    raisonEchec = mesure.raison;
  }

  return {
    ...SANS_REFERENCE,
    avertissements: [],
    raison: raisonEchec ?? "Historique insuffisant : aucun mois complet avant le début du chantier.",
  };
}

// Référence figée en base : arrondie au centime / au dix-millième de point, sans bruit flottant.
function arrondirReference(valeur: number): number {
  return Math.round(valeur * 10_000) / 10_000;
}

const LIBELLE_PERIODE_PRECEDENTE: Record<TypePeriode, string> = {
  month: "Mois précédent",
  quarter: "Trimestre précédent",
  semester: "Semestre précédent",
  year: "Année précédente",
};

function referenceBfr(periode: Periode, donnees: DonneesPasse): ReferenceProposee {
  const finMoisPrecedent = finDeMois(moisDe(decalerMois(premierDuMois(periode.debut), -1)));
  const anterieures = donnees.situationsBfr.filter((s) => s.date <= finMoisPrecedent).sort((a, b) => (a.date < b.date ? -1 : 1));
  const retenue = anterieures[anterieures.length - 1];
  if (!retenue) {
    return { ...SANS_REFERENCE, avertissements: [], raison: "Aucune situation BFR validée avant le début du chantier." };
  }
  return {
    valeur: retenue.bfr,
    libelle: `Situation validée au ${formatJourLong(retenue.date)}`,
    origine: "situation",
    periode: { debut: retenue.date, fin: retenue.date },
    avertissements: retenue.date === finMoisPrecedent ? [] : ["Dernière situation validée : pas celle du mois précédant le chantier."],
    raison: null,
  };
}

const formatJour = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const formatJourSansAnnee = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });

export function formatJourLong(dateISO: string): string {
  return formatJour.format(parseDateISO(dateISO));
}

export function formatJourCourt(dateISO: string): string {
  return formatJourSansAnnee.format(parseDateISO(dateISO));
}

// --- Séries mensuelles -----------------------------------------------------------------------

export type StatutMois = "clos" | "en_cours" | "a_venir";

/** Statut d'un mois d'une période : clos quand son dernier jour (dans la période) est passé. */
export function statutDuMois(mois: string, periode: Periode, aujourdhui: string): StatutMois {
  const debut = `${mois}-01` < periode.debut ? periode.debut : `${mois}-01`;
  const fin = finDeMois(mois) > periode.fin ? periode.fin : finDeMois(mois);
  if (fin < aujourdhui) return "clos";
  if (debut <= aujourdhui) return "en_cours";
  return "a_venir";
}

export interface PointSerie {
  mois: string;
  statut: StatutMois;
  // null : pas de valeur (mois à venir, donnée absente) — jamais 0 par défaut.
  valeur: number | null;
  raison: string | null;
  avertissements: string[];
}

export interface ValeurActuelle {
  valeur: number;
  mois: string;
  source: "clos" | "en_cours" | "manuel";
  // Date de la dernière opération bancaire prise en compte (mois en cours d'un indicateur P&L).
  derniereOperation: string | null;
}

export type EtatDonnees = "ok" | "partiel" | "insuffisant" | "a_venir";

export interface SuiviKpi {
  kpi: KpiChantier;
  libelle: string;
  nature: NatureSerie;
  unite: Unite | "libre";
  points: PointSerie[];
  actuelle: ValeurActuelle | null;
  atteinte: Atteinte;
  etat: EtatDonnees;
  messages: string[];
}

export function natureDuKpi(kpi: Pick<KpiChantier, "cle">): NatureSerie {
  return kpi.cle === CLE_PERSONNALISE ? "manuel" : CATALOGUE_KPI[kpi.cle].nature;
}

export function libelleDuKpi(kpi: Pick<KpiChantier, "cle" | "nomPersonnalise">): string {
  return kpi.cle === CLE_PERSONNALISE ? (kpi.nomPersonnalise ?? "Indicateur personnalisé") : CATALOGUE_KPI[kpi.cle].libelle;
}

/**
 * Suivi mensuel d'un indicateur sur la période du chantier. Un point par mois de la période :
 *  - cumulatif / taux : la valeur DEPUIS LE DÉBUT du chantier jusqu'à la fin du mois (jusqu'à
 *    aujourd'hui pour le mois en cours), lue dans le P&L du module Passé sur ces dates ;
 *  - situation : la situation BFR validée à la fin du mois, sinon rien (jamais estimée) ;
 *  - manuel : la valeur saisie pour le mois, sinon rien.
 * Les mois à venir n'ont jamais de valeur. La valeur actuelle est le dernier point renseigné.
 */
export function suivreKpi(
  kpi: KpiChantier,
  chantier: Pick<Chantier, "periode">,
  donnees: DonneesPasse,
  valeursManuelles: ValeurManuelle[],
  aujourdhui: string
): SuiviKpi {
  const { periode } = chantier;
  const nature = natureDuKpi(kpi);
  const tousLesMois = moisDeLaPeriode(periode);
  const premiere = premiereDonnee(donnees, kpi.cle);
  const premierMoisCouvert = premiere ? moisDe(premiere) : null;
  // Source enregistrée différente de celle de la clé : aucune valeur plutôt qu'une comparaison entre
  // deux natures de chiffres (référence HT estimée face à un réalisé comptable, par exemple).
  const sourceIncompatible = kpi.cle !== CLE_PERSONNALISE && Boolean(kpi.source) && kpi.source !== CATALOGUE_KPI[kpi.cle].source;

  const points: PointSerie[] = tousLesMois.map((mois) => {
    const statut = statutDuMois(mois, periode, aujourdhui);
    const vide = (raison: string | null): PointSerie => ({ mois, statut, valeur: null, raison, avertissements: [] });
    if (statut === "a_venir") return vide(null);
    if (sourceIncompatible) return vide("Source de l'indicateur différente de sa définition : valeur non comparée.");

    if (nature === "manuel") {
      const saisie = valeursManuelles.find((v) => v.kpiId === kpi.id && v.mois === mois);
      return saisie ? { mois, statut, valeur: saisie.valeur, raison: null, avertissements: [] } : vide("Valeur non saisie.");
    }

    if (nature === "situation") {
      const situation = donnees.situationsBfr.find((s) => s.date === finDeMois(mois));
      if (situation) return { mois, statut, valeur: situation.bfr, raison: null, avertissements: [] };
      return vide(statut === "en_cours" ? "Situation de fin de mois pas encore validable." : "Situation BFR non validée pour ce mois.");
    }

    if (premierMoisCouvert === null || mois < premierMoisCouvert) return vide(estKpiComptable(kpi.cle) ? "Aucune écriture comptable pour ce mois." : "Aucune transaction synchronisée pour ce mois.");
    const finPoint = [finDeMois(mois), periode.fin, aujourdhui].sort()[0];
    const mesure = mesurerSurPeriode(kpi.cle as Exclude<CleKpiAuto, "bfr">, donnees, { debut: periode.debut, fin: finPoint });
    const avertissements = [...mesure.avertissements];
    if (premierMoisCouvert > moisDe(periode.debut)) avertissements.push("Historique incomplet en début de chantier.");
    return { mois, statut, valeur: mesure.valeur, raison: mesure.raison, avertissements };
  });

  const renseignes = points.filter((p) => p.valeur !== null);
  const dernier = renseignes[renseignes.length - 1] ?? null;
  const actuelle: ValeurActuelle | null = dernier
    ? {
        valeur: dernier.valeur as number,
        mois: dernier.mois,
        source: nature === "manuel" ? "manuel" : dernier.statut === "en_cours" ? "en_cours" : "clos",
        derniereOperation: (nature === "cumulatif" || nature === "taux") && !estKpiComptable(kpi.cle) ? derniereOperationDuMois(donnees, dernier.mois, periode) : null,
      }
    : null;

  const messages: string[] = [];
  let etat: EtatDonnees = "ok";
  if (points.every((p) => p.statut === "a_venir")) {
    etat = "a_venir";
    messages.push(`Le chantier démarre le ${formatJourLong(periode.debut)}.`);
  } else if (actuelle === null) {
    etat = "insuffisant";
    const raison = points.find((p) => p.statut !== "a_venir" && p.raison)?.raison;
    messages.push(
      nature === "manuel"
        ? "Aucune valeur saisie pour le moment."
        : nature === "situation"
          ? "Aucune situation BFR validée sur la période : validez-la dans Passé › BFR."
          : !sourceIncompatible && estKpiComptable(kpi.cle) && premiere === null
            ? "Aucune écriture comptable disponible : synchronisez le P&L comptable dans Passé."
            : !sourceIncompatible && !estKpiComptable(kpi.cle) && donnees.premiereOperation === null
            ? "Aucune transaction synchronisée : connectez Pennylane ou importez un relevé dans Passé."
            : (raison ?? "Données insuffisantes.")
    );
  } else {
    // BFR : un mois clos sans situation validée n'a pas de barreau ; on le dit plutôt que de le taire.
    const nonValides = nature === "situation" ? points.filter((p) => p.statut === "clos" && p.valeur === null) : [];
    if (nonValides.length > 0) {
      messages.push(`Situation non validée : ${nonValides.map((p) => libelleMois(p.mois).toLocaleLowerCase("fr")).join(", ")} (Passé › BFR).`);
    }
    const avertissements = [...new Set(points.flatMap((p) => p.avertissements))];
    if (avertissements.length > 0) {
      etat = "partiel";
      messages.push(...avertissements);
    }
  }

  return {
    kpi,
    libelle: libelleDuKpi(kpi),
    nature,
    unite: kpi.cle === CLE_PERSONNALISE ? "libre" : CATALOGUE_KPI[kpi.cle].unite,
    points,
    actuelle,
    atteinte: calculerAtteinte(departDuChemin(nature, kpi.reference.valeur), kpi.cible, actuelle?.valeur ?? null, kpi.sens),
    etat,
    messages,
  };
}

function derniereOperationDuMois(donnees: DonneesPasse, mois: string, periode: Periode): string | null {
  let derniere: string | null = null;
  for (const t of donnees.transactions) {
    if (t.transactionDate.slice(0, 7) !== mois || t.transactionDate < periode.debut || t.transactionDate > periode.fin) continue;
    if (derniere === null || t.transactionDate > derniere) derniere = t.transactionDate;
  }
  return derniere;
}

/** Mois où l'indicateur personnalisé peut être saisi : ceux déjà commencés de la période. */
export function moisSaisissables(periode: Periode, aujourdhui: string): string[] {
  return moisDeLaPeriode(periode).filter((m) => statutDuMois(m, periode, aujourdhui) !== "a_venir");
}

// --- Présentation ----------------------------------------------------------------------------

const formatNombre = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
const formatPct = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const espacesInsecables = (texte: string) => texte.replace(/ (k€|%)/g, " $1");

/** Valeur dans l'unité de l'indicateur : « 125,4 k€ », « 42,0 % », « 48 jours ». */
export function formatValeurKpi(valeur: number, unite: Unite | "libre", uniteLibre: string | null = null): string {
  if (unite === "eur") return espacesInsecables(formatKiloEuros(valeur, Math.abs(valeur) < 10_000 ? 1 : 0));
  if (unite === "pct") return espacesInsecables(`${formatPct.format(valeur)} %`);
  return `${formatNombre.format(valeur)}${uniteLibre ? ` ${uniteLibre}` : ""}`;
}

/** Écart signé : « +12,0 pts », « −12 jours », « +25,3 k€ ». */
export function formatEcartKpi(ecart: number, unite: Unite | "libre", uniteLibre: string | null = null): string {
  const signe = ecart > 0 ? "+" : ecart < 0 ? "−" : "";
  const absolu = Math.abs(ecart);
  if (unite === "pct") return `${signe}${formatPct.format(absolu)} pts`;
  return `${signe}${formatValeurKpi(absolu, unite, uniteLibre)}`;
}

/** Fraction en pourcentage entier signé : « 67 % », « −20 % ». */
export function formatFraction(fraction: number): string {
  const pct = Math.round(fraction * 100);
  return `${pct < 0 ? "−" : ""}${Math.abs(pct)}\u00a0%`;
}

/**
 * Libellé de l'atteinte, toujours fondé sur la progression métier (chemin référence → cible, sens
 * compris), jamais sur réalisé − cible :
 *  - sous la cible : « 75 % de l'objectif atteint » — arrondi par défaut, pour ne jamais lire
 *    « 100 % » tant que la cible n'est pas atteinte ;
 *  - cible atteinte (dépassement arrondi nul) : « Objectif atteint » ;
 *  - au-delà : « Objectif dépassé de 23 % » — même formulation pour « plus haut = mieux » et
 *    « plus bas = mieux », où dépasser l'objectif veut dire descendre sous la cible ;
 *  - recul : « −20 % : recul par rapport au point de départ ».
 */
export function libelleAtteinte(atteinte: Atteinte, etat: EtatDonnees): { texte: string; recul: boolean } {
  switch (atteinte.etat) {
    case "calcule": {
      const { fraction } = atteinte;
      if (fraction < 0) return { texte: `${formatFraction(fraction)} : recul par rapport au point de départ`, recul: true };
      if (fraction < 1) return { texte: `${Math.floor(fraction * 100 + 1e-9)}\u00a0% de l'objectif atteint`, recul: false };
      const depassement = Math.round((fraction - 1) * 100);
      return { texte: depassement === 0 ? "Objectif atteint" : `Objectif dépassé de ${depassement}\u00a0%`, recul: false };
    }
    case "maintien":
      return { texte: atteinte.atteint ? "Objectif de maintien : tenu" : "Objectif de maintien : pas tenu", recul: !atteinte.atteint };
    case "sans_reference":
      return { texte: "Atteinte non calculable : aucune référence", recul: false };
    case "sans_valeur":
      return { texte: etat === "a_venir" ? "Le suivi commence avec le chantier" : "Atteinte non calculable : aucune valeur", recul: false };
  }
}

// --- Libellés de la référence -----------------------------------------------------------------

export interface LibellesReference {
  // Ce que l'écart nomme : « +42,2 pts vs T2 2026 ». null : aucune référence.
  court: string | null;
  // La ligne détaillée : « Référence : 20,7 % — T2 2026 · même période un an plus tôt ».
  detail: string | null;
}

/**
 * Libellés d'une référence, construits à partir de ce qui est stocké (origine, période, type de
 * période du chantier) plutôt qu'à partir d'un texte figé : la période exacte est toujours nommée
 * quand elle est connue. Le libellé stocké ne sert que de repli (référence sans période connue).
 */
export function libellesReference(reference: Reference, typePeriode: TypePeriode, config: ConfigExercice): LibellesReference {
  if (reference.valeur === null || reference.origine === "none") return { court: null, detail: null };
  const p = reference.periode;
  const repli = { court: reference.libelle, detail: reference.libelle };
  switch (reference.origine) {
    case "equivalent": {
      if (!p) return repli;
      const nom = libellePeriode(typePeriode, p, config);
      return { court: nom, detail: `${nom} · même période un an plus tôt` };
    }
    case "previous": {
      if (!p) return repli;
      const nom = libellePeriode(typePeriode, p, config);
      return { court: nom, detail: `${nom} · ${LIBELLE_PERIODE_PRECEDENTE[typePeriode].toLocaleLowerCase("fr")}` };
    }
    case "indicative": {
      if (!p) return repli;
      const premier = moisDe(p.debut);
      const dernier = moisDe(p.fin);
      const k = moisEcartes(premier, dernier) + 1;
      const plage = libellePlageMois(premier, dernier);
      return {
        court: k === 1 ? `le seul mois disponible (${plage})` : `la moyenne des ${k} mois disponibles (${plage})`,
        detail: reference.libelle,
      };
    }
    case "situation":
      return p ? { court: `la situation au ${formatJourLong(p.fin)}`, detail: reference.libelle } : repli;
    case "manual":
      return { court: "la valeur de départ", detail: "valeur de départ saisie au lancement" };
  }
}

/** « +42,2 pts vs T2 2026 », « −12 jours vs la valeur de départ », « Stable vs T2 2026 ». */
export function libelleEcartReference(ecart: number, unite: Unite | "libre", uniteLibre: string | null, reference: LibellesReference): string | null {
  if (reference.court === null) return null;
  if (ecart === 0) return `Stable vs ${reference.court}`;
  return `${formatEcartKpi(ecart, unite, uniteLibre)} vs ${reference.court}`;
}

/** Lecture des montants d'un indicateur, affichée sur sa carte. */
export function mentionDuKpi(cle: KpiChantier["cle"]): string {
  if (cle === CLE_PERSONNALISE) return "Saisie manuelle";
  if (cle === "bfr") return "HT · situations validées";
  if (estKpiComptable(cle)) return "Comptable";
  return CATALOGUE_KPI[cle].base === "ttc" ? MENTION_TTC : MENTION_HT_ESTIME;
}

// --- Carte et photographie de clôture ---------------------------------------------------------

/** Ce qu'une carte KPI affiche : le suivi et ses libellés. Même forme vivante ou figée. */
export interface CarteKpi {
  suivi: SuiviKpi;
  mention: string;
  reference: LibellesReference;
}

export function carteDuSuivi(suivi: SuiviKpi, typePeriode: TypePeriode, config: ConfigExercice): CarteKpi {
  return { suivi, mention: mentionDuKpi(suivi.kpi.cle), reference: libellesReference(suivi.kpi.reference, typePeriode, config) };
}

export const VERSION_PHOTOGRAPHIE = 1;

/**
 * Photographie d'un chantier à sa clôture : tout ce que la fiche historique affiche, tel que le
 * dirigeant le voyait pour piloter — valeurs, séries mensuelles (statut clos / en cours compris),
 * atteinte, libellés. Jamais recalculée ensuite : ni une écriture modifiée, ni un mapping changé,
 * ni une évolution du calcul ne la touchent.
 */
export interface PhotographieChantier {
  version: typeof VERSION_PHOTOGRAPHIE;
  clotureLe: string; // horodatage ISO de la clôture
  arreteAu: string; // date (YYYY-MM-DD) à laquelle les données étaient arrêtées
  titre: string;
  changement: string;
  typePeriode: TypePeriode;
  periode: Periode;
  libellePeriode: string;
  cartes: CarteKpi[];
}

export function photographierChantier(
  chantier: Pick<Chantier, "titre" | "changement" | "typePeriode" | "periode">,
  cartes: CarteKpi[],
  config: ConfigExercice,
  aujourdhui: string,
  clotureLe: string
): PhotographieChantier {
  // Copie profonde : la photographie ne partage rien avec l'état vivant de la page.
  const copie = JSON.parse(JSON.stringify(cartes)) as CarteKpi[];
  return {
    version: VERSION_PHOTOGRAPHIE,
    clotureLe,
    arreteAu: aujourdhui,
    titre: chantier.titre,
    changement: chantier.changement,
    typePeriode: chantier.typePeriode,
    periode: { ...chantier.periode },
    libellePeriode: libellePeriode(chantier.typePeriode, chantier.periode, config),
    cartes: copie,
  };
}

/** Photographie relue de la base ; null si absente ou illisible (jamais reconstituée). */
export function lirePhotographie(brut: unknown): PhotographieChantier | null {
  if (typeof brut !== "object" || brut === null) return null;
  const p = brut as Partial<PhotographieChantier>;
  if (p.version !== VERSION_PHOTOGRAPHIE || !Array.isArray(p.cartes) || p.cartes.length !== NOMBRE_KPI) return null;
  if (typeof p.titre !== "string" || typeof p.clotureLe !== "string" || !p.periode || !estTypePeriode(p.typePeriode)) return null;
  const valides = p.cartes.every((c) => c && c.suivi && Array.isArray(c.suivi.points) && c.suivi.kpi && typeof c.mention === "string" && c.reference);
  return valides ? (p as PhotographieChantier) : null;
}

/** Jours écoulés de la période (bornés à sa durée), pour l'en-tête du chantier. */
export function joursEcoules(periode: Periode, aujourdhui: string): { ecoules: number; total: number } {
  const jour = 86_400_000;
  const debut = parseDateISO(periode.debut).getTime();
  const fin = parseDateISO(periode.fin).getTime();
  const total = Math.round((fin - debut) / jour) + 1;
  const ecoules = Math.min(total, Math.max(0, Math.round((parseDateISO(aujourdhui).getTime() - debut) / jour) + 1));
  return { ecoules, total };
}
