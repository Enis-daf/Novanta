import type { SupabaseClient } from "@supabase/supabase-js";
import {
  rowToAutreDepense,
  rowToChargeFixe,
  rowToFactureClient,
  rowToFactureFournisseur,
  rowToFacturePrevisionnelle,
  rowToFinancement,
  rowToLienRapprochement,
  rowToRentreeReguliere,
} from "../../lib/supabaseRepository";
import { resoudreRemplacements } from "../../lib/rapprochementChargesFixes";
import { ajouterJours, parseDateISO } from "../../lib/dates";

/** Données Futur d'UNE société, lues et converties exactement comme le cockpit (lecture seule). */
export async function chargerFutur(admin: SupabaseClient, companyId: string) {
  const lire = async (table: string) => {
    const { data, error } = await admin.from(table).select("*").eq("company_id", companyId);
    if (error) {
      if (error.code === "42P01" || error.code === "PGRST205") return [];
      throw error;
    }
    return (data ?? []) as Record<string, unknown>[];
  };
  const { data: cs, error } = await admin.from("cash_settings").select("solde_initial, date_releve, horizon_jours").eq("company_id", companyId).maybeSingle();
  if (error) throw error;
  const [c, f, ch, d, fi, r, liens, p] = await Promise.all(
    ["customer_invoices", "supplier_invoices", "fixed_charges", "other_expenses", "financings", "recurring_income", "fixed_charge_invoice_links", "forecast_customer_invoices"].map(lire)
  );
  const donnees = {
    soldeInitial: Number(cs?.solde_initial ?? 0),
    dateReleve: String(cs?.date_releve ?? ""),
    horizonJours: Number(cs?.horizon_jours ?? 90),
    facturesClients: c.map(rowToFactureClient),
    facturesFournisseurs: f.map(rowToFactureFournisseur),
    chargesFixes: ch.map(rowToChargeFixe),
    autresDepenses: d.map(rowToAutreDepense),
    financements: fi.map(rowToFinancement),
    rentreesRegulieres: r.map(rowToRentreeReguliere),
    liensRapprochement: liens.map(rowToLienRapprochement),
    facturesPrevisionnelles: p.map(rowToFacturePrevisionnelle),
  };
  const remplacements = resoudreRemplacements(
    donnees.liensRapprochement,
    donnees.chargesFixes,
    donnees.facturesFournisseurs,
    ajouterJours(parseDateISO(donnees.dateReleve || "2026-01-01"), donnees.horizonJours)
  ).remplacements;
  return { ...donnees, remplacements };
}
