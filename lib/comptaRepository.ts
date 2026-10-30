import type { SupabaseClient } from "@supabase/supabase-js";
import { DestinationComptable, estDestinationComptable, estLigneComptable, normaliserCompte, RegleCorrespondance } from "./comptaCorrespondance";
import { SoldeCompte, SourceStock } from "./comptaPnl";
import { CompteSource, SoldeSource, SourceComptable } from "./comptaSource";
import { Declencheur, ExerciceComptable } from "./comptaExercices";
import type { AjustementComptable, ChoixStock } from "./comptaStocks";
import type { DepotSynchro, EchecMois } from "./comptaSynchro";
import { comptesParNumero } from "./comptaPennylaneAdapter";
import { Periode } from "./pastTransactions";

/**
 * Accès aux tables accounting_* — SERVEUR UNIQUEMENT, avec la clé service_role : ces tables n'ont
 * aucune policy pour le navigateur (migration 20261030_accounting_pnl.sql). Chaque requête est bornée
 * par l'organisation que la route a dérivée de l'utilisateur connecté (lib/comptaAcces.ts).
 */

type Row = Record<string, unknown>;

const TAILLE_LOT = 500;
// Une requête Supabase rend 1000 lignes au plus, sans le signaler : un plan de comptes réel la dépasse.
const TAILLE_PAGE_LECTURE = 1000;

async function toutLire<T>(lirePage: (depuis: number, jusqua: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const lignes: T[] = [];
  for (let depuis = 0; ; depuis += TAILLE_PAGE_LECTURE) {
    const { data, error } = await lirePage(depuis, depuis + TAILLE_PAGE_LECTURE - 1);
    if (error) throw error;
    lignes.push(...(data ?? []));
    if ((data ?? []).length < TAILLE_PAGE_LECTURE) return lignes;
  }
}

function versRegle(row: Row): RegleCorrespondance | null {
  if (!estDestinationComptable(row.pnl_line)) return null;
  return { prefixe: row.account_prefix as string, destination: row.pnl_line as DestinationComptable, categorie: row.category_label as string };
}

export async function chargerRegles(admin: SupabaseClient, organizationId: string): Promise<RegleCorrespondance[]> {
  const { data, error } = await admin.from("accounting_mapping_rules").select("account_prefix, pnl_line, category_label").eq("organization_id", organizationId);
  if (error) throw error;
  return ((data ?? []) as Row[]).flatMap((row) => versRegle(row) ?? []);
}

export async function enregistrerRegle(admin: SupabaseClient, organizationId: string, regle: RegleCorrespondance, userId: string): Promise<void> {
  const { error } = await admin.from("accounting_mapping_rules").upsert(
    {
      organization_id: organizationId,
      account_prefix: regle.prefixe,
      pnl_line: regle.destination,
      category_label: regle.categorie.trim(),
      updated_at: new Date().toISOString(),
      updated_by: userId,
    },
    { onConflict: "organization_id,account_prefix" }
  );
  if (error) throw error;
}

export async function supprimerRegle(admin: SupabaseClient, organizationId: string, prefixe: string, userId: string): Promise<void> {
  // L'auteur est posé d'abord : le trigger le reprend dans le journal de la suppression.
  const { error: erreurAuteur } = await admin.from("accounting_mapping_rules").update({ updated_by: userId }).eq("organization_id", organizationId).eq("account_prefix", prefixe);
  if (erreurAuteur) throw erreurAuteur;
  const { error } = await admin.from("accounting_mapping_rules").delete().eq("organization_id", organizationId).eq("account_prefix", prefixe);
  if (error) throw error;
}

/** Ajoute les règles du modèle sans jamais écraser une racine déjà paramétrée. */
export async function appliquerModele(admin: SupabaseClient, organizationId: string, regles: readonly RegleCorrespondance[], userId: string): Promise<void> {
  const { error } = await admin.from("accounting_mapping_rules").upsert(
    regles.map((regle) => ({ organization_id: organizationId, account_prefix: regle.prefixe, pnl_line: regle.destination, category_label: regle.categorie, updated_by: userId })),
    { onConflict: "organization_id,account_prefix", ignoreDuplicates: true }
  );
  if (error) throw error;
}

export interface CompteConnu {
  numero: string;
  libelle: string;
  premiereVue: string;
}

export async function chargerComptes(admin: SupabaseClient, organizationId: string): Promise<CompteConnu[]> {
  const lignes = await toutLire<Row>((depuis, jusqua) =>
    admin.from("accounting_accounts").select("account_number, label, first_seen_at").eq("organization_id", organizationId).order("account_number").range(depuis, jusqua)
  );
  return lignes.map((row) => ({ numero: row.account_number as string, libelle: row.label as string, premiereVue: row.first_seen_at as string }));
}

/** Soldes retenus des mois recoupant la période : la balance est lue par mois entier. */
export async function chargerSoldes(admin: SupabaseClient, organizationId: string, periode: Periode): Promise<SoldeCompte[]> {
  const lignes = await toutLire<Row>((depuis, jusqua) =>
    admin
      .from("accounting_monthly_balances")
      .select("account_number, month, debit, credit")
      .eq("organization_id", organizationId)
      .gte("month", `${periode.debut.slice(0, 7)}-01`)
      .lte("month", `${periode.fin.slice(0, 7)}-01`)
      .is("excluded_at", null)
      .order("month")
      .order("account_number")
      .range(depuis, jusqua)
  );
  return lignes.map((row) => ({
    compte: row.account_number as string,
    mois: (row.month as string).slice(0, 7),
    debit: Number(row.debit),
    credit: Number(row.credit),
    nombreLignes: 0,
  }));
}

/** Premier mois de balance connu : début de l'historique comptable (références d'Action). */
export async function chargerPremierMoisDeBalance(admin: SupabaseClient, organizationId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("accounting_monthly_balances")
    .select("month")
    .eq("organization_id", organizationId)
    .is("excluded_at", null)
    .order("month", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return ((data as Row | null)?.month as string | undefined) ?? null;
}

export interface ExecutionSynchro {
  declencheur: Declencheur;
  statut: "running" | "success" | "partial" | "error" | "abandoned";
  commenceeLe: string;
  termineeLe: string | null;
  moisDemandes: number;
  moisActualises: number;
  moisEnEchec: EchecMois[];
  limites: string[];
}

function versExecution(row: Row): ExecutionSynchro {
  return {
    declencheur: row.trigger_type as Declencheur,
    statut: row.status as ExecutionSynchro["statut"],
    commenceeLe: row.started_at as string,
    termineeLe: (row.finished_at as string | null) ?? null,
    moisDemandes: Number(row.months_requested),
    moisActualises: Number(row.months_updated),
    moisEnEchec: (row.failed_months as EchecMois[] | null) ?? [],
    limites: (row.notes as string[] | null) ?? [],
  };
}

const COLONNES_EXECUTION = "trigger_type, status, started_at, finished_at, months_requested, months_updated, failed_months, notes";

/** Dernière synchronisation, quelle qu'en soit l'issue, et la dernière réussie : l'écran dit les deux. */
export async function chargerDernieresSynchros(admin: SupabaseClient, organizationId: string): Promise<{ derniere: ExecutionSynchro | null; derniereReussie: ExecutionSynchro | null }> {
  const lire = async (filtrer: boolean) => {
    let requete = admin.from("accounting_sync_runs").select(COLONNES_EXECUTION).eq("organization_id", organizationId);
    if (filtrer) requete = requete.in("status", ["success", "partial"]).gt("months_updated", 0);
    const { data, error } = await requete.order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data ? versExecution(data as Row) : null;
  };
  return { derniere: await lire(false), derniereReussie: await lire(true) };
}

/** Dernière lecture complète réussie : décide si le passage planifié sera hebdomadaire. */
export async function chargerDerniereLectureComplete(admin: SupabaseClient, organizationId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("accounting_sync_runs")
    .select("finished_at")
    .eq("organization_id", organizationId)
    .in("trigger_type", ["hebdomadaire", "manuel"])
    .eq("status", "success")
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return ((data as Row | null)?.finished_at as string | undefined) ?? null;
}

export async function chargerExercices(admin: SupabaseClient, organizationId: string): Promise<ExerciceComptable[]> {
  const { data, error } = await admin.from("accounting_fiscal_years").select("source_fiscal_year_id, start_date, finish_date, status").eq("organization_id", organizationId).order("start_date");
  if (error) throw error;
  return ((data ?? []) as Row[]).map((row) => ({ idSource: row.source_fiscal_year_id as string, debut: row.start_date as string, fin: row.finish_date as string, statut: (row.status as string | null) ?? null }));
}

/** Dernier arbitrage de chaque périmètre. Les précédents restent en base : c'est la trace. */
export async function chargerChoixStock(admin: SupabaseClient, organizationId: string): Promise<Map<string, ChoixStock>> {
  const { data, error } = await admin
    .from("accounting_inventory_source_choices")
    .select("scope_start, source, pennylane_amount, novanta_amount, chosen_at")
    .eq("organization_id", organizationId)
    .order("chosen_at", { ascending: false });
  if (error) throw error;
  const choix = new Map<string, ChoixStock>();
  for (const row of (data ?? []) as Row[]) {
    const cle = row.scope_start as string;
    if (choix.has(cle)) continue;
    choix.set(cle, {
      source: row.source === "pennylane" || row.source === "novanta" ? row.source : null,
      montantPennylane: row.pennylane_amount === null ? null : Number(row.pennylane_amount),
      montantNovanta: row.novanta_amount === null ? null : Number(row.novanta_amount),
      choisiLe: row.chosen_at as string,
    });
  }
  return choix;
}

export async function enregistrerChoixStock(
  admin: SupabaseClient,
  organizationId: string,
  choix: { perimetre: { debut: string; fin: string }; source: SourceStock | null; montantPennylane: number; montantNovanta: number },
  userId: string
): Promise<void> {
  const { error } = await admin.from("accounting_inventory_source_choices").insert({
    organization_id: organizationId,
    scope_start: choix.perimetre.debut,
    scope_end: choix.perimetre.fin,
    source: choix.source,
    pennylane_amount: choix.montantPennylane,
    novanta_amount: choix.montantNovanta,
    chosen_by: userId,
  });
  if (error) throw error;
}

export async function chargerAjustementsComptables(admin: SupabaseClient, organizationId: string): Promise<AjustementComptable[]> {
  const { data, error } = await admin
    .from("accounting_management_adjustments")
    .select("id, adjustment_date, pnl_line, label, amount, notes")
    .eq("organization_id", organizationId)
    .is("archived_at", null);
  if (error) throw error;
  return ((data ?? []) as Row[]).flatMap((row) =>
    estLigneComptable(row.pnl_line) && row.pnl_line !== "inventory_variation"
      ? [{ id: row.id as string, date: row.adjustment_date as string, ligne: row.pnl_line, libelle: row.label as string, montant: Number(row.amount), notes: (row.notes as string | null) ?? null }]
      : []
  );
}

async function parLots<T>(lignes: T[], traiter: (lot: T[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < lignes.length; i += TAILLE_LOT) await traiter(lignes.slice(i, i + TAILLE_LOT));
}

/** Plan de comptes : un compte inconnu est ajouté, un compte connu garde sa date de première vue. */
export async function enregistrerComptes(admin: SupabaseClient, organizationId: string, source: SourceComptable["nom"], comptes: CompteSource[]): Promise<number> {
  const connus = new Set((await chargerComptes(admin, organizationId)).map((c) => c.numero));
  const maintenant = new Date().toISOString();
  const lignes = comptesParNumero(comptes.map((compte) => ({ ...compte, numero: normaliserCompte(compte.numero) })).filter((compte) => compte.numero)).map((compte) => ({
    organization_id: organizationId,
    account_number: compte.numero,
    label: compte.libelle,
    account_type: compte.type,
    enabled: compte.actif,
    source,
    source_account_id: compte.idSource,
    last_seen_at: maintenant,
  }));
  await parLots(lignes, async (lot) => {
    const { error } = await admin.from("accounting_accounts").upsert(lot, { onConflict: "organization_id,account_number" });
    if (error) throw error;
  });
  return lignes.filter((ligne) => !connus.has(ligne.account_number)).length;
}

/** Cumul par numéro de compte, au centime : les lignes prêtes à remplacer le mois, et les numéros illisibles. */
export function preparerBalance(soldes: SoldeSource[]): { lignes: { account_number: string; account_label: string | null; debit: number; credit: number }[]; illisibles: number } {
  const parCompte = new Map<string, { account_number: string; account_label: string | null; debit: number; credit: number }>();
  let illisibles = 0;
  for (const solde of soldes) {
    const numero = normaliserCompte(solde.compte);
    if (!numero) {
      illisibles += 1;
      continue;
    }
    const cumul = parCompte.get(numero) ?? { account_number: numero, account_label: solde.libelle, debit: 0, credit: 0 };
    cumul.debit = (Math.round(cumul.debit * 100) + Math.round(solde.debit * 100)) / 100;
    cumul.credit = (Math.round(cumul.credit * 100) + Math.round(solde.credit * 100)) / 100;
    parCompte.set(numero, cumul);
  }
  return { lignes: [...parCompte.values()], illisibles };
}

// Au-delà, une exécution « running » vient d'une fonction serveur interrompue (durée maximale : 300 s).
const DELAI_EXECUTION_ABANDONNEE_S = 600;

/** Dépôt de la synchronisation pour une société : toutes les écritures sont bornées à cette société. */
export function depotSupabase(admin: SupabaseClient, organizationId: string, source: SourceComptable["nom"]): DepotSynchro {
  return {
    async commencer(declencheur) {
      const { data, error } = await admin.rpc("accounting_sync_begin", { p_organization_id: organizationId, p_source: source, p_trigger: declencheur, p_stale_after_seconds: DELAI_EXECUTION_ABANDONNEE_S });
      if (error) throw error;
      return (data as string | null) ?? null;
    },
    async terminer(idExecution, bilan) {
      const { error } = await admin
        .from("accounting_sync_runs")
        .update({
          status: bilan.statut,
          finished_at: new Date().toISOString(),
          months_requested: bilan.moisDemandes,
          months_updated: bilan.moisActualises,
          failed_months: bilan.moisEnEchec,
          notes: bilan.limites,
          error_code: bilan.codeErreur,
        })
        .eq("organization_id", organizationId)
        .eq("id", idExecution);
      if (error) throw error;
    },
    async enregistrerExercices(exercices) {
      if (exercices.length === 0) return;
      const { error } = await admin.from("accounting_fiscal_years").upsert(
        exercices.map((e) => ({ organization_id: organizationId, source, source_fiscal_year_id: e.idSource, start_date: e.debut, finish_date: e.fin, status: e.statut, fetched_at: new Date().toISOString() })),
        { onConflict: "organization_id,source,source_fiscal_year_id" }
      );
      if (error) throw error;
    },
    exercicesConnus: () => chargerExercices(admin, organizationId),
    enregistrerComptes: (comptes) => enregistrerComptes(admin, organizationId, source, comptes),
    async moisDejaRempli(mois) {
      const { count, error } = await admin
        .from("accounting_monthly_balances")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("source", source)
        .eq("month", `${mois}-01`)
        .is("excluded_at", null);
      if (error) throw error;
      return (count ?? 0) > 0;
    },
    async remplacerMois(mois, soldes, idExecution) {
      const { lignes, illisibles } = preparerBalance(soldes);
      const { error } = await admin.rpc("accounting_replace_month_balance", { p_organization_id: organizationId, p_source: source, p_month: `${mois}-01`, p_run: idExecution, p_lines: lignes });
      if (error) throw error;
      return illisibles;
    },
  };
}
