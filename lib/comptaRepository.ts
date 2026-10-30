import type { SupabaseClient } from "@supabase/supabase-js";
import { DestinationComptable, estDestinationComptable, normaliserCompte, RegleCorrespondance } from "./comptaCorrespondance";
import { SoldeCompte, SourceStock } from "./comptaPnl";
import { CompteSource, SoldeSource, SourceComptable } from "./comptaSource";
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

export async function chargerSourceStock(admin: SupabaseClient, organizationId: string): Promise<SourceStock | null> {
  const { data, error } = await admin.from("accounting_settings").select("inventory_source").eq("organization_id", organizationId).maybeSingle();
  if (error) throw error;
  const source = (data as Row | null)?.inventory_source;
  return source === "pennylane" || source === "novanta" ? source : null;
}

export async function enregistrerSourceStock(admin: SupabaseClient, organizationId: string, source: SourceStock | null, userId: string): Promise<void> {
  const { error } = await admin
    .from("accounting_settings")
    .upsert({ organization_id: organizationId, inventory_source: source, updated_at: new Date().toISOString(), updated_by: userId }, { onConflict: "organization_id" });
  if (error) throw error;
}

export interface EtatSynchroComptable {
  statut: "running" | "success" | "partial" | "error";
  termineeLe: string | null;
  couvertDu: string | null;
  couvertAu: string | null;
  nombreLignes: number;
  codeErreur: string | null;
}

export async function chargerEtatSynchro(admin: SupabaseClient, organizationId: string): Promise<EtatSynchroComptable | null> {
  const { data, error } = await admin.from("accounting_sync_state").select("status, finished_at, covered_from, covered_to, lines_count, error_code").eq("organization_id", organizationId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Row;
  return {
    statut: row.status as EtatSynchroComptable["statut"],
    termineeLe: (row.finished_at as string | null) ?? null,
    couvertDu: (row.covered_from as string | null) ?? null,
    couvertAu: (row.covered_to as string | null) ?? null,
    nombreLignes: Number(row.lines_count),
    codeErreur: (row.error_code as string | null) ?? null,
  };
}

export async function enregistrerEtatSynchro(
  admin: SupabaseClient,
  organizationId: string,
  source: SourceComptable["nom"],
  etat: { statut: EtatSynchroComptable["statut"]; couverture?: Periode; nombreLignes?: number; codeErreur?: string | null }
): Promise<void> {
  const maintenant = new Date().toISOString();
  const { error } = await admin.from("accounting_sync_state").upsert(
    {
      organization_id: organizationId,
      source,
      status: etat.statut,
      ...(etat.statut === "running" ? { started_at: maintenant } : { finished_at: maintenant }),
      ...(etat.couverture ? { covered_from: etat.couverture.debut, covered_to: etat.couverture.fin } : {}),
      ...(etat.nombreLignes !== undefined ? { lines_count: etat.nombreLignes } : {}),
      error_code: etat.codeErreur ?? null,
    },
    { onConflict: "organization_id" }
  );
  if (error) throw error;
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

/**
 * Balance d'un mois, relue en entier. Un compte que la source ne renvoie plus pour ce mois (ses écritures
 * ont disparu chez Pennylane) est écarté du calcul, pas effacé ; il revient si la source le renvoie. Rien
 * n'est écarté sur une lecture incomplète : ce serait une conclusion fausse.
 */
export async function enregistrerBalanceDuMois(
  admin: SupabaseClient,
  organizationId: string,
  source: SourceComptable["nom"],
  mois: string,
  soldes: SoldeSource[],
  complete: boolean,
  syncRun: string
): Promise<number> {
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
  const moisEnBase = `${mois}-01`;
  const lignes = [...parCompte.values()].map((ligne) => ({ ...ligne, organization_id: organizationId, source, month: moisEnBase, sync_run: syncRun, excluded_at: null, fetched_at: new Date().toISOString() }));
  await parLots(lignes, async (lot) => {
    const { error } = await admin.from("accounting_monthly_balances").upsert(lot, { onConflict: "organization_id,source,month,account_number" });
    if (error) throw error;
  });
  if (complete) {
    const { error } = await admin
      .from("accounting_monthly_balances")
      .update({ excluded_at: new Date().toISOString() })
      .eq("organization_id", organizationId)
      .eq("source", source)
      .eq("month", moisEnBase)
      .neq("sync_run", syncRun)
      .is("excluded_at", null);
    if (error) throw error;
  }
  return illisibles;
}
