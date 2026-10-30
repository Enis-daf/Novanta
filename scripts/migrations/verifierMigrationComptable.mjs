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

// --- 20261031 : soldes mensuels ---
const MIGRATION_SOLDES = "20261031_accounting_monthly_balances.sql";
const comptesAvant = (await db.query(`select count(*)::int n from accounting_accounts`)).rows[0].n;
await db.query(`insert into accounting_accounts (organization_id, account_number, source) values ($1, '706000', 'fixtures')`, [org]);
await db.exec(lire(`supabase/migrations/${MIGRATION_SOLDES}`));
await db.exec(lire(`supabase/migrations/${MIGRATION_SOLDES}`));
assert.equal((await db.query(`select count(*)::int n from accounting_accounts`)).rows[0].n, comptesAvant + 1);
ok("20261031 appliquée deux fois, sur une table de comptes déjà remplie, sans perte");
const sqlSoldes = lire(`supabase/migrations/${MIGRATION_SOLDES}`).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
assert.doesNotMatch(sqlSoldes, /drop\s+(table|column)|truncate|delete\s+from|\bupdate\s+\w+\s+set/i);
ok("20261031 : ni DROP de table ou de colonne, ni DELETE, ni UPDATE");
await db.exec(`set role service_role;`);
await db.query(`insert into accounting_accounts (organization_id, account_number, source) values ($1, '401ABCDEF', 'fixtures')`, [org]);
await assert.rejects(db.query(`insert into accounting_accounts (organization_id, account_number, source) values ($1, 'ABC', 'fixtures')`, [org]));
ok("numéro alphanumérique accepté, numéro sans racine en chiffres refusé");
const solde = (m, n, d, c) => db.query(`insert into accounting_monthly_balances (organization_id, source, month, account_number, debit, credit, sync_run) values ($1, 'fixtures', $2, $3, $4, $5, '${RUN}')`, [org, m, n, d, c]);
await solde("2026-03-01", "706000", 0, 100.1);
await assert.rejects(solde("2026-03-01", "706000", 0, 1));
await assert.rejects(solde("2026-03-15", "706001", 0, 1));
ok("un compte par mois, un mois commence le 1er");
await db.exec(`reset role;`);
for (const role of ["anon", "authenticated"]) {
  await db.exec(`set test.uid = '${USER}'; set role ${role};`);
  await assert.rejects(db.query(`select * from accounting_monthly_balances`), /permission denied/);
  await db.exec(`reset role;`);
}
ok("anon et authenticated : aucun accès aux soldes mensuels");

// --- 20261101 : synchronisation et ajustements ---
const MIGRATION_SYNC = "20261101_accounting_sync_runs_adjustments.sql";
await db.exec(lire(`supabase/migrations/${MIGRATION_SYNC}`));
await db.exec(lire(`supabase/migrations/${MIGRATION_SYNC}`));
ok("20261101 appliquée deux fois sans erreur");
const sqlSync = lire(`supabase/migrations/${MIGRATION_SYNC}`).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
assert.doesNotMatch(sqlSync, /drop\s+(table|column)|truncate|delete\s+from/i);
ok("20261101 : ni DROP de table ou de colonne, ni DELETE");
await db.exec(`set role service_role;`);
const commencer = async (o, stale = 600) => (await db.query(`select accounting_sync_begin($1, 'fixtures', 'manuel', $2) id`, [o, stale])).rows[0].id;
const run1 = await commencer(org);
assert.ok(run1);
assert.equal(await commencer(org), null);
ok("verrou : une seule synchronisation en cours par société");
await db.query(`update accounting_sync_runs set started_at = now() - interval '1 hour' where id = $1`, [run1]);
const run2 = await commencer(org);
assert.ok(run2);
assert.equal((await db.query(`select status from accounting_sync_runs where id = $1`, [run1])).rows[0].status, "abandoned");
ok("reprise : une exécution interrompue est abandonnée, et n'empêche plus de relancer");
const org3 = (await db.query(`insert into companies (owner_id, name, access_enabled) values ('${USER2}', 'C', true) returning id`)).rows[0].id;
assert.ok(await commencer(org3));
ok("verrou par société : l'autre société reste libre");
const remplacer = (o, m, run, lignes) => db.query(`select accounting_replace_month_balance($1, 'fixtures', $2, $3, $4::jsonb) n`, [o, m, run, JSON.stringify(lignes)]);
const lire2 = async (o, m) => (await db.query(`select account_number, credit::float8 credit from accounting_monthly_balances where organization_id = $1 and month = $2 and excluded_at is null order by 1`, [o, m])).rows;
const RUNA = "44444444-4444-4444-4444-444444444444";
const RUNB = "55555555-5555-5555-5555-555555555555";
await remplacer(org, "2026-05-01", RUNA, [{ account_number: "706000", account_label: "V", debit: 0, credit: 100 }, { account_number: "707000", account_label: "M", debit: 0, credit: 50 }]);
await remplacer(org, "2026-05-01", RUNB, [{ account_number: "706000", account_label: "V", debit: 0, credit: 120 }]);
assert.deepEqual(await lire2(org, "2026-05-01"), [{ account_number: "706000", credit: 120 }]);
ok("remplacement : une relecture remplace, n'additionne pas ; un compte disparu est écarté");
assert.equal((await db.query(`select count(*)::int n from accounting_monthly_balances where organization_id = $1 and month = '2026-05-01'`, [org])).rows[0].n, 2);
ok("le compte écarté reste en base : rien n'est supprimé");
await remplacer(org, "2026-05-01", RUNA, [{ account_number: "707000", account_label: "M", debit: 0, credit: 60 }]);
assert.deepEqual(await lire2(org, "2026-05-01"), [{ account_number: "707000", credit: 60 }]);
ok("un compte revenu est rétabli");
await assert.rejects(remplacer(org, "2026-05-01", RUNB, [{ account_number: "706000", debit: 0, credit: 999 }, { account_number: "ABC", debit: 0, credit: 1 }]));
assert.deepEqual(await lire2(org, "2026-05-01"), [{ account_number: "707000", credit: 60 }]);
ok("atomique : un échec en cours de remplacement laisse le mois précédent intact");
await remplacer(org3, "2026-05-01", RUNA, [{ account_number: "706000", debit: 0, credit: 7 }]);
assert.deepEqual(await lire2(org, "2026-05-01"), [{ account_number: "707000", credit: 60 }]);
ok("isolation : remplacer une société ne touche pas l'autre");
await assert.rejects(db.query(`insert into accounting_management_adjustments (organization_id, adjustment_date, pnl_line, label, amount) values ($1, '2026-03-31', 'inventory_variation', 'x', 1)`, [org]));
const ajust = (await db.query(`insert into accounting_management_adjustments (organization_id, adjustment_date, pnl_line, label, amount, updated_by) values ($1, '2026-03-31', 'depreciation', 'Amortissement', -100, '${USER}') returning id`, [org])).rows[0].id;
await db.query(`update accounting_management_adjustments set amount = -120 where id = $1`, [ajust]);
const hist = (await db.query(`select operation, previous->>'amount' avant from accounting_management_adjustment_history where adjustment_id = $1 order by changed_at, operation`, [ajust])).rows;
assert.deepEqual(hist.map((h) => h.operation).sort(), ["insert", "update"]);
assert.equal(Number(hist.find((h) => h.operation === "update").avant), -100);
ok("ajustements : pas de stock ici, modifications journalisées avec la valeur précédente");
await db.query(`insert into accounting_inventory_source_choices (organization_id, scope_start, scope_end, source, chosen_by) values ($1, '2026-01-01', '2026-12-31', 'novanta', '${USER}'), ($1, '2026-01-01', '2026-12-31', 'pennylane', '${USER}')`, [org]);
assert.equal((await db.query(`select count(*)::int n from accounting_inventory_source_choices where organization_id = $1`, [org])).rows[0].n, 2);
ok("arbitrages : ajoutés, jamais remplacés");
await db.query(`insert into accounting_fiscal_years (organization_id, source, source_fiscal_year_id, start_date, finish_date, status) values ($1, 'fixtures', '1', '2026-01-01', '2026-12-31', 'open') on conflict (organization_id, source, source_fiscal_year_id) do update set status = excluded.status`, [org]);
await db.exec(`reset role;`);
for (const role of ["anon", "authenticated"]) {
  await db.exec(`set test.uid = '${USER}'; set role ${role};`);
  for (const t of ["accounting_fiscal_years", "accounting_sync_runs", "accounting_inventory_source_choices", "accounting_management_adjustments", "accounting_management_adjustment_history"]) {
    await assert.rejects(db.query(`select * from ${t}`), /permission denied/, `${role} lit ${t}`);
  }
  await assert.rejects(db.query(`select accounting_sync_begin($1, 'fixtures', 'manuel', 600)`, [org]), /permission denied/);
  await assert.rejects(db.query(`select accounting_replace_month_balance($1, 'fixtures', '2026-05-01', $2, '[]'::jsonb)`, [org, RUNA]), /permission denied/);
  await db.exec(`reset role;`);
}
ok("anon et authenticated : aucun accès aux nouvelles tables ni aux fonctions");

// --- 20261102 : import FEC, source unique ---
const MIGRATION_FEC = "20261102_accounting_fec_imports.sql";
const comptesAvantFec = (await db.query(`select count(*)::int n from accounting_monthly_balances`)).rows[0].n;
await db.exec(lire(`supabase/migrations/${MIGRATION_FEC}`));
await db.exec(lire(`supabase/migrations/${MIGRATION_FEC}`));
assert.equal((await db.query(`select count(*)::int n from accounting_monthly_balances`)).rows[0].n, comptesAvantFec);
ok("20261102 appliquée deux fois, balances API existantes intactes");
const sqlFec = lire(`supabase/migrations/${MIGRATION_FEC}`).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
assert.doesNotMatch(sqlFec, /drop\s+(table|column)|truncate|delete\s+from/i);
ok("20261102 : ni DROP de table ou de colonne, ni DELETE");
await db.exec(`set role service_role;`);
const nouvelleSociete = async (nom) => {
  const proprietaire = (await db.query(`insert into auth.users (email) values ($1) returning id`, [`${nom}@test.local`])).rows[0].id;
  return (await db.query(`insert into companies (owner_id, name, access_enabled) values ($1, $2, true) returning id`, [proprietaire, nom])).rows[0].id;
};
await db.exec(`reset role;`);
const orgFec = await nouvelleSociete("fec1");
const orgFec2 = await nouvelleSociete("fec2");
await db.exec(`set role service_role;`);
const lignesFec = (facteur = 1) => [["2024-01", "706000", 0, 100 * facteur, 2], ["2024-01", "411000", 100 * facteur, 0, 2], ["2024-12", "681120", 24, 0, 1], ["2024-12", "281000", 0, 24, 1]];
const importer = async (o, empreinte, debut, fin, lignes, remplacer = false) => (await db.query(`select accounting_fec_import($1, 'FEC.txt', $2, $3, $4, true, '{}'::jsonb, $5::jsonb, '{"706000":"Ventes"}'::jsonb, $6, '${USER}') r`, [o, empreinte, debut, fin, JSON.stringify(lignes), remplacer])).rows[0].r;
const soldesFec = async (o) => (await db.query(`select account_number c, to_char(month,'YYYY-MM') m, credit::float8 cr, debit::float8 d from accounting_monthly_balances where organization_id = $1 and source = 'fec' and excluded_at is null order by 2,1`, [o])).rows;
const premier = await importer(orgFec, "e1", "2024-01-01", "2024-12-31", lignesFec());
assert.equal(premier.statut, "importe");
assert.equal((await soldesFec(orgFec)).length, 4);
ok("import : balances enregistrées, source fec");
assert.equal((await db.query(`select label from accounting_accounts where organization_id = $1 and account_number = '706000'`, [orgFec])).rows[0].label, "Ventes");
ok("plan de comptes alimenté par le FEC");
const memeContenu = await importer(orgFec, "e1", "2024-01-01", "2024-12-31", lignesFec());
assert.equal(memeContenu.statut, "identique");
assert.equal(memeContenu.import_id, premier.import_id);
assert.equal((await soldesFec(orgFec)).find((s) => s.c === "706000").cr, 100);
ok("même contenu réimporté : rien d'ajouté, rien d'additionné");
const autre = await importer(orgFec, "e2", "2024-06-01", "2025-05-31", [["2024-06", "706000", 0, 5, 1], ["2024-06", "411000", 5, 0, 1]]);
assert.equal(autre.statut, "chevauchement");
assert.equal(autre.chevauchements[0].fichier, "FEC.txt");
assert.equal((await soldesFec(orgFec)).length, 4);
ok("chevauchement sans demande explicite : refusé, rien de modifié");
const remplace = await importer(orgFec, "e3", "2024-01-01", "2024-12-31", lignesFec(2).slice(0, 2), true);
assert.equal(remplace.statut, "importe");
const apres = await soldesFec(orgFec);
assert.deepEqual(apres.map((s) => [s.c, s.cr]), [["411000", 0], ["706000", 200]]);
ok("remplacement explicite : nouveaux montants, sans cumul, compte disparu écarté");
const etats = (await db.query(`select status, replaced_by is not null r from accounting_fec_imports where organization_id = $1 order by imported_at`, [orgFec])).rows;
assert.deepEqual(etats, [{ status: "replaced", r: true }, { status: "active", r: false }]);
assert.equal((await db.query(`select count(*)::int n from accounting_monthly_balances where organization_id = $1 and source='fec' and excluded_at is not null`, [orgFec])).rows[0].n, 2);
ok("historique conservé : import remplacé tracé, balances écartées et non supprimées");
const mal = await importer(orgFec, "e4", "2023-01-01", "2023-12-31", [["2023-02", "706000", 0, 1, 1], ["2023-02", "ABC", 1, 0, 1]]).catch(() => "refus");
assert.equal(mal, "refus");
assert.equal((await db.query(`select count(*)::int n from accounting_fec_imports where organization_id = $1 and fingerprint = 'e4'`, [orgFec])).rows[0].n, 0);
ok("atomique : un import en échec ne laisse ni import ni balance");
assert.equal((await importer(orgFec2, "e1", "2024-01-01", "2024-12-31", lignesFec())).statut, "importe");
ok("isolation : la même empreinte dans une autre société n'est pas un doublon");
const regleOrg = (await db.query(`insert into accounting_mapping_rules (organization_id, account_prefix, pnl_line, category_label) values ($1, '70', 'revenue', 'V') returning id`, [orgFec])).rows[0].id;
const ajustFec = (await db.query(`insert into accounting_management_adjustments (organization_id, adjustment_date, pnl_line, label, amount, nature, covers_from, covers_to) values ($1, '2024-03-31', 'depreciation', 'Dotation', -10, 'amortissement', '2024-03-01', '2024-03-31') returning id`, [orgFec])).rows[0].id;
await importer(orgFec, "e5", "2024-01-01", "2024-12-31", lignesFec(3).slice(0, 2), true);
assert.ok(regleOrg && ajustFec);
assert.equal((await db.query(`select count(*)::int n from accounting_mapping_rules where organization_id = $1`, [orgFec])).rows[0].n, 1);
assert.equal((await db.query(`select count(*)::int n from accounting_management_adjustments where organization_id = $1 and archived_at is null`, [orgFec])).rows[0].n, 1);
ok("réimport : correspondances et ajustements conservés");
await db.query(`insert into accounting_monthly_balances (organization_id, source, month, account_number, debit, credit, sync_run) values ($1, 'pennylane', '2024-01-01', '706000', 0, 999, '${RUN}')`, [orgFec]);
const lignesParSource = (await db.query(`select source, credit::float8 c from accounting_monthly_balances where organization_id = $1 and month = '2024-01-01' and account_number = '706000' and excluded_at is null order by 1`, [orgFec])).rows;
assert.deepEqual(lignesParSource, [{ source: "fec", c: 300 }, { source: "pennylane", c: 999 }]);
ok("FEC et API coexistent en base, chacun dans sa ligne : aucune écriture de l'un sur l'autre");
await db.query(`select accounting_replace_month_balance($1, 'pennylane', '2024-01-01', '${RUNA}', '[{"account_number":"706000","debit":0,"credit":1000}]'::jsonb)`, [orgFec]);
assert.equal((await soldesFec(orgFec)).find((s) => s.c === "706000").cr, 300);
ok("une synchronisation Pennylane ne touche jamais les balances du FEC");
const dernier = (await db.query(`select id from accounting_fec_imports where organization_id = $1 and status = 'active'`, [orgFec])).rows[0].id;
assert.equal((await db.query(`select accounting_fec_withdraw($1, $2) r`, [orgFec, dernier])).rows[0].r, true);
assert.equal((await soldesFec(orgFec)).length, 0);
assert.equal((await db.query(`select accounting_fec_withdraw($1, $2) r`, [org, dernier])).rows[0].r, false);
ok("retrait : balances hors calcul ; impossible de retirer l'import d'une autre société");
await assert.rejects(db.query(`insert into accounting_source_choices (organization_id, scope_start, scope_end, source) values ($1, '2024-01-01', '2024-12-31', 'autre')`, [orgFec]));
await assert.rejects(db.query(`insert into accounting_management_adjustments (organization_id, adjustment_date, pnl_line, label, amount, nature) values ($1, '2024-03-31', 'depreciation', 'x', 1, 'inconnue')`, [orgFec]));
ok("contraintes : source et nature connues seulement");
await db.exec(`reset role;`);
for (const role of ["anon", "authenticated"]) {
  await db.exec(`set test.uid = '${USER2}'; set role ${role};`);
  for (const t of ["accounting_fec_imports", "accounting_source_choices"]) await assert.rejects(db.query(`select * from ${t}`), /permission denied/, `${role} lit ${t}`);
  await assert.rejects(db.query(`select accounting_fec_import($1, 'x', 'y', '2024-01-01', '2024-12-31', true, '{}', '[]', '{}', false, null)`, [orgFec]), /permission denied/);
  await assert.rejects(db.query(`select accounting_fec_withdraw($1, $2)`, [orgFec, dernier]), /permission denied/);
  await db.exec(`reset role;`);
}
ok("anon et authenticated : aucun accès aux imports ni aux fonctions, même pour sa propre société");

const plan = await db.query(`explain select account_number from accounting_entry_lines where organization_id = '${org}' and entry_date between '2026-01-01' and '2026-12-31'`);
console.log("  plan :", plan.rows[0]["QUERY PLAN"]);
console.log("\nMigration vérifiée.");
await db.close();
