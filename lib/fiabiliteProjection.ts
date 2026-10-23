import { listerFluxProjetes, SourceFlux } from "./cash-engine";
import { ajouterJours, parseDateISO, toISODate } from "./dates";
import { ConfigExercice, getCurrentFiscalQuarterRange } from "./fiscalPeriods";
import {
  CLE_A_CLASSER,
  classerDepense,
  CorrespondanceFutur,
  EtageDepense,
  estEtageDepense,
  groupeDeEtage,
  GROUPES_ETAGE,
  GroupeEtage,
  LIBELLE_A_CLASSER,
} from "./futurPnl";
import { EtagePnl, MappingCategorie, ventilerTransaction } from "./pastCategoryMapping";
import { PastTransactionStockee } from "./pastTransactions";
import { Remplacements } from "./remplacementsOccurrences";
import { AutreDepense, ChargeFixe, FactureClient, FactureFournisseur, Financement, RentreeReguliere } from "./types";

/**
 * Fiabilité de la projection (module Futur, avec Passé) : la prévision enregistrée AVANT une période
 * comparée aux flux bancaires constatés PENDANT cette même période. Fonctions pures.
 *
 * - Prévision de référence : la projection Futur de la période telle qu'elle existait à la clôture
 *   de la veille de son début (minuit, heure de Paris), ligne par ligne — même moteur que la courbe
 *   (lib/cash-engine.ts::listerFluxProjetes). Un trimestre a sa propre référence, arrêtée avant son
 *   début : jamais la somme de trois prévisions mensuelles révisées.
 * - Réalisé : transactions bancaires TTC de Passé, sur les mêmes dates. Ni facture émise, ni stock,
 *   ni ajustement, ni objectif : seulement des flux bancaires.
 * - Groupes de dépenses : ceux de Futur (lib/futurPnl.ts), TVA sous Extra P&L, « Financement »,
 *   « À classer » pour toute sortie sans étage de dépense utilisable.
 */

export const FUSEAU_REFERENCE = "Europe/Paris";
// Version des règles de construction d'une référence : enregistrée avec chaque référence.
export const VERSION_MOTEUR_REFERENCE = 1;

export type TypePeriode = "month" | "quarter";

export interface PeriodeFiabilite {
  type: TypePeriode;
  debut: string; // YYYY-MM-DD
  fin: string; // YYYY-MM-DD, inclus
}

export type CleGroupe = GroupeEtage | typeof CLE_A_CLASSER;

/** Groupes de dépenses, dans l'ordre d'affichage : ceux de Futur, puis « À classer ». */
export const CLES_GROUPES: readonly CleGroupe[] = [...GROUPES_ETAGE.map((g) => g.cle), CLE_A_CLASSER];

export function libelleGroupe(cle: CleGroupe): string {
  return cle === CLE_A_CLASSER ? LIBELLE_A_CLASSER : GROUPES_ETAGE.find((g) => g.cle === cle)!.libelle;
}

const arrondi = (montant: number) => Math.round(montant * 100) / 100;

// --- Fuseau de référence -----------------------------------------------------------------------

/** Date civile (YYYY-MM-DD) d'un instant dans le fuseau de référence. */
export function dateDansFuseau(instant: Date, fuseau = FUSEAU_REFERENCE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: fuseau, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/** Décalage du fuseau à un instant donné, en millisecondes (heure locale − UTC). */
function decalageFuseau(instant: Date, fuseau: string): number {
  const parties = new Intl.DateTimeFormat("en-US", {
    timeZone: fuseau,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const v = (type: string) => Number(parties.find((p) => p.type === type)!.value);
  const local = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
  return local - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Instant de minuit (début de journée) d'une date civile dans le fuseau de référence. */
export function debutJourDansFuseau(dateISO: string, fuseau = FUSEAU_REFERENCE): Date {
  const [a, m, j] = dateISO.split("-").map(Number);
  const minuitUtc = Date.UTC(a, m - 1, j);
  // Deux passes : le décalage à retenir est celui de l'instant cherché (changement d'heure).
  let instant = minuitUtc - decalageFuseau(new Date(minuitUtc), fuseau);
  instant = minuitUtc - decalageFuseau(new Date(instant), fuseau);
  return new Date(instant);
}

/** Clôture d'une période : minuit (Paris) au jour de son début, soit la fin de la veille. */
export function instantCloture(periode: PeriodeFiabilite): Date {
  return debutJourDansFuseau(periode.debut);
}

/** Fin d'une période : minuit (Paris) au lendemain de son dernier jour. */
export function instantFinPeriode(periode: PeriodeFiabilite): Date {
  return debutJourDansFuseau(toISODate(ajouterJours(parseDateISO(periode.fin), 1)));
}

// --- Périodes --------------------------------------------------------------------------------------

/** Mois civil, ou trimestre de l'exercice (configuration fiscale de Passé), contenant la date. */
export function periodeContenant(type: TypePeriode, dateISO: string, exercice: ConfigExercice): PeriodeFiabilite {
  if (type === "quarter") return { type, ...getCurrentFiscalQuarterRange(dateISO, exercice) };
  const date = parseDateISO(dateISO);
  return {
    type,
    debut: toISODate(new Date(date.getFullYear(), date.getMonth(), 1)),
    fin: toISODate(new Date(date.getFullYear(), date.getMonth() + 1, 0)),
  };
}

export function periodePrecedente(periode: PeriodeFiabilite, exercice: ConfigExercice): PeriodeFiabilite {
  return periodeContenant(periode.type, toISODate(ajouterJours(parseDateISO(periode.debut), -1)), exercice);
}

/** Terminée : son dernier jour est passé (date de Paris). Un mois en cours n'est jamais évalué. */
export function estTerminee(periode: PeriodeFiabilite, aujourdhui: string): boolean {
  return periode.fin < aujourdhui;
}

/** Les `nombre` dernières périodes terminées, de la plus récente à la plus ancienne. */
export function periodesTerminees(type: TypePeriode, aujourdhui: string, exercice: ConfigExercice, nombre: number): PeriodeFiabilite[] {
  const resultat: PeriodeFiabilite[] = [];
  let periode = periodePrecedente(periodeContenant(type, aujourdhui, exercice), exercice);
  while (resultat.length < nombre) {
    resultat.push(periode);
    periode = periodePrecedente(periode, exercice);
  }
  return resultat;
}

export function nombreDeJoursPeriode(periode: PeriodeFiabilite): number {
  return Math.round((parseDateISO(periode.fin).getTime() - parseDateISO(periode.debut).getTime()) / 86_400_000) + 1;
}

// --- Capture : quand, et seulement si la projection est bien celle de la clôture ------------------

export type DecisionCapture =
  | { action: "rien"; motif: string }
  | { action: "capturer_provisoire" } // veille du début : capture avant la clôture
  | { action: "confirmer_provisoire" } // rien n'a changé entre la capture et la clôture
  | { action: "capturer_officielle" } // après la clôture, rien n'a changé depuis : l'état actuel est celui de la clôture
  | { action: "indisponible" }; // aucun état fiable de la clôture : pas de référence

/**
 * Décide de la capture d'une période à l'instant `maintenant`. `modifications` : instants des
 * changements de données de la société (future_change_events) postérieurs à `depuis` au moins.
 * Une capture n'est jamais datée d'avant son calcul : elle n'est retenue que si aucune modification
 * ne sépare l'instant du calcul de la clôture.
 */
export function deciderCapture(
  periode: PeriodeFiabilite,
  maintenant: Date,
  etat: { officielle: boolean; provisoire: { captureLe: Date } | null },
  modifications: readonly Date[]
): DecisionCapture {
  if (etat.officielle) return { action: "rien", motif: "référence officielle déjà enregistrée" };
  const cloture = instantCloture(periode);
  const modifieeEntre = (a: Date, b: Date) => modifications.some((m) => m > a && m <= b);
  if (maintenant < cloture) {
    const veille = toISODate(ajouterJours(parseDateISO(periode.debut), -1));
    if (dateDansFuseau(maintenant) !== veille) return { action: "rien", motif: "trop tôt" };
    // Une capture provisoire déjà faite et toujours valable : rien à refaire.
    if (etat.provisoire && !modifieeEntre(etat.provisoire.captureLe, maintenant)) return { action: "rien", motif: "provisoire à jour" };
    return { action: "capturer_provisoire" };
  }
  if (maintenant >= instantFinPeriode(periode)) return { action: "rien", motif: "période terminée" };
  if (etat.provisoire && !modifieeEntre(etat.provisoire.captureLe, cloture)) return { action: "confirmer_provisoire" };
  if (!modifieeEntre(cloture, maintenant)) return { action: "capturer_officielle" };
  return { action: "indisponible" };
}

// --- Prévision de référence ------------------------------------------------------------------------

export interface DonneesPrevision {
  facturesClients: FactureClient[];
  facturesFournisseurs: FactureFournisseur[];
  chargesFixes: ChargeFixe[];
  autresDepenses: AutreDepense[];
  financements: Financement[];
  rentreesRegulieres: RentreeReguliere[];
  remplacements?: Remplacements;
}

export interface LignePrevue {
  source: SourceFlux;
  sourceId: string;
  libelle: string;
  date: string;
  montant: number; // signé : + encaissement, − décaissement
  groupe: CleGroupe | null; // null pour un encaissement
  etage: EtageDepense | null; // étage d'origine (TVA comprise), tel qu'utilisé à la capture
  provenance: "manuel" | "correspondance" | "a_classer" | null;
}

export interface TotauxFlux {
  encaissements: number; // positif
  decaissements: number; // positif
  net: number;
  decaissementsParGroupe: Record<CleGroupe, number>; // positifs
}

export interface CouvertureReference {
  debut: string;
  fin: string;
  jours: number;
  // Occurrences sans montant calculable : non comptées, signalées (jamais assimilées à zéro).
  occurrencesIndisponibles: { source: SourceFlux; sourceId: string; date: string }[];
}

export interface ReferenceCalculee {
  lignes: LignePrevue[];
  totaux: TotauxFlux;
  couverture: CouvertureReference;
}

function totauxVides(): TotauxFlux {
  return {
    encaissements: 0,
    decaissements: 0,
    net: 0,
    decaissementsParGroupe: Object.fromEntries(CLES_GROUPES.map((c) => [c, 0])) as Record<CleGroupe, number>,
  };
}

function finaliserTotaux(t: TotauxFlux): TotauxFlux {
  const parGroupe = Object.fromEntries(CLES_GROUPES.map((c) => [c, arrondi(t.decaissementsParGroupe[c])])) as Record<CleGroupe, number>;
  const encaissements = arrondi(t.encaissements);
  const decaissements = arrondi(CLES_GROUPES.reduce((s, c) => s + parGroupe[c], 0));
  return { encaissements, decaissements, net: arrondi(encaissements - decaissements), decaissementsParGroupe: parGroupe };
}

/**
 * Prévision de référence d'une période : la projection Futur de TOUTE la période (horizon fixé à sa
 * durée, sans toucher à l'horizon choisi dans le cockpit), remplacements d'occurrences compris,
 * chaque sortie avec l'étage utilisé à cet instant.
 */
export function construireReference(donnees: DonneesPrevision, periode: PeriodeFiabilite, correspondance: CorrespondanceFutur): ReferenceCalculee {
  const indisponibles: CouvertureReference["occurrencesIndisponibles"] = [];
  const flux = listerFluxProjetes(
    { ...donnees, dateDepart: periode.debut, horizonJours: nombreDeJoursPeriode(periode) - 1 },
    (source, sourceId, date) => {
      if (date <= periode.fin) indisponibles.push({ source, sourceId, date });
    }
  );
  const classables = new Map<string, { etagePnlManuel?: EtageDepense | null; categoriesPennylane?: FactureFournisseur["categoriesPennylane"] }>();
  for (const f of donnees.facturesFournisseurs) classables.set(`facture_fournisseur:${f.id}`, f);
  for (const c of donnees.chargesFixes) classables.set(`charge_fixe:${c.id}`, c);
  for (const d of donnees.autresDepenses) classables.set(`autre_depense:${d.id}`, d);

  const totaux = totauxVides();
  const lignes: LignePrevue[] = flux.map((f) => {
    if (f.montant >= 0) {
      totaux.encaissements += f.montant;
      return { ...f, groupe: null, etage: null, provenance: null };
    }
    const ligne = classables.get(`${f.source}:${f.sourceId}`);
    const classement = ligne ? classerDepense(ligne, correspondance) : { etage: null, provenance: "a_classer" as const };
    const groupe: CleGroupe = classement.etage ? groupeDeEtage(classement.etage) : CLE_A_CLASSER;
    totaux.decaissementsParGroupe[groupe] += -f.montant;
    return { ...f, groupe, etage: classement.etage, provenance: classement.provenance };
  });
  return {
    lignes: lignes.sort((a, b) => a.date.localeCompare(b.date) || a.libelle.localeCompare(b.libelle, "fr")),
    totaux: finaliserTotaux(totaux),
    couverture: { debut: periode.debut, fin: periode.fin, jours: nombreDeJoursPeriode(periode), occurrencesIndisponibles: indisponibles },
  };
}

// --- Réalisé bancaire ---------------------------------------------------------------------------------

export interface LigneRealisee {
  transactionId: string;
  date: string;
  libelle: string;
  montant: number; // signé, part de la transaction revenant à ce groupe
  groupe: CleGroupe | null; // null pour un encaissement
}

export interface RealiseCalcule {
  lignes: LigneRealisee[];
  totaux: TotauxFlux;
  nombreTransactions: number;
}

/** Groupe de dépense d'un étage de Passé ; « Encaissements » n'en est pas un : « À classer ». */
function groupeDepuisEtagePasse(etage: EtagePnl | null | undefined): CleGroupe {
  return estEtageDepense(etage) ? groupeDeEtage(etage) : CLE_A_CLASSER;
}

/**
 * Réalisé d'une période : toutes les transactions bancaires datées dans la période, TTC.
 * Entrées = total des montants positifs ; sorties = total des montants négatifs, réparties par groupe
 * selon la ventilation analytique de Passé (axe de référence, pondérations) et sa correspondance
 * COURANTE ; toute part sans étage de dépense — ou non ventilée — va dans « À classer ». Aucune
 * exclusion HT, TVA ou financement : c'est de la trésorerie.
 */
export function construireRealise(
  transactions: readonly PastTransactionStockee[],
  periode: PeriodeFiabilite,
  mappings: ReadonlyMap<string, MappingCategorie>,
  axe: string | null
): RealiseCalcule {
  const totaux = totauxVides();
  const lignes: LigneRealisee[] = [];
  let nombre = 0;
  for (const t of transactions) {
    if (t.transactionDate < periode.debut || t.transactionDate > periode.fin) continue;
    nombre++;
    if (t.amount >= 0) {
      totaux.encaissements += t.amount;
      lignes.push({ transactionId: t.id, date: t.transactionDate, libelle: t.label, montant: t.amount, groupe: null });
      continue;
    }
    const parGroupe = new Map<CleGroupe, number>();
    let reparti = 0;
    for (const part of ventilerTransaction(t, axe)) {
      const groupe = groupeDepuisEtagePasse(mappings.get(part.sourceCategoryId)?.pnlStage);
      parGroupe.set(groupe, (parGroupe.get(groupe) ?? 0) + part.montant);
      reparti += part.montant;
    }
    const reliquat = t.amount - reparti;
    if (Math.abs(reliquat) > 0.004) parGroupe.set(CLE_A_CLASSER, (parGroupe.get(CLE_A_CLASSER) ?? 0) + reliquat);
    for (const [groupe, montant] of parGroupe) {
      totaux.decaissementsParGroupe[groupe] += -montant;
      lignes.push({ transactionId: t.id, date: t.transactionDate, libelle: t.label, montant, groupe });
    }
  }
  return { lignes: lignes.sort((a, b) => a.date.localeCompare(b.date)), totaux: finaliserTotaux(totaux), nombreTransactions: nombre };
}

// --- Complétude du réalisé ----------------------------------------------------------------------------

export interface SynchronisationPasse {
  debut: string;
  fin: string;
  synchroniseLe: string; // ISO
  complete: boolean;
}

export type StatutRealise =
  | { statut: "complet"; synchroniseLe: string }
  | { statut: "incomplet"; synchroniseLe: string | null; motif: string }
  | { statut: "non_verifiable"; synchroniseLe: null; motif: string };

/**
 * Le réalisé d'une période terminée est complet si une synchronisation Pennylane réussie, non
 * tronquée, couvrant toute la période, a eu lieu APRÈS sa fin. Données importées par fichier :
 * la couverture n'est pas vérifiable. Jamais de score final sur un réalisé incomplet.
 */
export function statutRealise(
  periode: PeriodeFiabilite,
  synchronisations: readonly SynchronisationPasse[],
  sourcesPresentes: ReadonlySet<string>
): StatutRealise {
  const finPeriode = instantFinPeriode(periode);
  const couvrantes = synchronisations
    .filter((s) => s.debut <= periode.debut && s.fin >= periode.fin && new Date(s.synchroniseLe) >= finPeriode)
    .sort((a, b) => b.synchroniseLe.localeCompare(a.synchroniseLe));
  const complete = couvrantes.find((s) => s.complete);
  if (complete) return { statut: "complet", synchroniseLe: complete.synchroniseLe };
  if (couvrantes.length > 0) {
    return { statut: "incomplet", synchroniseLe: couvrantes[0].synchroniseLe, motif: "Synchronisation tronquée : toutes les transactions n'ont pas pu être récupérées." };
  }
  if (sourcesPresentes.has("excel") && !sourcesPresentes.has("pennylane")) {
    return { statut: "non_verifiable", synchroniseLe: null, motif: "Transactions importées par fichier : la couverture de la période ne peut pas être vérifiée." };
  }
  const derniere = [...synchronisations].sort((a, b) => b.synchroniseLe.localeCompare(a.synchroniseLe))[0] ?? null;
  return {
    statut: "incomplet",
    synchroniseLe: derniere?.synchroniseLe ?? null,
    motif: "Aucune synchronisation des transactions couvrant toute la période après sa fin.",
  };
}

// --- Comparaison et précision -------------------------------------------------------------------------

export type Precision =
  | { statut: "score"; valeur: number } // 0 à 100
  | { statut: "flux_non_prevu" } // rien de prévu, des flux constatés
  | { statut: "aucun_flux" }; // rien de prévu, rien de constaté

/** 100 × max(0, 1 − |réalisé − prévu| / prévu), pour un prévu strictement positif. */
export function precision(prevu: number, realise: number): Precision {
  if (prevu > 0) return { statut: "score", valeur: 100 * Math.max(0, 1 - Math.abs(realise - prevu) / prevu) };
  return Math.abs(realise) > 0 ? { statut: "flux_non_prevu" } : { statut: "aucun_flux" };
}

export interface ComparaisonMontant {
  prevu: number;
  realise: number;
  ecart: number; // réalisé − prévu
}

export interface ContributionGroupe extends ComparaisonMontant {
  cle: CleGroupe;
  libelle: string;
}

export interface Comparaison {
  encaissements: ComparaisonMontant & { precision: Precision };
  decaissements: ComparaisonMontant & { precision: Precision };
  cashNet: ComparaisonMontant;
  groupes: ContributionGroupe[]; // ordre des groupes ; contribution = écart du groupe
  globale: Precision & { erreur: number; base: number };
}

const comparerMontants = (prevu: number, realise: number): ComparaisonMontant => ({ prevu, realise, ecart: arrondi(realise - prevu) });

/**
 * Prévu / réalisé d'une période. Précision globale : l'erreur additionne l'écart absolu des
 * encaissements et celui de CHAQUE groupe de dépenses — une hausse ici et une baisse là ne se
 * compensent pas —, rapportée aux flux prévus (encaissements + décaissements).
 */
export function comparer(prevu: TotauxFlux, realise: TotauxFlux): Comparaison {
  const groupes = CLES_GROUPES.map((cle) => ({
    cle,
    libelle: libelleGroupe(cle),
    ...comparerMontants(prevu.decaissementsParGroupe[cle], realise.decaissementsParGroupe[cle]),
  })).filter((g) => g.prevu !== 0 || g.realise !== 0);
  const erreur = arrondi(Math.abs(realise.encaissements - prevu.encaissements) + groupes.reduce((s, g) => s + Math.abs(g.ecart), 0));
  const base = arrondi(prevu.encaissements + prevu.decaissements);
  const constate = realise.encaissements + realise.decaissements;
  const globale: Precision =
    base > 0 ? { statut: "score", valeur: 100 * Math.max(0, 1 - erreur / base) } : constate > 0 ? { statut: "flux_non_prevu" } : { statut: "aucun_flux" };
  return {
    encaissements: { ...comparerMontants(prevu.encaissements, realise.encaissements), precision: precision(prevu.encaissements, realise.encaissements) },
    decaissements: { ...comparerMontants(prevu.decaissements, realise.decaissements), precision: precision(prevu.decaissements, realise.decaissements) },
    cashNet: comparerMontants(prevu.net, realise.net),
    groupes,
    globale: { ...globale, erreur, base },
  };
}

/** Lecture d'un écart : « 6 k€ de plus que prévu » / « 4 k€ de moins que prévu » / « Conforme ». */
export function phraseEcart(ecart: number, formater: (montant: number) => string): string {
  if (Math.abs(ecart) < 0.005) return "Conforme à la prévision";
  return `${formater(Math.abs(ecart))} de ${ecart > 0 ? "plus" : "moins"} que prévu`;
}

/** Empreinte du réalisé et de son classement : une révision n'est créée que si elle change. */
export function empreinteResultat(referenceId: string, realise: RealiseCalcule, statut: StatutRealise["statut"]): string {
  return JSON.stringify({
    referenceId,
    statut,
    totaux: realise.totaux,
    lignes: realise.lignes.map((l) => [l.transactionId, l.groupe, arrondi(l.montant)]),
  });
}

// --- Libellés de dates exactes --------------------------------------------------------------------

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

const partiesDate = (iso: string) => {
  const [a, m, j] = iso.split("-").map(Number);
  return { annee: a, mois: MOIS[m - 1], jour: j === 1 ? "1er" : String(j) };
};

/** « 1er septembre 2026 », « 31 août 2026 ». */
export function dateLongue(iso: string): string {
  const d = partiesDate(iso);
  return `${d.jour} ${d.mois} ${d.annee}`;
}

/** « du 1er au 30 septembre 2026 », « du 1er octobre au 31 décembre 2026 ». */
export function intervalleDates(debut: string, fin: string): string {
  const a = partiesDate(debut);
  const b = partiesDate(fin);
  if (a.annee !== b.annee) return `du ${dateLongue(debut)} au ${dateLongue(fin)}`;
  if (a.mois !== b.mois) return `du ${a.jour} ${a.mois} au ${dateLongue(fin)}`;
  return `du ${a.jour} au ${dateLongue(fin)}`;
}

/** « Septembre 2026 » ; « Trimestre du 1er octobre au 31 décembre 2026 ». */
export function libellePeriode(periode: PeriodeFiabilite): string {
  if (periode.type === "quarter") return `Trimestre ${intervalleDates(periode.debut, periode.fin)}`;
  const d = partiesDate(periode.debut);
  return `${d.mois.charAt(0).toUpperCase()}${d.mois.slice(1)} ${d.annee}`;
}

/** Date d'arrêté affichée : la veille du début de la période (la clôture est à minuit). */
export function dateArrete(periode: PeriodeFiabilite): string {
  return dateLongue(toISODate(ajouterJours(parseDateISO(periode.debut), -1)));
}
