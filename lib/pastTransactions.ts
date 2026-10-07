import { estDateValide, parseDateISO, toISODate } from "./dates";

/**
 * Modèle interne des transactions du module "Passé" (table past_transactions) et règles
 * d'affichage associées. Purement fonctionnel : aucune dépendance à la source d'origine — le
 * tableau, les filtres et le compteur ne savent jamais si une transaction vient de Pennylane ou
 * d'un fichier Excel (voir lib/pastTransactionAdapters.ts pour la normalisation par source).
 */

export type PastSourceType = "pennylane" | "excel";

/**
 * Affectation analytique d'une transaction : une catégorie, dans un axe (groupe de catégories),
 * avec sa pondération. Une transaction peut en porter plusieurs — ventilation sur plusieurs
 * catégories d'un même axe, ou une catégorie par axe. Toutes sont conservées.
 */
export interface AffectationAnalytique {
  groupId: string;
  categoryId: string | null;
  categoryName: string;
  weight: number;
}

/** Axe analytique connu de l'organisation (groupe de catégories). name null = libellé inconnu. */
export interface AxeAnalytique {
  groupId: string;
  name: string | null;
}

// Axe porté par la colonne "catégorie analytique" d'un import Excel, qui n'a pas de notion de groupe.
export const GROUPE_EXCEL = "excel";
// Catégorie source sans groupe identifiable : rangée dans un axe à part plutôt que rattachée
// arbitrairement à un autre.
export const GROUPE_INCONNU = "inconnu";

/** Transaction telle que stockée : faits bruts + toutes ses affectations analytiques. */
export interface PastTransactionStockee {
  id: string;
  sourceType: PastSourceType;
  transactionDate: string; // YYYY-MM-DD
  label: string;
  amount: number;
  currency: string | null;
  affectations: AffectationAnalytique[];
}

/**
 * Transaction prête pour l'affichage : la catégorie analytique est DÉRIVÉE des affectations pour
 * l'axe retenu (voir appliquerAxe), jamais stockée telle quelle.
 */
export interface PastTransaction {
  id: string;
  sourceType: PastSourceType;
  transactionDate: string; // YYYY-MM-DD
  label: string;
  amount: number; // signé : négatif = sortie, positif = entrée
  currency: string | null;
  analyticCategoryId: string | null;
  analyticCategoryName: string | null;
}

/**
 * Transaction normalisée prête à être écrite dans past_transactions : la forme commune que
 * TOUTE source doit produire. Identité source : sourceTransactionId pour Pennylane,
 * (importBatchId, sourceRowIndex) pour une ligne de fichier Excel.
 */
export interface PastTransactionNormalisee {
  sourceType: PastSourceType;
  sourceTransactionId: string | null;
  importBatchId: string | null;
  sourceRowIndex: number | null;
  transactionDate: string;
  label: string;
  amount: number;
  currency: string | null;
  affectations: AffectationAnalytique[];
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
}

export interface Periode {
  debut: string; // YYYY-MM-DD, inclus
  fin: string; // YYYY-MM-DD, inclus
}

/** Nom de catégorie exploitable, ou null. Appliqué par toutes les sources avant écriture. */
export function normaliserNomCategorie(valeur: unknown): string | null {
  if (typeof valeur !== "string") return null;
  const nettoye = valeur.replace(/\s+/g, " ").trim();
  return nettoye ? nettoye : null;
}

/**
 * SEULE définition de "non catégorisé" dans l'application : aucune catégorie analytique
 * exploitable (nom absent ou vide). Utilisée par le compteur, le filtre et l'affichage du tableau.
 */
export function estNonCategorisee(transaction: Pick<PastTransaction, "analyticCategoryName">): boolean {
  return normaliserNomCategorie(transaction.analyticCategoryName) === null;
}

/**
 * Catégorie principale d'une transaction DANS un axe donné : l'affectation de plus fort poids de
 * cet axe (à poids égal, la première par nom, pour un résultat stable). null si la transaction
 * n'a aucune affectation dans cet axe. Ne choisit jamais entre deux axes.
 */
export function categoriePrincipale(
  affectations: AffectationAnalytique[],
  axeId: string | null
): AffectationAnalytique | null {
  if (axeId === null) return null;
  const candidates = affectations.filter((a) => a.groupId === axeId && normaliserNomCategorie(a.categoryName) !== null);
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (a, b) => b.weight - a.weight || a.categoryName.localeCompare(b.categoryName, "fr")
  )[0];
}

/** Dérive les transactions d'affichage pour l'axe retenu (null = aucun axe : pas de catégorie). */
export function appliquerAxe(transactions: PastTransactionStockee[], axeId: string | null): PastTransaction[] {
  return transactions.map(({ affectations, ...faits }) => {
    const principale = categoriePrincipale(affectations, axeId);
    return {
      ...faits,
      analyticCategoryId: principale?.categoryId ?? null,
      analyticCategoryName: principale ? normaliserNomCategorie(principale.categoryName) : null,
    };
  });
}

export type EtatAxeAnalytique =
  // Axe choisi explicitement par l'organisation.
  | "configure"
  // Un seul axe existe : utilisé d'office, sans ambiguïté possible.
  | "automatique"
  // Plusieurs axes et aucun choix : le module n'en choisit pas un à la place de l'organisation.
  | "a_configurer"
  // Aucun axe connu (aucune transaction catégorisée).
  | "aucun";

export interface AxeResolu {
  etat: EtatAxeAnalytique;
  axeId: string | null;
}

/**
 * Détermine l'axe analytique utilisé par le module Passé. Règle métier explicite : un axe
 * configuré fait foi ; sinon un axe unique est utilisé d'office ; sinon rien n'est choisi.
 */
export function resoudreAxeAnalytique(axes: AxeAnalytique[], axeConfigure: string | null): AxeResolu {
  if (axeConfigure && axes.some((a) => a.groupId === axeConfigure)) {
    return { etat: "configure", axeId: axeConfigure };
  }
  if (axes.length === 0) return { etat: "aucun", axeId: null };
  if (axes.length === 1) return { etat: "automatique", axeId: axes[0].groupId };
  return { etat: "a_configurer", axeId: null };
}

export const LIBELLE_NON_CATEGORISE = "Non catégorisé";

// Clé du filtre pour "Non catégorisé" : ne peut pas entrer en collision avec un vrai nom de
// catégorie (les noms sont normalisés, jamais préfixés d'un caractère nul).
export const CLE_NON_CATEGORISE = "\u0000non-categorise";

/** Clé de filtre d'une transaction : son nom de catégorie normalisé, ou CLE_NON_CATEGORISE. */
export function cleCategorie(transaction: Pick<PastTransaction, "analyticCategoryName">): string {
  return normaliserNomCategorie(transaction.analyticCategoryName) ?? CLE_NON_CATEGORISE;
}

/** Année civile contenant la date donnée : 1er janvier → 31 décembre. */
export function periodeAnneeCivile(dateISO: string): Periode {
  const annee = parseDateISO(dateISO).getFullYear();
  return { debut: `${annee}-01-01`, fin: `${annee}-12-31` };
}

export function periodeValide(periode: Periode): boolean {
  return estDateValide(periode.debut) && estDateValide(periode.fin) && periode.debut <= periode.fin;
}

/**
 * Découpe une période en tranches d'un mois civil au plus (bornes incluses, sans trou ni
 * recouvrement). Sert à synchroniser une longue période source par tranches bornées.
 */
export function decouperPeriodeParMois(periode: Periode): Periode[] {
  if (!periodeValide(periode)) return [];
  const tranches: Periode[] = [];
  let debut = periode.debut;
  while (debut <= periode.fin) {
    const d = parseDateISO(debut);
    const finDeMois = toISODate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    const fin = finDeMois < periode.fin ? finDeMois : periode.fin;
    tranches.push({ debut, fin });
    debut = toISODate(new Date(d.getFullYear(), d.getMonth() + 1, 1));
  }
  return tranches;
}

/** Noms de catégories présents dans les transactions, triés par ordre alphabétique (fr). */
export function categoriesDisponibles(transactions: PastTransaction[]): string[] {
  const noms = new Set<string>();
  for (const t of transactions) {
    const nom = normaliserNomCategorie(t.analyticCategoryName);
    if (nom) noms.add(nom);
  }
  return [...noms].sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));
}

/**
 * Filtre multi-catégories : sélection vide = toutes les catégories ; sinon les transactions
 * appartenant à L'UNE des clés sélectionnées (voir cleCategorie / CLE_NON_CATEGORISE).
 */
export function filtrerParCategories(transactions: PastTransaction[], selection: ReadonlySet<string>): PastTransaction[] {
  if (selection.size === 0) return transactions;
  return transactions.filter((t) => selection.has(cleCategorie(t)));
}

/** Nombre de transactions non catégorisées — à appeler sur la période, jamais sur le résultat filtré. */
export function compterNonCategorisees(transactions: PastTransaction[]): number {
  return transactions.filter(estNonCategorisee).length;
}

/** Copie triée par date décroissante ; à date égale, ordre stable par identifiant. */
export function trierParDateDecroissante<T extends { id: string; transactionDate: string }>(transactions: T[]): T[] {
  return [...transactions].sort((a, b) => {
    if (a.transactionDate !== b.transactionDate) return a.transactionDate < b.transactionDate ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Libellé d'un axe analytique pour l'interface. Quand la source n'a pas fourni de nom, quelques
 * catégories de l'axe sont citées en exemple pour que l'utilisateur puisse le reconnaître.
 */
export function libelleAxe(axe: AxeAnalytique, transactions: PastTransactionStockee[]): string {
  if (axe.name) return axe.name;
  if (axe.groupId === GROUPE_EXCEL) return "Catégories de l'import Excel";
  const exemples = new Set<string>();
  for (const t of transactions) {
    for (const a of t.affectations) {
      if (a.groupId === axe.groupId) exemples.add(a.categoryName);
    }
    if (exemples.size >= 3) break;
  }
  const base = axe.groupId === GROUPE_INCONNU ? "Axe sans identifiant" : `Axe ${axe.groupId}`;
  return exemples.size > 0 ? `${base} (ex. ${[...exemples].slice(0, 3).join(", ")})` : base;
}
