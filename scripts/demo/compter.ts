// LECTURE SEULE : nombre de lignes par table pour la société démo (contrôle d'idempotence).
import { clientAdmin } from "./connexion";
import { SOCIETE } from "./seedPilotage";
async function main() {
  const { admin } = clientAdmin();
  for (const t of ["customer_invoices", "supplier_invoices", "fixed_charges", "other_expenses", "financings", "recurring_income", "forecast_customer_invoices", "forecast_event_assumptions"]) {
    const { count } = await admin.from(t).select("*", { count: "exact", head: true }).eq("company_id", SOCIETE);
    console.log(`${t.padEnd(28)} ${count}`);
  }
  const { count: autres } = await admin.from("companies").select("*", { count: "exact", head: true }).neq("id", SOCIETE);
  console.log(`(autres sociétés présentes : ${autres} — aucune n'est lue ni écrite par les scripts)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
