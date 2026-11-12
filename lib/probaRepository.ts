import type { SupabaseClient } from "@supabase/supabase-js";
import { estFiabilite, estProbabilite, estSourceFlux, hypotheseParDefaut, HypotheseLigne } from "./probaEvenements";
import { FacturePayeeFutur } from "./probaHistorique";
import { ProfilPaiement } from "./probaCalibration";

/**
 * Accès Supabase de la prévision probabiliste (supabase/migrations/20261112_forecast_probabilistic.sql).
 * Toutes les lectures et écritures sont bornées à la société passée par la route, toujours dérivée
 * de l'utilisateur connecté.
 */

type Row = Record<string, unknown>;

/** Table absente (migration pas encore passée) : la fonctionnalité dégrade sans casser. */
export function estTableAbsente(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

export async function chargerHypotheses(supabase: SupabaseClient, companyId: string): Promise<HypotheseLigne[]> {
  const { data, error } = await supabase
    .from("forecast_event_assumptions")
    .select("source_type, source_id, probability, date_reliability, parent_source_type, parent_source_id")
    .eq("company_id", companyId);
  if (error) {
    if (estTableAbsente(error)) return [];
    throw error;
  }
  const hypotheses: HypotheseLigne[] = [];
  for (const row of (data ?? []) as Row[]) {
    if (!estSourceFlux(row.source_type) || typeof row.source_id !== "string") continue;
    if (!estProbabilite(row.probability) || !estFiabilite(row.date_reliability)) continue;
    hypotheses.push({
      source: row.source_type,
      sourceId: row.source_id,
      probabilite: row.probability,
      fiabiliteDate: row.date_reliability,
      parentSource: estSourceFlux(row.parent_source_type) ? row.parent_source_type : null,
      parentSourceId: typeof row.parent_source_id === "string" ? row.parent_source_id : null,
    });
  }
  return hypotheses;
}

/** Enregistre une hypothèse ; revenir aux valeurs par défaut sans dépendance supprime la ligne. */
export async function enregistrerHypothese(supabase: SupabaseClient, companyId: string, h: HypotheseLigne): Promise<void> {
  const defaut = hypotheseParDefaut(h.source);
  const estDefaut = h.probabilite === defaut.probabilite && h.fiabiliteDate === defaut.fiabiliteDate && h.parentSource === null;
  if (estDefaut) {
    const { error } = await supabase.from("forecast_event_assumptions").delete().eq("company_id", companyId).eq("source_type", h.source).eq("source_id", h.sourceId);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from("forecast_event_assumptions").upsert(
    {
      company_id: companyId,
      source_type: h.source,
      source_id: h.sourceId,
      probability: h.probabilite,
      date_reliability: h.fiabiliteDate,
      parent_source_type: h.parentSource,
      parent_source_id: h.parentSourceId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "company_id,source_type,source_id" }
  );
  if (error) throw error;
}

/** Factures de Futur payées dont le règlement réel est connu (historique des retards). */
export async function chargerFacturesPayeesFutur(
  supabase: SupabaseClient,
  companyId: string
): Promise<{ clients: FacturePayeeFutur[]; fournisseurs: FacturePayeeFutur[] }> {
  const lire = async (table: string, colonneTiers: string): Promise<FacturePayeeFutur[]> => {
    const { data, error } = await supabase
      .from(table)
      .select(`${colonneTiers}, montant, date_echeance, settled_on, pennylane_id`)
      .eq("company_id", companyId)
      .eq("paid", true)
      .not("settled_on", "is", null);
    if (error) throw error;
    return ((data ?? []) as unknown as Row[]).map((row) => ({
      tiers: String(row[colonneTiers] ?? ""),
      montant: Number(row.montant),
      dateEcheance: (row.date_echeance as string | null) ?? null,
      settledOn: (row.settled_on as string | null) ?? null,
      pennylaneId: (row.pennylane_id as string | null) ?? null,
    }));
  };
  const [clients, fournisseurs] = await Promise.all([lire("customer_invoices", "client"), lire("supplier_invoices", "fournisseur")]);
  return { clients, fournisseurs };
}

const VERS_BASE = { client: "customer", fournisseur: "supplier" } as const;

/**
 * Enregistre le profil de paiement s'il a changé (empreinte de l'historique) : chaque nouveau
 * règlement rapproché recalibre le profil à la prévision suivante. Client admin (écriture serveur).
 */
export async function enregistrerProfilSiChange(admin: SupabaseClient, companyId: string, profil: ProfilPaiement): Promise<"inchange" | "enregistre" | "table_absente"> {
  const side = VERS_BASE[profil.cote];
  const { data, error } = await admin.from("forecast_payment_profiles").select("fingerprint").eq("company_id", companyId).eq("side", side).maybeSingle();
  if (error) {
    if (estTableAbsente(error)) return "table_absente";
    throw error;
  }
  if (data && (data as Row).fingerprint === profil.empreinte) return "inchange";
  const { error: erreurEcriture } = await admin.from("forecast_payment_profiles").upsert(
    {
      company_id: companyId,
      side,
      invoice_count: profil.nombreFactures,
      confidence: profil.confiance.score,
      stats: profil.statistiques,
      segments: profil.segments,
      customers: profil.clients,
      outliers: profil.valeursExtremes,
      fingerprint: profil.empreinte,
      computed_at: new Date().toISOString(),
    },
    { onConflict: "company_id,side" }
  );
  if (erreurEcriture) throw erreurEcriture;
  return "enregistre";
}
