/**
 * Point d'entrée obligatoire de tout script staging. Aucun script ne se connecte à une base sans
 * passer par connecterStaging(), qui refuse de continuer si :
 *  - NEXT_PUBLIC_NOVANTA_ENV ne vaut pas "staging" ;
 *  - l'URL d'API Supabase ou ses clés ne désignent pas le projet staging déclaré ;
 *  - la chaîne de connexion Postgres ne désigne pas ce même projet, ou désigne une ref interdite.
 *
 * La chaîne de connexion (STAGING_DATABASE_URL) n'est jamais affichée ni journalisée : seule la
 * ref du projet l'est.
 */
import { Client } from "pg";
import {
  analyserUrlPostgres,
  ConnexionPostgres,
  MODE_STAGING,
  refDepuisUrlPostgres,
  verifierEnvironnement,
  verifierRefCible,
} from "../../lib/environnementGuard";

export class RefusGardeFou extends Error {}

export interface ContexteStaging {
  ref: string;
  databaseUrl: string;
}

/** Contrôles sans aucune connexion réseau. Lève RefusGardeFou au moindre doute. */
export function contexteStaging(): ContexteStaging {
  if (process.env.NEXT_PUBLIC_NOVANTA_ENV !== MODE_STAGING) {
    throw new RefusGardeFou('NEXT_PUBLIC_NOVANTA_ENV doit valoir "staging" (lancer via les scripts npm staging:*).');
  }

  const verdictApi = verifierEnvironnement({
    mode: process.env.NEXT_PUBLIC_NOVANTA_ENV,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    refStagingAttendue: process.env.NEXT_PUBLIC_STAGING_SUPABASE_REF,
    refsInterdites: process.env.NEXT_PUBLIC_NOVANTA_FORBIDDEN_SUPABASE_REFS,
    cles: [process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY],
  });
  if (!verdictApi.ok) throw new RefusGardeFou(verdictApi.raison);

  const databaseUrl = process.env.STAGING_DATABASE_URL;
  if (!databaseUrl) throw new RefusGardeFou("STAGING_DATABASE_URL est absente de .env.staging.local.");

  const refBase = refDepuisUrlPostgres(databaseUrl);
  const verdictBase = verifierRefCible(
    refBase,
    process.env.NEXT_PUBLIC_STAGING_SUPABASE_REF,
    process.env.NEXT_PUBLIC_NOVANTA_FORBIDDEN_SUPABASE_REFS
  );
  if (!verdictBase.ok) throw new RefusGardeFou(`Chaîne de connexion Postgres : ${verdictBase.raison}`);

  return { ref: refBase as string, databaseUrl };
}

async function ouvrir(connexion: ConnexionPostgres, motDePasse: string): Promise<Client> {
  const client = new Client({
    host: connexion.hote,
    port: connexion.port,
    user: connexion.utilisateur,
    password: motDePasse,
    database: connexion.base,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

/** Connexion Postgres au staging, uniquement après les contrôles de contexteStaging(). */
export async function connecterStaging(): Promise<{ client: Client; ref: string }> {
  const { ref, databaseUrl } = contexteStaging();
  // contexteStaging() a déjà extrait la ref de cette même analyse : elle ne peut pas être nulle ici.
  const connexion = analyserUrlPostgres(databaseUrl) as ConnexionPostgres;
  try {
    return { client: await ouvrir(connexion, connexion.motDePasse), ref };
  } catch (erreur) {
    const code = (erreur as { code?: string }).code ?? "inconnu";
    // Mot de passe refusé alors qu'il est resté entre les crochets du modèle Supabase
    // ("[YOUR-PASSWORD]") : nouvel essai sans les crochets, signalé explicitement.
    const entreCrochets = connexion.motDePasse.match(/^\[(.+)\]$/);
    if (code === "28P01" && entreCrochets) {
      try {
        const client = await ouvrir(connexion, entreCrochets[1]);
        console.warn("[staging] Mot de passe accepté une fois les crochets retirés : les supprimer dans STAGING_DATABASE_URL.");
        return { client, ref };
      } catch {
        // Refusé aussi sans crochets : on rapporte l'échec d'origine.
      }
    }
    // Le message du pilote n'est jamais relayé tel quel : seul son code sert au diagnostic.
    throw new RefusGardeFou(`Connexion Postgres au staging impossible (code ${code}).`);
  }
}

/** Exécute un script staging et traduit un refus du garde-fou en sortie propre, sans pile d'appels. */
export function lancer(principal: () => Promise<void>): void {
  principal().catch((erreur: unknown) => {
    if (erreur instanceof RefusGardeFou) {
      console.error(`[garde-fou staging] REFUS : ${erreur.message}`);
    } else {
      const err = erreur as { code?: string; message?: string };
      console.error(`[staging] ÉCHEC : ${err.message ?? "erreur inconnue"}${err.code ? ` (code ${err.code})` : ""}`);
    }
    process.exitCode = 1;
  });
}
