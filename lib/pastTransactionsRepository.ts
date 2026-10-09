import type { SupabaseClient } from "@supabase/supabase-js";
import { AjustementGestion, StockFinDeMois } from "./pastAdjustments";
import { ConfigExercice, configExerciceValide, normaliserConfigExercice } from "./fiscalPeriods";
import { CategorieSource, EtagePnl, estEtagePnl, MappingCategorie } from "./pastCategoryMapping";
import { GroupeManuel } from "./flowGroups";
import { CleEnregistree, clesARecalculer, FLOW_ENGINE_VERSION, FlowAlias } from "./flowMatching";
import { ValidationSigne } from "./pastSignChecks";
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

/**
 * Début d'exercice de l'organisation (1er janvier par défaut). Lu avec `select("*")` : sur une base
 * où les colonnes d'exercice n'existent pas encore, la lecture ne plante pas, elle renvoie le défaut.
 */
export async function chargerExercice(supabase: SupabaseClient, organizationId: string): Promise<ConfigExercice> {
  const { data, error } = await supabase
    .from("past_settings")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  const row = data as Row | null;
  return normaliserConfigExercice(row?.fiscal_year_start_month, row?.fiscal_year_start_day);
}

export async function sauvegarderExercice(
  supabase: SupabaseClient,
  organizationId: string,
  exercice: ConfigExercice
): Promise<void> {
  // Même règle que l'écran et que la contrainte de la table : rien n'est envoyé si la date de
  // début n'existe pas tous les ans.
  if (!configExerciceValide(exercice)) throw new Error("Début d'exercice invalide.");
  const { error } = await supabase.from("past_settings").upsert(
    {
      organization_id: organizationId,
      fiscal_year_start_month: exercice.mois,
      fiscal_year_start_day: exercice.jour,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id" }
  );
  if (error) throw error;
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

/** Tous les stocks de fin de mois de l'organisation (la série entière sert au calcul des variations). */
export async function chargerStocks(supabase: SupabaseClient, organizationId: string): Promise<StockFinDeMois[]> {
  const { data, error } = await supabase
    .from("past_inventory_balances")
    .select("month, ending_inventory_value")
    .eq("organization_id", organizationId)
    .order("month", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Row[]).map((row) => ({
    mois: (row.month as string).slice(0, 7),
    valeur: Number(row.ending_inventory_value),
  }));
}

/** Enregistre (ou remplace) le stock de fin d'un mois "YYYY-MM". Auteur et dates : posés par trigger. */
export async function sauvegarderStock(
  supabase: SupabaseClient,
  organizationId: string,
  mois: string,
  valeur: number
): Promise<void> {
  const { error } = await supabase
    .from("past_inventory_balances")
    .upsert(
      { organization_id: organizationId, month: `${mois}-01`, ending_inventory_value: valeur },
      { onConflict: "organization_id,month" }
    );
  if (error) throw error;
}

export async function supprimerStock(supabase: SupabaseClient, organizationId: string, mois: string): Promise<void> {
  const { error } = await supabase
    .from("past_inventory_balances")
    .delete()
    .eq("organization_id", organizationId)
    .eq("month", `${mois}-01`);
  if (error) throw error;
}

/** Validations de signe inhabituel de l'organisation (voir lib/pastSignChecks.ts::repartirAnomalies). */
export async function chargerValidationsSigne(supabase: SupabaseClient, organizationId: string): Promise<ValidationSigne[]> {
  const { data, error } = await supabase
    .from("past_transaction_sign_validations")
    .select("transaction_id, source_category_id, pnl_stage_at_validation, sign_rule_at_validation, validated_at")
    .eq("organization_id", organizationId);
  if (error) throw error;
  return ((data ?? []) as Row[]).map((row) => ({
    transactionId: row.transaction_id as string,
    sourceCategoryId: row.source_category_id as string,
    etage: row.pnl_stage_at_validation as ValidationSigne["etage"],
    type: row.sign_rule_at_validation as ValidationSigne["type"],
    validatedAt: row.validated_at as string,
  }));
}

/**
 * Valide une anomalie de signe dans son contexte actuel (étage, règle). Remplace une éventuelle
 * validation antérieure de la même part, donnée dans un autre contexte. Auteur et date : posés par
 * trigger.
 */
export async function validerSigne(
  supabase: SupabaseClient,
  organizationId: string,
  validation: Omit<ValidationSigne, "validatedAt">
): Promise<void> {
  const { error } = await supabase.from("past_transaction_sign_validations").upsert(
    {
      organization_id: organizationId,
      transaction_id: validation.transactionId,
      source_category_id: validation.sourceCategoryId,
      pnl_stage_at_validation: validation.etage,
      sign_rule_at_validation: validation.type,
    },
    { onConflict: "organization_id,transaction_id,source_category_id" }
  );
  if (error) throw error;
}

export async function annulerValidationSigne(
  supabase: SupabaseClient,
  organizationId: string,
  transactionId: string,
  sourceCategoryId: string
): Promise<void> {
  const { error } = await supabase
    .from("past_transaction_sign_validations")
    .delete()
    .eq("organization_id", organizationId)
    .eq("transaction_id", transactionId)
    .eq("source_category_id", sourceCategoryId);
  if (error) throw error;
}

/**
 * Suit une évolution du moteur de reconnaissance : les clés enregistrées sous une version
 * antérieure sont recalculées à partir de leur libellé d'exemple (clesARecalculer), puis corrigées
 * en base. Renvoie, pour chaque clé déplacée, sa nouvelle clé — ou null quand une autre ligne
 * porte déjà cette nouvelle clé : l'ancienne ligne, devenue un doublon, est supprimée.
 *
 * La correction en base est faite au mieux : si elle échoue, la lecture réussit quand même avec
 * les clés recalculées, et la correction sera retentée à la lecture suivante.
 */
async function suivreEvolutionDuMoteur(
  supabase: SupabaseClient,
  table: "past_flow_aliases" | "past_flow_group_members",
  organizationId: string,
  lignes: CleEnregistree[]
): Promise<Map<string, string | null>> {
  const { deplacees, confirmees } = clesARecalculer(lignes);
  const cles = new Set(lignes.map((ligne) => ligne.cle));
  const destinations = new Map<string, string | null>();
  const ecritures: PromiseLike<{ error: unknown }>[] = [];
  for (const { ancienne, nouvelle } of deplacees) {
    const filtre = () => ({ organization_id: organizationId, canonical_flow_key: ancienne });
    if (cles.has(nouvelle)) {
      destinations.set(ancienne, null);
      ecritures.push(supabase.from(table).delete().match(filtre()));
    } else {
      destinations.set(ancienne, nouvelle);
      cles.add(nouvelle);
      ecritures.push(supabase.from(table).update({ canonical_flow_key: nouvelle, engine_version: FLOW_ENGINE_VERSION }).match(filtre()));
    }
  }
  for (const cle of confirmees) {
    ecritures.push(supabase.from(table).update({ engine_version: FLOW_ENGINE_VERSION }).match({ organization_id: organizationId, canonical_flow_key: cle }));
  }
  if (ecritures.length > 0) {
    const resultats = await Promise.all(ecritures);
    const echecs = resultats.filter((r) => r.error).length;
    console.warn(
      `[passe/flux] step=engine-upgrade table=${table} organization=${organizationId} version=${FLOW_ENGINE_VERSION} deplacees=${deplacees.length} confirmees=${confirmees.length} echecs=${echecs}`
    );
  }
  return destinations;
}

const cleEnregistree = (row: Row): CleEnregistree => ({
  cle: row.canonical_flow_key as string,
  exemple: (row.sample_label as string | null) ?? null,
  version: (row.engine_version as string | null) ?? null,
});

/** Alias de flux de l'organisation (voir lib/flowMatching.ts). */
export async function chargerAliasFlux(supabase: SupabaseClient, organizationId: string): Promise<FlowAlias[]> {
  const { data, error } = await supabase
    .from("past_flow_aliases")
    .select("canonical_flow_key, display_name, sample_label, engine_version")
    .eq("organization_id", organizationId);
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  const destinations = await suivreEvolutionDuMoteur(supabase, "past_flow_aliases", organizationId, rows.map(cleEnregistree));
  return rows
    .filter((row) => destinations.get(row.canonical_flow_key as string) !== null)
    .map((row) => ({
      canonicalFlowKey: destinations.get(row.canonical_flow_key as string) ?? (row.canonical_flow_key as string),
      displayName: row.display_name as string,
    }));
}

/**
 * Enregistre (ou remplace) le nom d'un flux pour chacune de ses identités propres. Chaque ligne
 * garde le nom détecté, un libellé bancaire d'exemple et la version du moteur : de quoi recalculer
 * la clé si le moteur évolue. Auteur et date : posés par trigger.
 */
export async function sauvegarderAliasFlux(
  supabase: SupabaseClient,
  organizationId: string,
  displayName: string,
  detectedName: string,
  cles: { cle: string; exemple: string }[]
): Promise<void> {
  const { error } = await supabase.from("past_flow_aliases").upsert(
    cles.map(({ cle, exemple }) => ({
      organization_id: organizationId,
      canonical_flow_key: cle,
      display_name: displayName,
      detected_name: detectedName,
      sample_label: exemple,
      engine_version: FLOW_ENGINE_VERSION,
    })),
    { onConflict: "organization_id,canonical_flow_key" }
  );
  if (error) throw error;
}

export async function supprimerAliasFlux(supabase: SupabaseClient, organizationId: string, cles: string[]): Promise<void> {
  // Une suppression par clé, en égalité stricte : une clé contient des « : » et des espaces, qu'un
  // filtre de liste interpréterait.
  const resultats = await Promise.all(
    cles.map((cle) => supabase.from("past_flow_aliases").delete().eq("organization_id", organizationId).eq("canonical_flow_key", cle))
  );
  const erreur = resultats.find((r) => r.error)?.error;
  if (erreur) throw erreur;
}

/** Regroupements manuels de flux de l'organisation, avec leurs membres (voir lib/flowGroups.ts). */
export async function chargerGroupesFlux(supabase: SupabaseClient, organizationId: string): Promise<GroupeManuel[]> {
  const { data, error } = await supabase
    .from("past_flow_groups")
    .select("id, display_name, past_flow_group_members(canonical_flow_key, detected_name, sample_label, engine_version)")
    .eq("organization_id", organizationId);
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  const membresDe = (row: Row) => (row.past_flow_group_members as Row[] | null) ?? [];
  const destinations = await suivreEvolutionDuMoteur(
    supabase,
    "past_flow_group_members",
    organizationId,
    rows.flatMap(membresDe).map(cleEnregistree)
  );
  return rows.map((row) => ({
    id: row.id as string,
    nom: row.display_name as string,
    membres: membresDe(row)
      .filter((membre) => destinations.get(membre.canonical_flow_key as string) !== null)
      .map((membre) => ({
        cle: destinations.get(membre.canonical_flow_key as string) ?? (membre.canonical_flow_key as string),
        nomDetecte: (membre.detected_name as string | null) ?? "",
        exemple: (membre.sample_label as string | null) ?? "",
      })),
  }));
}

/**
 * Enregistre un groupe manuel et ses membres : crée ou renomme le groupe, puis y rattache chaque
 * flux. Un flux déjà membre d'un autre groupe en change (une seule appartenance par organisation).
 */
export async function enregistrerGroupeFlux(supabase: SupabaseClient, organizationId: string, groupe: GroupeManuel): Promise<void> {
  const { error } = await supabase
    .from("past_flow_groups")
    .upsert({ id: groupe.id, organization_id: organizationId, display_name: groupe.nom }, { onConflict: "id" });
  if (error) throw error;
  const { error: erreurMembres } = await supabase.from("past_flow_group_members").upsert(
    groupe.membres.map((membre) => ({
      organization_id: organizationId,
      flow_group_id: groupe.id,
      canonical_flow_key: membre.cle,
      detected_name: membre.nomDetecte,
      sample_label: membre.exemple,
      engine_version: FLOW_ENGINE_VERSION,
    })),
    { onConflict: "organization_id,canonical_flow_key" }
  );
  if (erreurMembres) throw erreurMembres;
}

export async function renommerGroupeFlux(supabase: SupabaseClient, organizationId: string, groupeId: string, nom: string): Promise<void> {
  const { data, error } = await supabase
    .from("past_flow_groups")
    .update({ display_name: nom })
    .eq("organization_id", organizationId)
    .eq("id", groupeId)
    .select("id");
  if (error) throw error;
  if ((data ?? []).length === 0) throw new Error("Aucun groupe modifié.");
}

/** Retire un flux de son groupe manuel. */
export async function retirerFluxDuGroupe(supabase: SupabaseClient, organizationId: string, cle: string): Promise<void> {
  const { error } = await supabase
    .from("past_flow_group_members")
    .delete()
    .eq("organization_id", organizationId)
    .eq("canonical_flow_key", cle);
  if (error) throw error;
}

/** Supprime un groupe manuel ; ses membres partent avec lui et redeviennent des flux individuels. */
export async function supprimerGroupeFlux(supabase: SupabaseClient, organizationId: string, groupeId: string): Promise<void> {
  const { error } = await supabase.from("past_flow_groups").delete().eq("organization_id", organizationId).eq("id", groupeId);
  if (error) throw error;
}

/** Ajustements de gestion saisis tels quels (hors variation de stock, calculée à partir des stocks). */
export async function chargerAjustementsGestion(
  supabase: SupabaseClient,
  organizationId: string
): Promise<AjustementGestion[]> {
  const { data, error } = await supabase
    .from("past_management_adjustments")
    .select("id, adjustment_date, label, amount, pnl_stage, adjustment_type, notes")
    .eq("organization_id", organizationId);
  if (error) throw error;
  return ((data ?? []) as Row[]).flatMap((row) =>
    estEtagePnl(row.pnl_stage)
      ? [
          {
            id: row.id as string,
            date: row.adjustment_date as string,
            label: row.label as string,
            montant: Number(row.amount),
            etage: row.pnl_stage,
            type: row.adjustment_type as string,
            notes: (row.notes as string | null) ?? null,
          },
        ]
      : []
  );
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
