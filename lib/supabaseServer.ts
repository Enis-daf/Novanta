import { createClient, SupabaseClient, User } from "@supabase/supabase-js";
import { NextRequest } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Un client par requête, authentifié avec le token de l'appelant (jamais le client
// navigateur partagé : il ne faut jamais réutiliser une même instance mutable entre
// requêtes serveur concurrentes de plusieurs utilisateurs). La RLS existante
// (owner_id = auth.uid()) continue de s'appliquer normalement.
function createUserScopedClient(accessToken: string): SupabaseClient | null {
  if (!supabaseUrl || !supabasePublishableKey) return null;
  return createClient(supabaseUrl, supabasePublishableKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface AuthenticatedRequest {
  supabase: SupabaseClient;
  user: User;
}

// Vérifie le Bearer token envoyé par le client et renvoie un client Supabase
// scopé à cet utilisateur. Renvoie null si non authentifié ou si Supabase
// n'est pas configuré — à l'appelant de répondre 401/501.
export async function requireUser(req: NextRequest): Promise<AuthenticatedRequest | null> {
  const authHeader = req.headers.get("authorization");
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (!accessToken) return null;

  const supabase = createUserScopedClient(accessToken);
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  return { supabase, user: data.user };
}
