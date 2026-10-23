/**
 * Contrôle de .env.staging.local avant de démarrer l'application en mode staging.
 *
 * Next.js charge aussi .env.local : toute variable absente du fichier staging serait donc lue
 * silencieusement dans la configuration habituelle. Ce script exige que chaque variable sensible
 * soit définie DANS le fichier staging lui-même, puis applique le garde-fou anti-prod. Il
 * n'affiche jamais une valeur, seulement des noms de variables et la ref du projet.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { contexteStaging, lancer, RefusGardeFou } from "./garde";

const RACINE = path.resolve(__dirname, "../..");

const OBLIGATOIRES = [
  "NEXT_PUBLIC_NOVANTA_ENV",
  "NEXT_PUBLIC_STAGING_SUPABASE_REF",
  "NEXT_PUBLIC_NOVANTA_FORBIDDEN_SUPABASE_REFS",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PENNYLANE_TOKEN_ENCRYPTION_KEY",
  "NEXT_PUBLIC_APP_URL",
  "STAGING_DATABASE_URL",
  "STAGING_USER_EMAIL",
];

// Secrets qui ne doivent jamais être partagés entre le staging et la configuration habituelle.
const DISTINCTES = ["SUPABASE_SERVICE_ROLE_KEY", "PENNYLANE_TOKEN_ENCRYPTION_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];

function lireFichierEnv(nom: string): Map<string, string> {
  const chemin = path.join(RACINE, nom);
  const valeurs = new Map<string, string>();
  if (!existsSync(chemin)) return valeurs;
  for (const ligne of readFileSync(chemin, "utf8").split("\n")) {
    const correspondance = ligne.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (correspondance) valeurs.set(correspondance[1], correspondance[2].trim().replace(/^["']|["']$/g, ""));
  }
  return valeurs;
}

lancer(async () => {
  const staging = lireFichierEnv(".env.staging.local");
  if (staging.size === 0) throw new RefusGardeFou(".env.staging.local est absent ou vide (voir .env.staging.local.example).");

  const manquantes = OBLIGATOIRES.filter((nom) => !staging.get(nom));
  if (manquantes.length > 0) {
    throw new RefusGardeFou(`Variables absentes de .env.staging.local : ${manquantes.join(", ")}`);
  }

  const habituel = lireFichierEnv(".env.local");
  const partagees = DISTINCTES.filter((nom) => habituel.get(nom) && habituel.get(nom) === staging.get(nom));
  if (partagees.length > 0) {
    throw new RefusGardeFou(`Valeurs identiques à .env.local, interdites en staging : ${partagees.join(", ")}`);
  }

  const { ref } = contexteStaging();
  console.log(`[garde-fou staging] OK — projet Supabase ciblé : ${ref}`);
});
