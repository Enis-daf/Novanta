import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { exigerEnvironnementSur } from "./environnementGuard";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Sans effet hors mode staging ; en mode staging, refuse toute autre base que le staging déclaré.
exigerEnvironnementSur();

export const supabase: SupabaseClient | null =
  supabaseUrl && supabasePublishableKey ? createClient(supabaseUrl, supabasePublishableKey) : null;

export const supabaseConfigured = Boolean(supabase);
