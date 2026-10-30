import type { SupabaseClient } from "@supabase/supabase-js";
import {
  Chantier,
  CLE_PERSONNALISE,
  DonneesPasse,
  estCleKpiAuto,
  estTypePeriode,
  KpiChantier,
  lirePhotographie,
  OrigineReference,
  PhotographieChantier,
  Reference,
  Sens,
  TypePeriode,
  ValeurManuelle,
} from "./actionChantier";
import { ajustementsDepuisStocks } from "./pastAdjustments";
import { chargerSituationsValidees } from "./pastBfrRepository";
import { indexerMappings } from "./pastCategoryMapping";
import { Periode, resoudreAxeAnalytique } from "./pastTransactions";
import {
  chargerAjustementsGestion,
  chargerAxeConfigure,
  chargerAxesAnalytiques,
  chargerMappingsCategories,
  chargerPastTransactions,
  chargerStocks,
} from "./pastTransactionsRepository";

/**
 * Accès Supabase au module Action (tables action_*, migration 20261027_action_initiatives.sql).
 * Toutes les requêtes sont bornées par organization_id, en plus de la RLS (sa société, module
 * 'past' activé).
 */

type Row = Record<string, unknown>;

const ORIGINES: OrigineReference[] = ["equivalent", "previous", "indicative", "situation", "manual", "none"];

function versKpi(row: Row): KpiChantier | null {
  const cle = row.kpi_key as string;
  if (cle !== CLE_PERSONNALISE && !estCleKpiAuto(cle)) return null;
  const origine = ORIGINES.includes(row.reference_origin as OrigineReference) ? (row.reference_origin as OrigineReference) : "none";
  const reference: Reference = {
    valeur: row.reference_value === null || row.reference_value === undefined ? null : Number(row.reference_value),
    libelle: (row.reference_label as string | null) ?? null,
    origine,
    periode: row.reference_start && row.reference_end ? { debut: row.reference_start as string, fin: row.reference_end as string } : null,
  };
  return {
    id: row.id as string,
    position: Number(row.position) as 1 | 2 | 3,
    cle,
    nomPersonnalise: (row.custom_name as string | null) ?? null,
    unitePersonnalisee: (row.custom_unit as string | null) ?? null,
    sens: row.direction === "down" ? "down" : "up",
    reference,
    cible: Number(row.target_value),
  };
}

export interface ChantierCharge {
  chantier: Chantier;
  valeursManuelles: ValeurManuelle[];
}

/** Le chantier actif de l'organisation (au plus un), avec ses 3 indicateurs et ses saisies. */
export async function chargerChantierActif(supabase: SupabaseClient, organizationId: string): Promise<ChantierCharge | null> {
  const { data, error } = await supabase
    .from("action_initiatives")
    .select(
      "id, title, change_description, period_type, start_date, end_date, status, action_initiative_kpis(id, position, kpi_key, custom_name, custom_unit, direction, reference_value, reference_label, reference_origin, reference_start, reference_end, target_value, action_initiative_manual_values(kpi_id, month, value))"
    )
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Row;
  const lignesKpi = ((row.action_initiative_kpis as Row[] | null) ?? []).sort((a, b) => Number(a.position) - Number(b.position));
  const kpis = lignesKpi.map(versKpi).filter((k): k is KpiChantier => k !== null);
  const valeursManuelles = lignesKpi.flatMap((k) =>
    ((k.action_initiative_manual_values as Row[] | null) ?? []).map((v) => ({
      kpiId: v.kpi_id as string,
      mois: (v.month as string).slice(0, 7),
      valeur: Number(v.value),
    }))
  );
  const typePeriode = row.period_type as string;
  return {
    chantier: {
      id: row.id as string,
      titre: row.title as string,
      changement: row.change_description as string,
      typePeriode: estTypePeriode(typePeriode) ? typePeriode : "quarter",
      periode: { debut: row.start_date as string, fin: row.end_date as string },
      statut: "active",
      kpis,
    },
    valeursManuelles,
  };
}

export interface KpiALancer {
  position: 1 | 2 | 3;
  cle: KpiChantier["cle"];
  nomPersonnalise: string | null;
  unitePersonnalisee: string | null;
  sens: Sens;
  reference: Reference;
  cible: number;
}

/** Lance le chantier et ses 3 indicateurs en une transaction (fonction action_lancer_chantier). */
export async function lancerChantier(
  supabase: SupabaseClient,
  organizationId: string,
  chantier: { titre: string; changement: string; typePeriode: TypePeriode; periode: Periode },
  kpis: KpiALancer[]
): Promise<string> {
  const { data, error } = await supabase.rpc("action_lancer_chantier", {
    p_organization_id: organizationId,
    p_title: chantier.titre,
    p_change_description: chantier.changement,
    p_period_type: chantier.typePeriode,
    p_start_date: chantier.periode.debut,
    p_end_date: chantier.periode.fin,
    p_kpis: kpis.map((k) => ({
      position: k.position,
      kpi_key: k.cle,
      custom_name: k.nomPersonnalise,
      custom_unit: k.unitePersonnalisee,
      direction: k.sens,
      reference_value: k.reference.valeur,
      reference_label: k.reference.libelle,
      reference_origin: k.reference.origine,
      reference_start: k.reference.periode?.debut ?? null,
      reference_end: k.reference.periode?.fin ?? null,
      target_value: k.cible,
    })),
  });
  if (error) throw error;
  return data as string;
}

/**
 * Clôture le chantier actif, en une seule écriture : statut, date et photographie de la fiche.
 * Rien n'est supprimé ; le chantier passe dans l'historique, en lecture seule.
 */
export async function cloturerChantier(
  supabase: SupabaseClient,
  organizationId: string,
  chantierId: string,
  photographie: PhotographieChantier
): Promise<void> {
  const { data, error } = await supabase
    .from("action_initiatives")
    .update({ status: "completed", completed_at: photographie.clotureLe, closing_snapshot: photographie })
    .eq("organization_id", organizationId)
    .eq("id", chantierId)
    .eq("status", "active")
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) throw new Error("Ce chantier n'est plus actif.");
}

export interface ChantierCloture {
  id: string;
  titre: string;
  typePeriode: TypePeriode;
  periode: Periode;
  clotureLe: string;
  // null : chantier clôturé sans photographie lisible (antérieur à l'historisation).
  photographie: PhotographieChantier | null;
}

/** Historique : les chantiers clôturés de l'organisation, du plus récent au plus ancien. */
export async function chargerChantiersClotures(supabase: SupabaseClient, organizationId: string): Promise<ChantierCloture[]> {
  const { data, error } = await supabase
    .from("action_initiatives")
    .select("id, title, period_type, start_date, end_date, completed_at, closing_snapshot")
    .eq("organization_id", organizationId)
    .eq("status", "completed")
    .order("completed_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Row[]).map((row) => {
    const typePeriode = row.period_type as string;
    return {
      id: row.id as string,
      titre: row.title as string,
      typePeriode: estTypePeriode(typePeriode) ? typePeriode : "quarter",
      periode: { debut: row.start_date as string, fin: row.end_date as string },
      clotureLe: row.completed_at as string,
      photographie: lirePhotographie(row.closing_snapshot),
    };
  });
}

/** Saisit (ou corrige) la valeur observée d'un mois pour l'indicateur personnalisé. */
export async function enregistrerValeurManuelle(
  supabase: SupabaseClient,
  organizationId: string,
  kpiId: string,
  mois: string,
  valeur: number
): Promise<void> {
  const { error } = await supabase
    .from("action_initiative_manual_values")
    .upsert({ organization_id: organizationId, kpi_id: kpiId, month: `${mois}-01`, value: valeur }, { onConflict: "kpi_id,month" });
  if (error) throw error;
}

/** Date de la toute première transaction de l'organisation : début de l'historique disponible. */
export async function chargerPremiereOperation(supabase: SupabaseClient, organizationId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("past_transactions")
    .select("transaction_date")
    .eq("organization_id", organizationId)
    .order("transaction_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return ((data as Row | null)?.transaction_date as string | undefined) ?? null;
}

/** Table du module Action absente : la migration n'a pas encore été exécutée. */
export function estTableAbsente(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42P01" || code === "PGRST205" || code === "PGRST202";
}

export interface DonneesPasseChargees {
  donnees: DonneesPasse;
  // Plusieurs axes analytiques et aucun choisi : le P&L du module Passé n'est pas calculable.
  axeAConfigurer: boolean;
}

/**
 * Les entrées du P&L du module Passé, exactement celles que lit l'onglet Général : transactions
 * de la fenêtre, axe analytique retenu, correspondance P&L, ajustements de gestion (saisis et
 * variations de stock) ; plus le début de l'historique et, si demandé, les situations BFR validées.
 */
export async function chargerDonneesPasse(
  supabase: SupabaseClient,
  organizationId: string,
  fenetre: Periode | null,
  avecBfr: boolean
): Promise<DonneesPasseChargees> {
  const [transactions, axes, axeConfigure, mappings, stocks, ajustements, premiereOperation, situations] = await Promise.all([
    fenetre ? chargerPastTransactions(supabase, organizationId, fenetre) : Promise.resolve([]),
    chargerAxesAnalytiques(supabase, organizationId),
    chargerAxeConfigure(supabase, organizationId),
    chargerMappingsCategories(supabase, organizationId),
    chargerStocks(supabase, organizationId),
    chargerAjustementsGestion(supabase, organizationId),
    chargerPremiereOperation(supabase, organizationId),
    avecBfr ? chargerSituationsValidees(supabase, organizationId) : Promise.resolve([]),
  ]);
  const axe = resoudreAxeAnalytique(axes, axeConfigure);
  return {
    donnees: {
      transactions,
      axeId: axe.axeId,
      mappings: indexerMappings(mappings),
      ajustements: [...ajustements, ...ajustementsDepuisStocks(stocks)],
      premiereOperation,
      situationsBfr: situations.map((s) => ({ date: s.date, bfr: s.bfr })),
    },
    axeAConfigurer: axe.etat === "a_configurer",
  };
}
