// Vérifie la migration 20261030_accounting_pnl.sql sur un Postgres local jetable (PGlite, en mémoire) :
// aucune base distante n'est contactée. PGlite n'est pas une dépendance du projet :
//   PGLITE_PATH=/chemin/vers/node_modules/@electric-sql/pglite/dist/index.js node scripts/migrations/verifierMigrationComptable.mjs
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.env.PGLITE_PATH).href);
const RACINE = path.resolve(import.meta.dirname, "../..");
const MIGRATION = "20261030_accounting_pnl.sql";
const db = new PGlite();
const ok = (m) => console.log(`  ✔ ${m}`);
// gen_random_uuid est natif : l'extension pgcrypto n'existe pas dans PGlite et n'est pas nécessaire ici.
const lire = (f) => readFileSync(path.join(RACINE, f), "utf8").replace(/create extension if not exists "pgcrypto";/gi, "");
process.on("uncaughtException", (e) => {
  console.error(`ÉCHEC : ${String(e.message).slice(0, 400)}`);
  process.exit(1);
});

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;
  create schema auth; grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, created_at timestamptz default now());
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.role() returns text language sql stable as $$ select 'authenticated'::text $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
`);

await db.exec(lire("supabase/schema.sql"));
const migrations = readdirSync(path.join(RACINE, "supabase/migrations")).filter((n) => n.endsWith(".sql")).sort();
const avant = migrations.filter((n) => n < MIGRATION);
for (const nom of avant) {
  try {
    await db.exec(lire(`supabase/migrations/${nom}`));
  } catch (e) {
    throw new Error(`${nom} : ${e.message}`);
  }
}
ok(`${avant.length} migrations existantes appliquées, dans l'ordre`);

// Données historiques, posées AVANT la migration.
const colonnes = async (t) => (await db.query(`select column_name from information_schema.columns where table_name = '${t}' order by 1`)).rows.map((r) => r.column_name);
const compte = async (t) => (await db.query(`select count(*)::int n from ${t}`)).rows[0].n;
const USER = "11111111-1111-1111-1111-111111111111";
const USER2 = "22222222-2222-2222-2222-222222222222";
await db.exec(`insert into auth.users (id, email) values ('${USER}', 'a@test.local'), ('${USER2}', 'b@test.local')`);
const org = (await db.query(`insert into companies (owner_id, name, access_enabled) values ('${USER}', 'A', true) returning id`)).rows[0].id;
const org2 = (await db.query(`insert into companies (owner_id, name, access_enabled) values ('${USER2}', 'B', true) returning id`)).rows[0].id;
await db.query(`insert into organization_modules (organization_id, module_key, enabled) values ($1, 'past', true), ($2, 'past', true)`, [org, org2]);
await db.query(`insert into past_inventory_balances (organization_id, month, ending_inventory_value) values ($1, '2026-01-01', 1000)`, [org]);
await db.query(`insert into past_category_mappings (organization_id, source_category_id, source_category_name, pnl_stage) values ($1, 'c1', 'Ventes', 'revenue')`, [org]);
await db.query(`insert into past_performance_targets (organization_id, target_type, dimension_key, valid_from, target_value) values ($1, 'structure_cost_monthly', '', '2026-01-01', 1000)`, [org]);
await db.exec(`set test.uid = '${USER}'; set role authenticated;`);
const kpi = (position, kpi_key, extra = {}) => ({ position, kpi_key, direction: "up", reference_value: 10, reference_label: "T1", reference_origin: "previous", reference_start: "2026-01-01", reference_end: "2026-03-31", target_value: 20, ...extra });
const chantierAncien = (await db.query(`select action_lancer_chantier($1, 'Ancien', 'x', 'month', '2026-04-01', '2026-04-30', $2::jsonb) id`, [org, JSON.stringify([kpi(1, "marge_brute"), kpi(2, "ebitda"), kpi(3, "encaissements")])])).rows[0].id;
await db.exec(`reset role;`);

const tablesSuivies = ["companies", "past_inventory_balances", "past_category_mappings", "past_performance_targets", "action_initiatives", "action_initiative_kpis"];
const instantane = {};
for (const t of tablesSuivies) instantane[t] = { colonnes: await colonnes(t), lignes: (await db.query(`select to_jsonb(x) j from ${t} x order by 1`)).rows };

// La migration, deux fois : idempotente.
await db.exec(lire(`supabase/migrations/${MIGRATION}`));
await db.exec(lire(`supabase/migrations/${MIGRATION}`));
ok("migration appliquée deux fois sans erreur (idempotente)");

for (const t of tablesSuivies) {
  const apres = await colonnes(t);
  for (const c of instantane[t].colonnes) assert.ok(apres.includes(c), `colonne ${t}.${c} perdue`);
  const lignes = (await db.query(`select to_jsonb(x) j from ${t} x order by 1`)).rows;
  assert.equal(lignes.length, instantane[t].lignes.length, `${t} : lignes perdues`);
  instantane[t].lignes.forEach((l, i) => {
    for (const [k, v] of Object.entries(l.j)) assert.deepEqual(lignes[i].j[k], v, `${t}.${k} modifié`);
  });
}
ok("données historiques intactes : aucune colonne perdue, aucune valeur modifiée");

const { rows: anciens } = await db.query(`select kpi_source, kpi_definition from action_initiative_kpis`);
assert.ok(anciens.every((r) => r.kpi_source === null && r.kpi_definition === null));
assert.equal((await db.query(`select kpi_source from past_performance_targets`)).rows[0].kpi_source, null);
ok("KPI et objectifs existants : source NULL, définition d'origine conservée, aucune conversion");

const sqlExecutable = lire(`supabase/migrations/${MIGRATION}`).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
assert.doesNotMatch(sqlExecutable, /drop\s+(table|column)|truncate|delete\s+from|\bupdate\s+\w+\s+set/i);
ok("le fichier ne contient ni DROP TABLE/COLUMN, ni TRUNCATE, ni DELETE, ni UPDATE de données");

// Écritures de service (route serveur).
await db.exec(`set role service_role;`);
await db.query(`insert into accounting_mapping_rules (organization_id, account_prefix, pnl_line, category_label, updated_by) values ($1, '70', 'revenue', 'Ventes', '${USER}')`, [org]);
await db.query(`update accounting_mapping_rules set pnl_line = 'structure_costs', updated_by = '${USER}' where organization_id = $1`, [org]);
await db.query(`update accounting_mapping_rules set pnl_line = 'revenue' where organization_id = $1`, [org]);
await db.query(`delete from accounting_mapping_rules where organization_id = $1`, [org]);
await db.query(`insert into accounting_mapping_rules (organization_id, account_prefix, pnl_line, category_label) values ($1, '70', 'revenue', 'Ventes')`, [org]);
const RUN = "33333333-3333-3333-3333-333333333333";
const ligne = (o, id, compte, date, debit, credit, exclu = null) => db.query(`insert into accounting_entry_lines (organization_id, source, source_line_id, account_number, entry_date, debit, credit, sync_run, excluded_at) values ($1, 'fixtures', $2, $3, $4, $5, $6, '${RUN}', $7)`, [o, id, compte, date, debit, credit, exclu]);
await ligne(org, "1", "706000", "2026-03-10", 0, 100.1);
await ligne(org, "2", "706000", "2026-03-20", 0, 200.2);
await ligne(org, "3", "706000", "2026-04-01", 0, 999);
await ligne(org, "4", "607000", "2026-03-20", 50, 0, "2026-04-01");
await ligne(org2, "1", "706000", "2026-03-10", 0, 7777);
const soldes = (await db.query(`select * from accounting_balances($1, '2026-03-01', '2026-03-31')`, [org])).rows;
assert.equal(soldes.length, 1);
assert.equal(Number(soldes[0].credit), 300.3);
assert.equal(Number(soldes[0].lines), 2);
assert.equal(soldes[0].month, "2026-03");
ok("accounting_balances : cumuls exacts, période respectée, lignes écartées ignorées, autre société invisible");
const journal = (await db.query(`select operation, previous_line, new_line, changed_by from accounting_mapping_rule_history where organization_id = $1 order by changed_at, id`, [org])).rows;
const operations = journal.map((j) => j.operation).sort();
assert.deepEqual(operations, ["delete", "insert", "insert", "update", "update"]);
assert.ok(journal.some((j) => j.changed_by === USER && j.operation === "update"));
ok("journal des règles : création, modification, suppression et auteur tracés");
await assert.rejects(db.query(`insert into accounting_mapping_rules (organization_id, account_prefix, pnl_line, category_label) values ($1, '411', 'revenue', 'x')`, [org]));
await assert.rejects(db.query(`insert into accounting_mapping_rules (organization_id, account_prefix, pnl_line, category_label) values ($1, '71', 'inconnue', 'x')`, [org]));
await assert.rejects(db.query(`insert into accounting_mapping_rules (organization_id, account_prefix, pnl_line, category_label) values ($1, '70', 'revenue', 'x')`, [org]));
ok("contraintes : pas de racine de bilan, pas de ligne inconnue, une racine par société");
await assert.rejects(ligne(org, "1", "706000", "2026-03-10", 0, 1));
ok("une ligne source n'existe qu'une fois : pas de double import");
await db.exec(`reset role;`);

// Le navigateur (rôles anon et authenticated) ne lit ni n'écrit rien de comptable, y compris sa société.
const tables = ["accounting_mapping_rules", "accounting_mapping_rule_history", "accounting_accounts", "accounting_entry_lines", "accounting_settings", "accounting_sync_state"];
for (const role of ["anon", "authenticated"]) {
  await db.exec(`set test.uid = '${USER}'; set role ${role};`);
  for (const t of tables) {
    await assert.rejects(db.query(`select * from ${t}`), /permission denied/, `${role} lit ${t}`);
    await assert.rejects(db.query(`delete from ${t}`), /permission denied/, `${role} efface ${t}`);
  }
  await assert.rejects(db.query(`select * from accounting_balances($1, '2026-01-01', '2026-12-31')`, [org]), /permission denied/);
  await db.exec(`reset role;`);
}
ok("anon et authenticated : aucune lecture, écriture ni fonction comptable accessibles");

// Action : ancien appel inchangé, nouvel appel persisté.
await db.exec(`set test.uid = '${USER}'; set role authenticated;`);
await db.query(`update action_initiatives set status = 'completed', completed_at = now(), closing_snapshot = '{"version":1}' where id = $1`, [chantierAncien]);
const definition = { source: "comptable", libelle: "Résultat net" };
const nouveau = (await db.query(`select action_lancer_chantier($1, 'Nouveau', 'x', 'month', '2026-05-01', '2026-05-31', $2::jsonb) id`, [org, JSON.stringify([kpi(1, "compta_resultat_net", { kpi_source: "comptable", kpi_definition: definition }), kpi(2, "ebitda"), kpi(3, "encaissements", { kpi_source: "cash_estime" })])])).rows[0].id;
const persistes = (await db.query(`select kpi_key, kpi_source, kpi_definition from action_initiative_kpis where initiative_id = $1 order by position`, [nouveau])).rows;
assert.deepEqual(persistes[0], { kpi_key: "compta_resultat_net", kpi_source: "comptable", kpi_definition: definition });
assert.equal(persistes[1].kpi_source, null);
await assert.rejects(db.query(`select action_lancer_chantier($1, 'Autre', 'x', 'month', '2026-06-01', '2026-06-30', $2::jsonb)`, [org, JSON.stringify([kpi(1, "ebitda")])]), /3 indicateurs/);
await db.exec(`reset role;`);
ok("Action : ancienne forme acceptée, source et définition persistées, règle des 3 KPI conservée");
await db.exec(`set test.uid = '${USER2}'; set role authenticated;`);
assert.equal((await db.query(`select count(*)::int n from action_initiative_kpis where organization_id = $1`, [org])).rows[0].n, 0);
await db.exec(`reset role;`);
ok("isolation : une société ne voit pas les KPI d'une autre");

// Suppression d'une société : la cascade passe, le trigger de journal ne la bloque pas.
await db.query(`delete from past_inventory_balances where organization_id = $1`, [org2]);
await db.query(`insert into accounting_mapping_rules (organization_id, account_prefix, pnl_line, category_label) values ($1, '70', 'revenue', 'V')`, [org2]);
await db.query(`delete from companies where id = $1`, [org2]);
assert.equal((await db.query(`select count(*)::int n from accounting_entry_lines where organization_id = $1`, [org2])).rows[0].n, 0);
assert.equal((await db.query(`select count(*)::int n from accounting_mapping_rule_history where organization_id = $1`, [org2])).rows[0].n, 0);
ok("suppression d'une société : cascade complète, sans blocage du journal");

const plan = await db.query(`explain select account_number from accounting_entry_lines where organization_id = '${org}' and entry_date between '2026-01-01' and '2026-12-31'`);
console.log("  plan :", plan.rows[0]["QUERY PLAN"]);
console.log("\nMigration vérifiée.");
await db.close();
