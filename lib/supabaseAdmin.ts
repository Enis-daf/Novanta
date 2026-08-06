import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Client avec la clé service_role : contourne la RLS, réservé aux traitements serveur
// sans utilisateur connecté (webhook Stripe). Ne jamais importer depuis un composant
// client ni exposer cette clé au navigateur.
export const supabaseAdmin: SupabaseClient | null =
  supabaseUrl && serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
    : null;

export const supabaseAdminConfigured = Boolean(supabaseAdmin);
