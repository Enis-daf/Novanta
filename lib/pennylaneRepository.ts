import type { SupabaseClient } from "@supabase/supabase-js";
import { chiffrerTokenPennylane, dechiffrerTokenPennylane } from "./pennylaneCrypto";

/**
 * Accès Supabase au credential Pennylane — SERVEUR UNIQUEMENT, toujours via le client service_role
 * (voir lib/supabaseAdmin.ts). La table pennylane_connections n'a aucun GRANT vers "authenticated" :
 * même un bug applicatif ne pourrait pas exposer le token via le SDK client. L'appelant (une route
 * API) est seul responsable d'avoir vérifié l'ownership de companyId via requireUser() au préalable
 * — cette couche ne refait jamais cette vérification, elle fait confiance au companyId reçu.
 */

export type PennylaneStatus = "connected" | "invalid";

export interface PennylaneConnectionStatus {
  connected: boolean;
  status: PennylaneStatus | null;
  lastTestedAt: string | null;
  lastErrorCode: string | null;
}

type Row = Record<string, unknown>;

/** État visible du navigateur : jamais le token, jamais token_ciphertext dans le select. */
const COLONNES_STATUT = "status, last_tested_at, last_error_code";

export async function obtenirStatutPennylane(
  admin: SupabaseClient,
  companyId: string
): Promise<PennylaneConnectionStatus> {
  const { data, error } = await admin
    .from("pennylane_connections")
    .select(COLONNES_STATUT)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { connected: false, status: null, lastTestedAt: null, lastErrorCode: null };

  const row = data as Row;
  return {
    connected: row.status === "connected",
    status: (row.status as PennylaneStatus | null) ?? null,
    lastTestedAt: (row.last_tested_at as string | null) ?? null,
    lastErrorCode: (row.last_error_code as string | null) ?? null,
  };
}

/** Déchiffre et renvoie le token en clair — à n'utiliser que pour construire un CredentialProvider, jamais pour le renvoyer au client. */
export async function obtenirTokenPennylane(admin: SupabaseClient, companyId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("pennylane_connections")
    .select("token_ciphertext")
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return dechiffrerTokenPennylane((data as Row).token_ciphertext as string);
}

/** Sauvegarde (création ou remplacement) d'un token validé — status "connected" par construction : n'est appelé qu'après un test réussi. */
export async function enregistrerCredentialPennylane(
  admin: SupabaseClient,
  companyId: string,
  tokenClair: string
): Promise<void> {
  const { error } = await admin.from("pennylane_connections").upsert(
    {
      company_id: companyId,
      token_ciphertext: chiffrerTokenPennylane(tokenClair),
      status: "connected",
      last_tested_at: new Date().toISOString(),
      last_error_code: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "company_id" }
  );
  if (error) throw error;
}

/** Met à jour uniquement le statut (après un "Tester la connexion" ou un échec lors d'un fetch), sans toucher au token stocké. */
export async function marquerResultatTestPennylane(
  admin: SupabaseClient,
  companyId: string,
  resultat: { status: PennylaneStatus; lastErrorCode: string | null }
): Promise<void> {
  const { error } = await admin
    .from("pennylane_connections")
    .update({
      status: resultat.status,
      last_error_code: resultat.lastErrorCode,
      last_tested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("company_id", companyId);
  if (error) throw error;
}

/**
 * Déconnexion : supprime uniquement le credential Pennylane. Ne touche à aucune autre table —
 * les Charges fixes déjà validées et les modifications faites via Vérifier mes données (Payée,
 * Facturée, Versé...) sont dans des tables entièrement distinctes, jamais impactées.
 */
export async function supprimerCredentialPennylane(admin: SupabaseClient, companyId: string): Promise<void> {
  const { error } = await admin.from("pennylane_connections").delete().eq("company_id", companyId);
  if (error) throw error;
}
