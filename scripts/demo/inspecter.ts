// LECTURE SEULE : à quoi correspond l'identifiant fourni, et que contient déjà le compte.
import { clientAdmin } from "./connexion";

async function main() {
const ID = process.argv[2];
const { admin, ref } = clientAdmin();
console.log("projet Supabase :", ref);
const { data: u, error: eu } = await admin.auth.admin.getUserById(ID);
console.log("auth.users :", eu ? `aucun (${eu.message})` : { id: u.user.id, email: u.user.email, cree: u.user.created_at });
const colonnes = "id, name, owner_id, plan, plan_override, plan_override_until, access_enabled, subscription_status, created_at";
const { data: parId } = await admin.from("companies").select(colonnes).eq("id", ID);
const { data: parProprietaire } = await admin.from("companies").select(colonnes).eq("owner_id", ID);
console.log("companies où id = identifiant :", parId);
console.log("companies où owner_id = identifiant :", parProprietaire);
const societes = [...(parId ?? []), ...(parProprietaire ?? [])];
for (const s of societes) {
  console.log(`\n=== société ${s.id} ===`);
  for (const [table, col] of [
    ["cash_settings", "company_id"],
    ["customer_invoices", "company_id"],
    ["supplier_invoices", "company_id"],
    ["fixed_charges", "company_id"],
    ["other_expenses", "company_id"],
    ["financings", "company_id"],
    ["recurring_incomes", "company_id"],
    ["forecast_customer_invoices", "company_id"],
    ["forecast_event_assumptions", "company_id"],
    ["forecast_payment_profiles", "company_id"],
    ["past_bfr_invoices", "organization_id"],
    ["organization_modules", "organization_id"],
    ["pennylane_connections", "company_id"],
  ] as const) {
    const { count, error } = await admin.from(table).select("*", { count: "exact", head: true }).eq(col, s.id);
    console.log(`${table.padEnd(28)} ${error ? `erreur ${error.code} ${error.message}` : count}`);
  }
  const { data: cs } = await admin.from("cash_settings").select("*").eq("company_id", s.id);
  console.log("cash_settings :", cs);
  const { data: mods } = await admin.from("organization_modules").select("*").eq("organization_id", s.id);
  console.log("organization_modules :", mods);
}
}
main().catch((e) => { console.error(e); process.exit(1); });
