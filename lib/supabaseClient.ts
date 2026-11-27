import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { exigerEnvironnementSur } from "./environnementGuard";
import { redirectionVersReinitialisation } from "./recuperationMotDePasse";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Sans effet hors mode staging ; en mode staging, refuse toute autre base que le staging déclaré.
exigerEnvironnementSur();

// URL d'arrivée, relevée AVANT la création du client : en flux implicite, le client lit la session
// dans le fragment puis l'efface (window.location.hash = ""). L'écran de réinitialisation en a besoin
// pour savoir que la session vient d'un lien de récupération. Ne jamais la journaliser.
export const urlAuChargement: string | null = typeof window === "undefined" ? null : window.location.href;

// Lien de récupération arrivé ailleurs que sur l'écran dédié (récupération lancée depuis le
// dashboard Supabase : redirection vers la Site URL). On y renvoie le navigateur avec ses
// paramètres, et ce chargement-ci ne lit pas l'URL ni ne garde de session : sinon il ouvrirait une
// session ordinaire dans le cockpit (le bug d'origine) et effacerait le fragment pendant la
// redirection.
const redirectionRecuperation = redirectionVersReinitialisation(urlAuChargement);
if (redirectionRecuperation) window.location.replace(redirectionRecuperation);

export const supabase: SupabaseClient | null =
  supabaseUrl && supabasePublishableKey
    ? createClient(
        supabaseUrl,
        supabasePublishableKey,
        redirectionRecuperation ? { auth: { detectSessionInUrl: false, persistSession: false } } : undefined,
      )
    : null;

export const supabaseConfigured = Boolean(supabase);
