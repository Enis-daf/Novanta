/**
 * Crée la société « QANNT TEST » dans la base STAGING et la rattache à l'utilisateur staging
 * (STAGING_USER_EMAIL, créé au préalable dans Supabase Auth du projet staging — jamais copié
 * depuis la Production).
 *
 *   npm run staging:seed -- --synthetique
 *       -> Charges fixes synthétiques, cohérentes avec le serveur mock Pennylane (fixtures.ts).
 *   npm run staging:seed -- --export .staging/qannt-export.json
 *       -> données exportées en lecture seule de la société réelle (scripts/staging/export-qannt.sql),
 *          réidentifiées (nouveaux UUID) et anonymisées côté clients avant insertion.
 *   --remplacer : supprime d'abord la société staging existante de cet utilisateur (et toutes ses
 *                 données, par cascade) avant de la recréer.
 *
 * À lancer AVANT la première connexion à l'application staging : sinon l'application crée
 * elle-même une société et y injecte ses données de démonstration.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { connecterStaging, lancer, RefusGardeFou } from "./garde";
import { chargesFixesSynthetiques, dateRelative, SOLDE_INITIAL_SYNTHETIQUE } from "./fixtures";

const NOM_SOCIETE = "QANNT TEST";

type Ligne = Record<string, unknown>;

const TABLES_DONNEES = [
  "fixed_charges",
  "recurring_income",
  "supplier_invoices",
  "customer_invoices",
  "other_expenses",
  "financings",
] as const;
type TableDonnees = (typeof TABLES_DONNEES)[number];

type Jeu = { cash_settings: Ligne | null } & Record<TableDonnees, Ligne[]>;

function argument(nom: string): string | null {
  const index = process.argv.indexOf(nom);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function jeuSynthetique(): Jeu {
  const aujourdhui = new Date();
  const ids = new Map(chargesFixesSynthetiques.map((c) => [c.cle, randomUUID()]));
  return {
    cash_settings: { solde_initial: SOLDE_INITIAL_SYNTHETIQUE, date_releve: dateRelative(aujourdhui, 0, aujourdhui.getDate()), horizon_jours: 90 },
    fixed_charges: chargesFixesSynthetiques.map((c) => ({
      id: ids.get(c.cle),
      libelle: c.libelle,
      montant: c.montant,
      date_prevue: dateRelative(aujourdhui, 0, c.jour),
      recurrence: "mensuel",
      date_fin: null,
      mode_montant: c.calcule ? "calcule" : "fixe",
      taux_calcul: c.calcule ? c.calcule.taux : null,
      source_calcul_id: c.calcule ? ids.get(c.calcule.sourceCle) : null,
      source_calcul_type: c.calcule ? "charge_fixe" : null,
      a_couper: false,
    })),
    recurring_income: [],
    supplier_invoices: [],
    customer_invoices: [],
    other_expenses: [],
    financings: [],
  };
}

/**
 * Réidentifie et anonymise un export de la société réelle. Les fournisseurs et les libellés de
 * charges sont conservés (le rapprochement en dépend) ; les clients et leurs numéros de facture
 * sont remplacés. Les colonnes propres à la base d'origine (company_id, updated_at) sont retirées.
 */
function jeuDepuisExport(chemin: string): Jeu {
  const brut = JSON.parse(readFileSync(chemin, "utf8")) as Partial<Jeu>;
  const nouveauxIds = new Map<string, string>();
  const nouvelId = (ancien: unknown): string => {
    const cle = String(ancien);
    if (!nouveauxIds.has(cle)) nouveauxIds.set(cle, randomUUID());
    return nouveauxIds.get(cle) as string;
  };
  const nettoyer = (ligne: Ligne): Ligne => {
    const { company_id: _societe, updated_at: _maj, ...reste } = ligne;
    return { ...reste, id: nouvelId(ligne.id) };
  };

  const clients = new Map<string, string>();
  const clientAnonyme = (nom: unknown): string => {
    const cle = String(nom ?? "");
    if (!clients.has(cle)) clients.set(cle, `Client ${String(clients.size + 1).padStart(2, "0")}`);
    return clients.get(cle) as string;
  };

  const lignes = (table: TableDonnees): Ligne[] => (Array.isArray(brut[table]) ? (brut[table] as Ligne[]) : []);
  // Les ids des deux tables sources possibles d'une charge calculée doivent être attribués avant
  // de réécrire source_calcul_id.
  const rentrees = lignes("recurring_income").map(nettoyer);
  const charges = lignes("fixed_charges")
    .map(nettoyer)
    .map((c) => ({ ...c, source_calcul_id: c.source_calcul_id ? nouvelId(c.source_calcul_id) : null }));

  const { company_id: _societe, updated_at: _maj, ...reglages } = (brut.cash_settings ?? {}) as Ligne;
  return {
    cash_settings: brut.cash_settings ? reglages : null,
    fixed_charges: charges,
    recurring_income: rentrees,
    supplier_invoices: lignes("supplier_invoices").map(nettoyer),
    customer_invoices: lignes("customer_invoices")
      .map(nettoyer)
      .map((f, index) => ({ ...f, client: clientAnonyme(f.client), facture: `FC-${String(index + 1).padStart(4, "0")}` })),
    other_expenses: lignes("other_expenses").map(nettoyer),
    financings: lignes("financings").map(nettoyer),
  };
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

  const jeu = cheminExport ? jeuDepuisExport(cheminExport) : jeuSynthetique();

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
      if (existantes.length > 0) {
        if (!process.argv.includes("--remplacer")) {
          throw new RefusGardeFou("Cet utilisateur a déjà une société staging. Ajouter --remplacer pour la recréer.");
        }
        await client.query("delete from public.companies where owner_id = $1", [ownerId]);
        console.log("Société staging existante supprimée (--remplacer).");
      }

      // access_enabled = true : pas de parcours Stripe dans l'environnement de test.
      const { rows: creees } = await client.query(
        "insert into public.companies (owner_id, name, access_enabled) values ($1, $2, true) returning id",
        [ownerId, NOM_SOCIETE]
      );
      const companyId = creees[0].id as string;
      const avecSociete = (lignes: Ligne[]) => lignes.map((ligne) => ({ ...ligne, company_id: companyId }));

      console.log(`Société « ${NOM_SOCIETE} » créée.`);
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
