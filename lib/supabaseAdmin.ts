import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { exigerEnvironnementSur } from "./environnementGuard";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Sans effet hors mode staging ; en mode staging, refuse toute autre base que le staging déclaré
// (y compris une clé service_role appartenant à un autre projet).
exigerEnvironnementSur([serviceRoleKey]);

// Client avec la clé service_role : contourne la RLS, réservé aux traitements serveur
// sans utilisateur connecté (webhook Stripe). Ne jamais importer depuis un composant
// client ni exposer cette clé au navigateur.
export const supabaseAdmin: SupabaseClient | null =
  supabaseUrl && serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false },
        // Jamais de lecture servie par le cache de données de Next.js (qui met en cache les GET de
        // fetch dans les routes) : un traitement serveur doit toujours lire l'état courant de la base.
        global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
      })
    : null;

export const supabaseAdminConfigured = Boolean(supabaseAdmin);
