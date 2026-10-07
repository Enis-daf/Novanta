import type { SupabaseClient } from "@supabase/supabase-js";
import { CategorieSource, EtagePnl, estEtagePnl, MappingCategorie } from "./pastCategoryMapping";
import {
  AffectationAnalytique,
  AxeAnalytique,
  PastSourceType,
  PastTransactionNormalisee,
  PastTransactionStockee,
  Periode,
} from "./pastTransactions";

/**
 * Accès Supabase à past_transactions. Toutes les requêtes sont bornées par organization_id, en
 * plus de la RLS (lecture limitée à sa société, module 'past' activé).
 */

type Row = Record<string, unknown>;

// Les affectations analytiques sont lues avec leur transaction (relation past_transaction_categories).
const COLONNES_LECTURE =
  "id, source_type, transaction_date, label, amount, currency, past_transaction_categories(analytic_group_id, analytic_category_id, analytic_category_name, weight)";

// Plafond de lignes par requête de l'API Supabase (PostgREST) : on pagine en dessous.
const TAILLE_PAGE_LECTURE = 1000;
// Lot d'écriture volontairement petit : les identifiants du lot sont repassés en filtre d'URL pour
// remplacer leurs affectations.
const TAILLE_LOT_ECRITURE = 100;

function rowToAffectation(row: Row): AffectationAnalytique {
  return {
    groupId: row.analytic_group_id as string,
    categoryId: (row.analytic_category_id as string | null) ?? null,
    categoryName: (row.analytic_category_name as string | null) ?? "",
    weight: Number(row.weight),
  };
}

function rowToPastTransaction(row: Row): PastTransactionStockee {
  return {
    id: row.id as string,
    sourceType: row.source_type as PastSourceType,
    transactionDate: row.transaction_date as string,
    label: (row.label as string | null) ?? "",
    amount: Number(row.amount),
    currency: (row.currency as string | null) ?? null,
    affectations: ((row.past_transaction_categories as Row[] | null) ?? []).map(rowToAffectation),
  };
}

/** Toutes les transactions d'une organisation sur une période (bornes incluses), date décroissante. */
export async function chargerPastTransactions(
  supabase: SupabaseClient,
  organizationId: string,
  periode: Periode
): Promise<PastTransactionStockee[]> {
  const toutes: PastTransactionStockee[] = [];
  for (let debut = 0; ; debut += TAILLE_PAGE_LECTURE) {
    const { data, error } = await supabase
      .from("past_transactions")
      .select(COLONNES_LECTURE)
      .eq("organization_id", organizationId)
      .gte("transaction_date", periode.debut)
      .lte("transaction_date", periode.fin)
      .order("transaction_date", { ascending: false })
      .order("id", { ascending: true })
      .range(debut, debut + TAILLE_PAGE_LECTURE - 1);
    if (error) throw error;
    const lignes = (data ?? []) as Row[];
    toutes.push(...lignes.map(rowToPastTransaction));
    if (lignes.length < TAILLE_PAGE_LECTURE) break;
  }
  return toutes;
}

/** Axes analytiques connus de l'organisation, triés par libellé. */
export async function chargerAxesAnalytiques(supabase: SupabaseClient, organizationId: string): Promise<AxeAnalytique[]> {
  const { data, error } = await supabase
    .from("past_analytic_groups")
    .select("group_id, name")
    .eq("organization_id", organizationId);
  if (error) throw error;
  return ((data ?? []) as Row[])
    .map((row) => ({ groupId: row.group_id as string, name: (row.name as string | null) ?? null }))
    .sort((a, b) => (a.name ?? a.groupId).localeCompare(b.name ?? b.groupId, "fr"));
}

/** Axe analytique configuré pour le module Passé (null = non configuré). */
export async function chargerAxeConfigure(supabase: SupabaseClient, organizationId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("past_settings")
    .select("reporting_analytic_group_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return ((data as Row | null)?.reporting_analytic_group_id as string | null) ?? null;
}

export async function sauvegarderAxeConfigure(
  supabase: SupabaseClient,
  organizationId: string,
  groupId: string | null
): Promise<void> {
  const { error } = await supabase
    .from("past_settings")
    .upsert(
      { organization_id: organizationId, reporting_analytic_group_id: groupId, updated_at: new Date().toISOString() },
      { onConflict: "organization_id" }
    );
  if (error) throw error;
}

/** Toutes les catégories connues de l'organisation et leur étage P&L courant (null = à mapper). */
export async function chargerMappingsCategories(supabase: SupabaseClient, organizationId: string): Promise<MappingCategorie[]> {
  const { data, error } = await supabase
    .from("past_category_mappings")
    .select("source_category_id, source_category_name, source_group_id, pnl_stage")
    .eq("organization_id", organizationId);
  if (error) throw error;
  return ((data ?? []) as Row[]).map((row) => ({
    sourceCategoryId: row.source_category_id as string,
    sourceCategoryName: row.source_category_name as string,
    sourceGroupId: (row.source_group_id as string | null) ?? null,
    pnlStage: estEtagePnl(row.pnl_stage) ? row.pnl_stage : null,
  }));
}

/**
 * Rattache une catégorie à un étage P&L. Seul pnl_stage est écrit : l'auteur, la date et la ligne
 * d'historique sont posés par le trigger de la table (voir 20261009_past_category_mappings.sql).
 * Lève une erreur si aucune ligne n'a été modifiée (catégorie inconnue ou accès refusé).
 */
export async function sauvegarderEtageCategorie(
  supabase: SupabaseClient,
  organizationId: string,
  sourceCategoryId: string,
  etage: EtagePnl
): Promise<void> {
  const { data, error } = await supabase
    .from("past_category_mappings")
    .update({ pnl_stage: etage })
    .eq("organization_id", organizationId)
    .eq("source_category_id", sourceCategoryId)
    .select("source_category_id");
  if (error) throw error;
  if ((data ?? []).length === 0) throw new Error("Aucun mapping modifié.");
}

// --- Écriture Pennylane : SERVEUR UNIQUEMENT (client service_role). L'appelant est seul
// responsable d'avoir vérifié que organizationId est bien la société de l'utilisateur connecté.

/**
 * Upsert idempotent des transactions Pennylane sur leur identité source : une transaction déjà
 * connue est mise à jour (date, libellé, montant), jamais dupliquée ; ses affectations analytiques
 * sont remplacées par celles reçues (toutes conservées, aucune réduction à une catégorie).
 * created_at n'est pas dans la charge utile : il garde sa valeur d'origine lors d'une mise à jour.
 */
export async function upsertPastTransactionsPennylane(
  admin: SupabaseClient,
  organizationId: string,
  transactions: PastTransactionNormalisee[],
  syncedAt: string
): Promise<void> {
  for (let i = 0; i < transactions.length; i += TAILLE_LOT_ECRITURE) {
    const tranche = transactions.slice(i, i + TAILLE_LOT_ECRITURE);
    const lot = tranche.map((t) => ({
      organization_id: organizationId,
      source_type: "pennylane",
      source_transaction_id: t.sourceTransactionId,
      transaction_date: t.transactionDate,
      label: t.label,
      amount: t.amount,
      currency: t.currency,
      source_created_at: t.sourceCreatedAt,
      source_updated_at: t.sourceUpdatedAt,
      synced_at: syncedAt,
      updated_at: syncedAt,
    }));
    const { data, error } = await admin
      .from("past_transactions")
      .upsert(lot, { onConflict: "organization_id,source_type,source_transaction_id" })
      .select("id, source_transaction_id");
    if (error) throw error;

    const idParSource = new Map(((data ?? []) as Row[]).map((row) => [row.source_transaction_id as string, row.id as string]));
    const ids = [...idParSource.values()];
    if (ids.length === 0) continue;

    const { error: erreurSuppression } = await admin
      .from("past_transaction_categories")
      .delete()
      .eq("organization_id", organizationId)
      .in("transaction_id", ids);
    if (erreurSuppression) throw erreurSuppression;

    const affectations = tranche.flatMap((t) => {
      const transactionId = idParSource.get(t.sourceTransactionId ?? "");
      if (!transactionId) return [];
      return t.affectations.map((a) => ({
        organization_id: organizationId,
        transaction_id: transactionId,
        analytic_group_id: a.groupId,
        analytic_category_id: a.categoryId,
        analytic_category_name: a.categoryName,
        weight: a.weight,
      }));
    });
    if (affectations.length > 0) {
      const { error: erreurInsertion } = await admin.from("past_transaction_categories").insert(affectations);
      if (erreurInsertion) throw erreurInsertion;
    }
  }
}

/**
 * Enregistre les axes analytiques rencontrés. Un libellé null n'écrase jamais un libellé déjà
 * connu (axe vu dans une transaction alors que la liste des groupes n'a pas pu être lue).
 */
export async function upsertAxesAnalytiques(
  admin: SupabaseClient,
  organizationId: string,
  axes: AxeAnalytique[]
): Promise<void> {
  const maintenant = new Date().toISOString();
  const avecNom = axes.filter((a) => a.name !== null);
  const sansNom = axes.filter((a) => a.name === null);
  if (avecNom.length > 0) {
    const { error } = await admin.from("past_analytic_groups").upsert(
      avecNom.map((a) => ({ organization_id: organizationId, group_id: a.groupId, name: a.name, updated_at: maintenant })),
      { onConflict: "organization_id,group_id" }
    );
    if (error) throw error;
  }
  if (sansNom.length > 0) {
    const { error } = await admin.from("past_analytic_groups").upsert(
      sansNom.map((a) => ({ organization_id: organizationId, group_id: a.groupId })),
      { onConflict: "organization_id,group_id", ignoreDuplicates: true }
    );
    if (error) throw error;
  }
}

/**
 * Après une synchronisation COMPLÈTE d'une période : retire les lignes Pennylane de cette période
 * que la synchronisation n'a pas revues (supprimées, archivées ou déplacées hors période côté
 * Pennylane). Ne touche jamais aux lignes Excel ni aux autres périodes. Renvoie le nombre retiré.
 */
export async function supprimerPennylaneNonRevues(
  admin: SupabaseClient,
  organizationId: string,
  periode: Periode,
  syncedAt: string
): Promise<number> {
  const { data, error } = await admin
    .from("past_transactions")
    .delete()
    .eq("organization_id", organizationId)
    .eq("source_type", "pennylane")
    .gte("transaction_date", periode.debut)
    .lte("transaction_date", periode.fin)
    .lt("synced_at", syncedAt)
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

/**
 * Fait connaître à la table de mapping les catégories rencontrées par une synchronisation. Une
 * nouvelle catégorie est créée SANS étage (pnl_stage absent de la charge utile -> null, "à
 * mapper") ; une catégorie déjà connue garde son étage, seuls son nom et son axe sont rafraîchis.
 * Renvoie le nombre de catégories nouvelles.
 */
export async function enregistrerCategoriesConnues(
  admin: SupabaseClient,
  organizationId: string,
  categories: CategorieSource[]
): Promise<number> {
  if (categories.length === 0) return 0;
  const { data: existantes, error: erreurLecture } = await admin
    .from("past_category_mappings")
    .select("source_category_id")
    .eq("organization_id", organizationId);
  if (erreurLecture) throw erreurLecture;
  const connues = new Set(((existantes ?? []) as Row[]).map((row) => row.source_category_id as string));

  for (let i = 0; i < categories.length; i += TAILLE_LOT_ECRITURE) {
    const lot = categories.slice(i, i + TAILLE_LOT_ECRITURE).map((c) => ({
      organization_id: organizationId,
      source_category_id: c.sourceCategoryId,
      source_category_name: c.sourceCategoryName,
      source_group_id: c.sourceGroupId,
    }));
    const { error } = await admin
      .from("past_category_mappings")
      .upsert(lot, { onConflict: "organization_id,source_category_id" });
    if (error) throw error;
  }
  return categories.filter((c) => !connues.has(c.sourceCategoryId)).length;
}
