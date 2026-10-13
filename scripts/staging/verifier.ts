/**
 * Vérifie la base STAGING après construction et seed — lecture seule (les contrôles RLS tournent
 * dans une transaction systématiquement annulée).
 *
 *   npm run staging:verifier
 *
 * Contrôle :
 *  1. le schéma attendu par le code (colonnes, nullabilité, index, RLS activée) ;
 *  2. la société « QANNT TEST » et son rattachement à l'utilisateur staging ;
 *  3. les RLS : l'utilisateur staging voit et peut modifier ses données, un visiteur anonyme ne
 *     voit rien.
 */
import type { Client } from "pg";
import { connecterStaging, lancer, RefusGardeFou } from "./garde";

interface ColonneAttendue {
  table: string;
  colonne: string;
  nullable: boolean;
}

// Colonnes dont dépendent la synchronisation Pennylane et le rapprochement. Les dates des
// factures et des charges DOIVENT être nullable : une ligne sans date est un cas normal.
const COLONNES: ColonneAttendue[] = [
  { table: "supplier_invoices", colonne: "date_echeance", nullable: true },
  { table: "supplier_invoices", colonne: "date_paiement_prevue", nullable: true },
  { table: "supplier_invoices", colonne: "paid", nullable: false },
  { table: "supplier_invoices", colonne: "paid_at", nullable: true },
  { table: "supplier_invoices", colonne: "pennylane_id", nullable: true },
  { table: "supplier_invoices", colonne: "pennylane_supplier_id", nullable: true },
  { table: "customer_invoices", colonne: "date_echeance", nullable: true },
  { table: "customer_invoices", colonne: "pennylane_id", nullable: true },
  { table: "fixed_charges", colonne: "date_prevue", nullable: true },
  { table: "fixed_charges", colonne: "mode_montant", nullable: false },
  { table: "fixed_charges", colonne: "a_couper", nullable: false },
  { table: "fixed_charge_invoice_links", colonne: "supplier_invoice_id", nullable: true },
  { table: "fixed_charge_invoice_links", colonne: "occurrence_date", nullable: false },
  { table: "fixed_charge_invoice_links", colonne: "status", nullable: false },
  { table: "fixed_charge_supplier_mappings", colonne: "pennylane_supplier_id", nullable: true },
  { table: "fixed_charge_supplier_mappings", colonne: "supplier_name_key", nullable: false },
  { table: "pennylane_connections", colonne: "token_ciphertext", nullable: false },
];

const INDEX = [
  "idx_supplier_invoices_pennylane_id",
  "idx_customer_invoices_pennylane_id",
  "idx_fc_invoice_links_pair",
  "idx_fc_invoice_links_one_per_invoice",
  "idx_fc_invoice_links_one_per_occurrence",
  "idx_fc_supplier_mappings_by_id",
  "idx_fc_supplier_mappings_by_name",
];

const TABLES_RLS = [
  "companies",
  "cash_settings",
  "supplier_invoices",
  "customer_invoices",
  "fixed_charges",
  "fixed_charge_invoice_links",
  "fixed_charge_supplier_mappings",
  "pennylane_connections",
];

let echecs = 0;
function controle(ok: boolean, libelle: string): void {
  console.log(`  ${ok ? "OK " : "KO "} ${libelle}`);
  if (!ok) echecs++;
}

async function verifierSchema(client: Client): Promise<void> {
  console.log("Schéma");
  const { rows } = await client.query(
    "select table_name, column_name, is_nullable from information_schema.columns where table_schema = 'public'"
  );
  const colonnes = new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, row.is_nullable === "YES"]));
  for (const attendue of COLONNES) {
    const cle = `${attendue.table}.${attendue.colonne}`;
    const nullable = colonnes.get(cle);
    controle(nullable === attendue.nullable, `${cle} ${attendue.nullable ? "nullable" : "not null"}${nullable === undefined ? " (colonne absente)" : ""}`);
  }

  const { rows: index } = await client.query("select indexname from pg_indexes where schemaname = 'public'");
  const noms = new Set(index.map((row) => row.indexname as string));
  for (const nom of INDEX) controle(noms.has(nom), `index ${nom}`);

  const { rows: rls } = await client.query(
    "select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'"
  );
  const actives = new Map(rls.map((row) => [row.relname as string, row.relrowsecurity as boolean]));
  for (const table of TABLES_RLS) controle(actives.get(table) === true, `RLS activée sur ${table}`);

  // Un rapprochement confirmé doit survivre à la suppression de sa facture.
  const { rows: fk } = await client.query(
    `select confdeltype from pg_constraint
     where conrelid = 'public.fixed_charge_invoice_links'::regclass
       and confrelid = 'public.supplier_invoices'::regclass and contype = 'f'`
  );
  controle(fk.length === 1 && fk[0].confdeltype === "n", "fixed_charge_invoice_links -> supplier_invoices en ON DELETE SET NULL");
}

/** Compte les lignes visibles sous un rôle donné, dans une transaction toujours annulée. */
async function sousRole<T>(client: Client, role: "authenticated" | "anon", userId: string | null, action: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(userId ? { sub: userId, role } : { role })]);
    await client.query(`set local role ${role}`);
    return await action();
  } finally {
    await client.query("rollback");
  }
}

async function verifierSocieteEtRls(client: Client): Promise<void> {
  console.log("Société et RLS");
  const email = process.env.STAGING_USER_EMAIL;
  if (!email) throw new RefusGardeFou("STAGING_USER_EMAIL est absente de .env.staging.local.");

  const { rows: utilisateurs } = await client.query("select id from auth.users where lower(email) = lower($1)", [email]);
  controle(utilisateurs.length === 1, "utilisateur staging présent dans Supabase Auth");
  if (utilisateurs.length !== 1) return;
  const userId = utilisateurs[0].id as string;

  const { rows: societes } = await client.query("select id, name, access_enabled from public.companies where owner_id = $1", [userId]);
  controle(societes.length === 1 && societes[0].name === "QANNT TEST", "société « QANNT TEST » rattachée à cet utilisateur");
  if (societes.length !== 1) return;
  controle(societes[0].access_enabled === true, "accès activé pour la société staging");
  const companyId = societes[0].id as string;

  const { rows: total } = await client.query("select count(*)::int as n from public.fixed_charges where company_id = $1", [companyId]);
  const nombreCharges = total[0].n as number;

  const vuesParUtilisateur = await sousRole(client, "authenticated", userId, async () => {
    const { rows } = await client.query("select count(*)::int as n from public.fixed_charges");
    return rows[0].n as number;
  });
  controle(vuesParUtilisateur === nombreCharges, `l'utilisateur staging voit ses ${nombreCharges} Charges fixes`);

  const modifiees = await sousRole(client, "authenticated", userId, async () => {
    const { rowCount } = await client.query("update public.fixed_charges set libelle = libelle where company_id = $1", [companyId]);
    return rowCount ?? 0;
  });
  controle(modifiees === nombreCharges, "l'utilisateur staging peut modifier ses Charges fixes (transaction annulée)");

  const liensVisibles = await sousRole(client, "authenticated", userId, async () => {
    await client.query("select count(*) from public.fixed_charge_invoice_links");
    await client.query("select count(*) from public.fixed_charge_supplier_mappings");
    return true;
  }).catch(() => false);
  controle(liensVisibles, "l'utilisateur staging peut lire les tables de rapprochement");

  const tokenInaccessible = await sousRole(client, "authenticated", userId, async () => {
    await client.query("select count(*) from public.pennylane_connections");
    return false;
  }).catch(() => true);
  controle(tokenInaccessible, "pennylane_connections illisible côté utilisateur (credential serveur uniquement)");

  const vuesParAnonyme = await sousRole(client, "anon", null, async () => {
    const { rows } = await client.query("select count(*)::int as n from public.fixed_charges");
    return rows[0].n as number;
  }).catch(() => 0);
  controle(vuesParAnonyme === 0, "un visiteur anonyme ne voit aucune Charge fixe");
}

lancer(async () => {
  const { client, ref } = await connecterStaging();
  try {
    console.log(`Projet ciblé : ${ref}`);
    await verifierSchema(client);
    await verifierSocieteEtRls(client);
  } finally {
    await client.end();
  }
  if (echecs > 0) {
    console.error(`${echecs} contrôle(s) en échec.`);
    process.exitCode = 1;
  } else {
    console.log("Tous les contrôles sont passés.");
  }
});
