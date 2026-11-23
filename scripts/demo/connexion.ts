import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

/**
 * Connexion service_role des scripts de démonstration (scripts/demo). Lit .env.local sans jamais
 * afficher une clé. Toute écriture passe par seedPilotage.ts, borné à UNE société vérifiée.
 */
export function lireEnv(fichier = ".env.local"): Record<string, string> {
  return Object.fromEntries(
    readFileSync(fichier, "utf8")
      .split("\n")
      .filter((l) => /^[A-Z_][A-Z0-9_ ]*=/.test(l))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
      })
  );
}

export function clientAdmin(): { admin: SupabaseClient; ref: string } {
  const env = lireEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const cle = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !cle) throw new Error("NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY absent de .env.local");
  return { admin: createClient(url, cle, { auth: { persistSession: false, autoRefreshToken: false } }), ref: new URL(url).hostname.split(".")[0] };
}
