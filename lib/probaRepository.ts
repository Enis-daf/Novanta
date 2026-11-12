import type { SupabaseClient } from "@supabase/supabase-js";
import { DIMENSIONS, estFiabilite, estProbabilite, estSourceFlux, hypotheseParDefaut, HypotheseLigne, lireConditionSaisie } from "./probaEvenements";
import { FacturePayeeFutur } from "./probaHistorique";
import { ProfilPaiement } from "./probaCalibration";

/**
 * Accès Supabase de la prévision probabiliste (supabase/migrations/20261112_forecast_probabilistic.sql,
 * 20261113_forecast_assumption_dimensions.sql).
 * Toutes les lectures et écritures sont bornées à la société passée par la route, toujours dérivée
 * de l'utilisateur connecté.
 */

type Row = Record<string, unknown>;

/** Table absente (migration pas encore passée) : la fonctionnalité dégrade sans casser. */
export function estTableAbsente(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

const COLONNES_HYPOTHESES = "source_type, source_id, probability, date_reliability, parent_source_type, parent_source_id";
const COLONNES_DIMENSIONS = "amount_reliability, target_amount, activation_condition";

/** Colonne absente (migration 20261113 pas encore passée). */
export function estColonneAbsente(error: { code?: string } | null): boolean {
  return error?.code === "42703" || error?.code === "PGRST204";
}

/** Lit une ligne stockée ; une valeur douteuse est ignorée (jamais une hypothèse inventée). */
export function versHypothese(row: Row): HypotheseLigne | null {
  if (!estSourceFlux(row.source_type) || typeof row.source_id !== "string") return null;
  if (!estProbabilite(row.probability) || !estFiabilite(row.date_reliability)) return null;
  const source = row.source_type;
  // Ancien format : parent_source_* = condition « evenement ».
  const conditionLegacy =
    estSourceFlux(row.parent_source_type) && typeof row.parent_source_id === "string"
      ? { type: "evenement", source: row.parent_source_type, sourceId: row.parent_source_id }
      : null;
  const fiabiliteMontant = DIMENSIONS[source].montant && estFiabilite(row.amount_reliability) ? row.amount_reliability : null;
  const cible = row.target_amount === null || row.target_amount === undefined ? null : Number(row.target_amount);
  return {
    source,
    sourceId: row.source_id,
    probabilite: row.probability,
    fiabiliteDate: row.date_reliability,
    fiabiliteMontant,
    montantCible: source === "rentree_reguliere" && cible !== null && Number.isFinite(cible) && cible > 0 ? cible : null,
    condition: lireConditionSaisie(row.activation_condition ?? conditionLegacy),
  };
}

export async function chargerHypotheses(supabase: SupabaseClient, companyId: string): Promise<HypotheseLigne[]> {
  const lire = (colonnes: string) => supabase.from("forecast_event_assumptions").select(colonnes).eq("company_id", companyId);
  let reponse = await lire(`${COLONNES_HYPOTHESES}, ${COLONNES_DIMENSIONS}`);
  if (reponse.error && estColonneAbsente(reponse.error)) reponse = await lire(COLONNES_HYPOTHESES);
  const { data, error } = reponse;
  if (error) {
    if (estTableAbsente(error)) return [];
    throw error;
  }
  return ((data ?? []) as unknown as Row[]).map(versHypothese).filter((h): h is HypotheseLigne => h !== null);
}

/**
 * Enregistre une hypothèse. Pour une ligne « À renseigner » par défaut, la ligne stockée vaut
 * validation : elle est toujours conservée. Pour les autres, revenir aux valeurs par défaut la
 * supprime.
 */
export async function enregistrerHypothese(supabase: SupabaseClient, companyId: string, h: HypotheseLigne): Promise<void> {
  const defaut = hypotheseParDefaut(h.source);
  const estDefaut =
    !DIMENSIONS[h.source].aRenseignerParDefaut &&
    h.probabilite === defaut.probabilite &&
    h.fiabiliteDate === defaut.fiabiliteDate &&
    (h.fiabiliteMontant ?? 100) === 100 &&
    h.montantCible === null &&
    h.condition === null;
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
      amount_reliability: h.fiabiliteMontant,
      target_amount: h.montantCible,
      activation_condition: h.condition,
      parent_source_type: null,
      parent_source_id: null,
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
