/**
 * Construit (ou met à jour) le schéma de la base STAGING, de façon reproductible.
 *
 *   npm run staging:schema                 -> plan seul : n'exécute rien, ne se connecte à rien
 *   npm run staging:schema -- --executer   -> applique le plan
 *   npm run staging:schema -- --executer --reset
 *                                          -> vide d'abord le schéma public du staging, puis reconstruit
 *
 * Règles :
 *  - schema.sql n'est joué QUE sur une base jamais initialisée (aucune table "companies"). La règle
 *    générale reste : schema.sql ne se rejoue jamais sur une base existante.
 *  - Les migrations sont appliquées dans l'ordre de leur nom ; celles déjà appliquées sont suivies
 *    dans staging_meta.migrations et ne sont jamais rejouées.
 *  - Une base contenant déjà "companies" mais sans suivi staging_meta n'a pas été construite par
 *    ce script : refus (seul --reset permet de repartir de zéro).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { connecterStaging, contexteStaging, lancer, RefusGardeFou } from "./garde";

const RACINE = path.resolve(__dirname, "../..");
const FICHIER_SCHEMA = "supabase/schema.sql";
const DOSSIER_MIGRATIONS = "supabase/migrations";

function migrationsDisponibles(): string[] {
  return readdirSync(path.join(RACINE, DOSSIER_MIGRATIONS))
    .filter((nom) => nom.endsWith(".sql"))
    .sort();
}

async function tableExiste(client: Client, schema: string, table: string): Promise<boolean> {
  const { rows } = await client.query("select to_regclass($1) is not null as existe", [`${schema}.${table}`]);
  return rows[0].existe === true;
}

async function migrationsAppliquees(client: Client): Promise<Set<string>> {
  if (!(await tableExiste(client, "staging_meta", "migrations"))) return new Set();
  const { rows } = await client.query("select name from staging_meta.migrations");
  return new Set(rows.map((row) => row.name as string));
}

async function executerFichier(client: Client, cheminRelatif: string): Promise<void> {
  const sql = readFileSync(path.join(RACINE, cheminRelatif), "utf8");
  await client.query("begin");
  try {
    await client.query(sql);
    await client.query("commit");
  } catch (erreur) {
    await client.query("rollback");
    throw erreur;
  }
}

/** Supprime toutes les tables du schéma public du staging (auth.users n'est pas touché). */
async function viderSchemaPublic(client: Client): Promise<number> {
  const { rows } = await client.query("select tablename from pg_tables where schemaname = 'public'");
  for (const { tablename } of rows) {
    await client.query(`drop table if exists public.${client.escapeIdentifier(tablename as string)} cascade`);
  }
  await client.query("drop schema if exists staging_meta cascade");
  return rows.length;
}

lancer(async () => {
  const executer = process.argv.includes("--executer");
  const reset = process.argv.includes("--reset");
  const migrations = migrationsDisponibles();

  if (!executer) {
    const { ref } = contexteStaging();
    console.log("PLAN (aucune exécution, aucune connexion)");
    console.log(`  Script         : scripts/staging/schema.ts`);
    console.log(`  Projet ciblé   : ${ref}`);
    console.log(`  Sur base vide  : ${FICHIER_SCHEMA}, puis ${migrations.length} migrations :`);
    for (const nom of migrations) console.log(`    - ${nom}`);
    console.log("  Sur base déjà construite par ce script : uniquement les migrations non encore appliquées.");
    console.log("  Pour exécuter : npm run staging:schema -- --executer");
    return;
  }

  const { client, ref } = await connecterStaging();
  try {
    console.log(`Projet ciblé : ${ref}`);

    if (reset) {
      const nombre = await viderSchemaPublic(client);
      console.log(`--reset : ${nombre} tables du schéma public supprimées.`);
    }

    const initialisee = await tableExiste(client, "public", "companies");
    const suivie = await tableExiste(client, "staging_meta", "migrations");
    if (initialisee && !suivie) {
      throw new RefusGardeFou(
        'Cette base contient déjà "companies" mais n\'a pas été construite par ce script : schema.sql ne sera pas rejoué. Utiliser --reset pour repartir d\'une base vide.'
      );
    }

    if (!initialisee) {
      console.log(`Base vide : ${FICHIER_SCHEMA}`);
      await executerFichier(client, FICHIER_SCHEMA);
      await client.query("create schema if not exists staging_meta");
      await client.query(
        "create table if not exists staging_meta.migrations (name text primary key, applied_at timestamptz not null default now())"
      );
    }

    const dejaAppliquees = await migrationsAppliquees(client);
    let appliquees = 0;
    for (const nom of migrations) {
      if (dejaAppliquees.has(nom)) continue;
      console.log(`Migration : ${nom}`);
      await executerFichier(client, `${DOSSIER_MIGRATIONS}/${nom}`);
      await client.query("insert into staging_meta.migrations (name) values ($1)", [nom]);
      appliquees++;
    }
    console.log(`Terminé : ${appliquees} migration(s) appliquée(s), ${migrations.length - appliquees} déjà en place.`);
  } finally {
    await client.end();
  }
});
