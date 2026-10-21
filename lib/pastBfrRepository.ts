import type { SupabaseClient } from "@supabase/supabase-js";
import { ExclusionFacture, FactureBfr, LigneBfr, ReglementBfr, RevisionBfr, SituationValidee, TypeFactureBfr } from "./pastBfr";
import type { LigneStockee, ReglementsStockes } from "./pastBfrSync";

/**
 * Accès Supabase du BFR historique (voir supabase/migrations/20261022_past_working_capital.sql).
 * past_bfr_invoices : écrite par la route serveur seulement (client admin), relue par
 * l'organisation. past_bfr_situations : situations validées, écrites par l'utilisateur (RLS).
 */

export type Row = Record<string, unknown>;

export const TAILLE_LOT = 200;

export const VERS_BASE: Record<TypeFactureBfr, string> = { client: "customer", fournisseur: "supplier" };
const DEPUIS_BASE: Record<string, TypeFactureBfr> = { customer: "client", supplier: "fournisseur" };

const nombreOuNull = (valeur: unknown) => (valeur === null || valeur === undefined ? null : Number(valeur));

/**
 * Colonne settlements : { etat: "a_dater" } | { etat: "dates", recuperesLe, transactions } | null
 * (inutiles). Ancien format (tableau de transactions, sans date de récupération) : lu comme daté mais
 * à rafraîchir, voir lib/pastBfrSync.ts.
 */
function versReglementsStockes(valeur: unknown): ReglementsStockes | null {
  if (valeur === null || valeur === undefined) return null;
  if (Array.isArray(valeur)) return { etat: "dates", recuperesLe: "1970-01-01T00:00:00.000Z", transactions: valeur as ReglementBfr[] };
  const objet = valeur as { etat?: string; recuperesLe?: string; transactions?: ReglementBfr[] };
  if (objet.etat === "dates") return { etat: "dates", recuperesLe: objet.recuperesLe ?? "1970-01-01T00:00:00.000Z", transactions: objet.transactions ?? [] };
  return { etat: "a_dater" };
}

export function versLigneStockee(row: Row): LigneStockee {
  const reglements = versReglementsStockes(row.settlements);
  return {
    facture: {
      pennylaneId: row.pennylane_id as string,
      type: DEPUIS_BASE[row.invoice_type as string],
      numero: row.invoice_number as string,
      tiers: row.party_label as string,
      dateEmission: (row.issue_date as string | null) ?? null,
      echeance: (row.due_date as string | null) ?? null,
      devise: row.currency as string,
      montantTtc: Number(row.amount_incl_tax),
      montantHt: nombreOuNull(row.amount_excl_tax),
      resteTtc: Number(row.remaining_incl_tax),
      resteHt: nombreOuNull(row.remaining_excl_tax),
      exclusion: (row.exclusion as ExclusionFacture | null) ?? null,
      factureAvoireeId: (row.credited_pennylane_id as string | null) ?? null,
      reglements: reglements?.etat === "dates" ? reglements.transactions : null,
    },
    pennylaneUpdatedAt: (row.pennylane_updated_at as string | null) ?? null,
    reglements,
  };
}

const versFacture = (row: Row): FactureBfr => versLigneStockee(row).facture;

export interface FacturesBfrChargees {
  factures: FactureBfr[];
  synchroniseesLe: string | null; // horodatage ISO de la dernière synchronisation, null si jamais
}

/** Faits Pennylane du BFR de l'organisation (lecture RLS). */
export async function chargerFacturesBfr(supabase: SupabaseClient, organizationId: string): Promise<FacturesBfrChargees> {
  const factures: FactureBfr[] = [];
  let synchroniseesLe: string | null = null;
  for (let debut = 0; ; debut += 1000) {
    const { data, error } = await supabase
      .from("past_bfr_invoices")
      .select("*")
      .eq("organization_id", organizationId)
      .order("invoice_type")
      .order("pennylane_id")
      .range(debut, debut + 999);
    if (error) throw error;
    const lignes = (data ?? []) as Row[];
    for (const row of lignes) {
      factures.push(versFacture(row));
      const synchro = row.synced_at as string;
      if (synchroniseesLe === null || synchro > synchroniseesLe) synchroniseesLe = synchro;
    }
    if (lignes.length < 1000) break;
  }
  return { factures, synchroniseesLe };
}

// --- Situations validées ---

function versSituation(row: Row): SituationValidee {
  return {
    date: row.reference_date as string,
    creances: Number(row.receivables_excl_tax),
    stock: Number(row.inventory_excl_tax),
    dettes: Number(row.payables_excl_tax),
    bfr: Number(row.working_capital_excl_tax),
    calculeeLe: row.computed_at as string,
    synchroniseLe: (row.data_synced_on as string | null) ?? null,
    valideeLe: row.validated_at as string,
    creancesRetenues: (row.receivables_lines as LigneBfr[]) ?? [],
    dettesRetenues: (row.payables_lines as LigneBfr[]) ?? [],
    revisions: (row.revisions as RevisionBfr[]) ?? [],
  };
}

export async function chargerSituationsValidees(supabase: SupabaseClient, organizationId: string): Promise<SituationValidee[]> {
  const { data, error } = await supabase
    .from("past_bfr_situations")
    .select("*")
    .eq("organization_id", organizationId)
    .order("reference_date", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Row[]).map(versSituation);
}

function versLigne(organizationId: string, s: SituationValidee, provenance: Record<string, unknown>) {
  return {
    organization_id: organizationId,
    reference_date: s.date,
    receivables_excl_tax: s.creances,
    inventory_excl_tax: s.stock,
    payables_excl_tax: s.dettes,
    working_capital_excl_tax: s.bfr,
    computed_at: s.calculeeLe,
    data_synced_on: s.synchroniseLe,
    receivables_lines: s.creancesRetenues,
    payables_lines: s.dettesRetenues,
    provenance,
    validated_at: s.valideeLe,
    revisions: s.revisions,
  };
}

export async function validerSituationBfr(
  supabase: SupabaseClient,
  organizationId: string,
  situation: SituationValidee,
  provenance: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.from("past_bfr_situations").insert(versLigne(organizationId, situation, provenance));
  if (error) throw error;
}

/** Révision explicite : la ligne est remplacée, l'ancienne version est dans `revisions` (trigger). */
export async function reviserSituationBfr(
  supabase: SupabaseClient,
  organizationId: string,
  situation: SituationValidee,
  provenance: Record<string, unknown>
): Promise<void> {
  const { organization_id: _organisation, reference_date: _date, ...champs } = versLigne(organizationId, situation, provenance);
  const { error } = await supabase
    .from("past_bfr_situations")
    .update(champs)
    .eq("organization_id", organizationId)
    .eq("reference_date", situation.date);
  if (error) throw error;
}
