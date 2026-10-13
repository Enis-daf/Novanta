/**
 * Crée la société « QANNT TEST » dans la base STAGING et la rattache à l'utilisateur staging
 * (STAGING_USER_EMAIL, créé au préalable dans Supabase Auth du projet staging — jamais copié
 * depuis la Production).
 *
 *   npm run staging:seed -- --synthetique
 *       -> Charges fixes synthétiques, cohérentes avec le serveur mock Pennylane (fixtures.ts).
 *   npm run staging:seed -- --export .staging/qannt-export.json
 *       -> données exportées en lecture seule de la société réelle (scripts/staging/export-qannt.sql),
 *          importées TELLES QUELLES : seuls les identifiants techniques sont régénérés (voir
 *          exportReel.ts). Aucune anonymisation.
 *   --remplacer : remplace les DONNÉES de la société staging existante (les 7 tables ci-dessous),
 *                 dans une seule transaction. La société, son utilisateur et sa connexion Pennylane
 *                 sont conservés ; rien d'autre n'est touché.
 *   --verifier-export : avec --export, contrôle le fichier et affiche ce qui serait importé, sans
 *                 aucune connexion à la base.
 *
 * À lancer AVANT la première connexion à l'application staging : sinon l'application crée
 * elle-même une société et y injecte ses données de démonstration.
 */
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { connecterStaging, lancer, RefusGardeFou } from "./garde";
import { jeuSynthetique } from "./fixtures";
import { ExportInvalide, Jeu, Ligne, lireExport, preparerExportReel, TABLES_DONNEES } from "./exportReel";

const NOM_SOCIETE = "QANNT TEST";

function argument(nom: string): string | null {
  const index = process.argv.indexOf(nom);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

/**
 * Insère des lignes en ne renseignant que les colonnes qui existent dans la table staging : une
 * colonne de l'export absente du schéma staging est ignorée et signalée, jamais devinée.
 */
async function inserer(client: Client, table: string, lignes: Ligne[]): Promise<void> {
  if (lignes.length === 0) return;
  const { rows } = await client.query(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1",
    [table]
  );
  const colonnesTable = new Set(rows.map((row) => row.column_name as string));
  const colonnesLignes = Array.from(new Set(lignes.flatMap((ligne) => Object.keys(ligne))));
  const colonnes = colonnesLignes.filter((colonne) => colonnesTable.has(colonne));
  const ignorees = colonnesLignes.filter((colonne) => !colonnesTable.has(colonne));
  if (ignorees.length > 0) console.warn(`  ${table} : colonnes absentes du schéma staging, ignorées : ${ignorees.join(", ")}`);

  const liste = colonnes.map((colonne) => client.escapeIdentifier(colonne)).join(", ");
  const cible = `public.${client.escapeIdentifier(table)}`;
  await client.query(
    `insert into ${cible} (${liste}) select ${liste} from jsonb_populate_recordset(null::${cible}, $1::jsonb)`,
    [JSON.stringify(lignes)]
  );
  console.log(`  ${table} : ${lignes.length} ligne(s)`);
}

lancer(async () => {
  const cheminExport = argument("--export");
  const synthetique = process.argv.includes("--synthetique");
  if (synthetique === Boolean(cheminExport)) {
    throw new RefusGardeFou("Choisir exactement un mode : --synthetique ou --export <fichier.json>.");
  }
  const email = process.env.STAGING_USER_EMAIL;
  if (!email) throw new RefusGardeFou("STAGING_USER_EMAIL est absente de .env.staging.local.");

  let jeu: Jeu;
  if (cheminExport) {
    try {
      jeu = preparerExportReel(lireExport(readFileSync(cheminExport, "utf8")));
    } catch (erreur) {
      if (erreur instanceof ExportInvalide) throw new RefusGardeFou(erreur.message);
      throw erreur;
    }
  } else {
    jeu = jeuSynthetique(new Date());
  }

  if (process.argv.includes("--verifier-export")) {
    console.log("Export valide. Lignes qui seraient importées (aucune connexion à la base) :");
    console.log(`  cash_settings : ${jeu.cash_settings ? 1 : 0}`);
    for (const table of TABLES_DONNEES) console.log(`  ${table} : ${jeu[table].length}`);
    const sources = jeu.fixed_charges.filter((c) => c.source_calcul_id).length;
    console.log(`  dont charges calculées (source réidentifiée) : ${sources}`);
    return;
  }

  const { client, ref } = await connecterStaging();
  try {
    console.log(`Projet ciblé : ${ref}`);
    const { rows: utilisateurs } = await client.query("select id from auth.users where lower(email) = lower($1)", [email]);
    if (utilisateurs.length !== 1) {
      throw new RefusGardeFou("Utilisateur staging introuvable dans Supabase Auth : le créer d'abord (Authentication → Add user).");
    }
    const ownerId = utilisateurs[0].id as string;

    await client.query("begin");
    try {
      const { rows: existantes } = await client.query("select id from public.companies where owner_id = $1", [ownerId]);
      let companyId: string;
      if (existantes.length > 0) {
        if (!process.argv.includes("--remplacer")) {
          throw new RefusGardeFou("Cet utilisateur a déjà une société staging. Ajouter --remplacer pour remplacer ses données.");
        }
        // Remplacement en place : la société, son utilisateur et sa connexion Pennylane restent.
        // Seules les lignes de données de CETTE société sont retirées (les rapprochements liés aux
        // Charges fixes retirées partent avec elles, par cascade).
        companyId = existantes[0].id as string;
        for (const table of ["cash_settings", ...TABLES_DONNEES]) {
          const { rowCount } = await client.query(`delete from public.${client.escapeIdentifier(table)} where company_id = $1`, [companyId]);
          if (rowCount) console.log(`  ${table} : ${rowCount} ligne(s) existante(s) retirée(s)`);
        }
        // access_enabled = true : pas de parcours Stripe dans l'environnement de test.
        await client.query("update public.companies set name = $2, access_enabled = true where id = $1", [companyId, NOM_SOCIETE]);
        console.log(`Société « ${NOM_SOCIETE} » conservée, données remplacées.`);
      } else {
        const { rows: creees } = await client.query(
          "insert into public.companies (owner_id, name, access_enabled) values ($1, $2, true) returning id",
          [ownerId, NOM_SOCIETE]
        );
        companyId = creees[0].id as string;
        console.log(`Société « ${NOM_SOCIETE} » créée.`);
      }
      const avecSociete = (lignes: Ligne[]) => lignes.map((ligne) => ({ ...ligne, company_id: companyId }));

      // Sans cash_settings l'application considérerait la société comme jamais initialisée et y
      // injecterait ses données de démonstration : une ligne est donc toujours créée.
      await inserer(client, "cash_settings", avecSociete([jeu.cash_settings ?? { solde_initial: 0 }]));
      for (const table of TABLES_DONNEES) await inserer(client, table, avecSociete(jeu[table]));
      await client.query("commit");
    } catch (erreur) {
      await client.query("rollback");
      throw erreur;
    }
    console.log("Seed terminé.");
  } finally {
    await client.end();
  }
});
