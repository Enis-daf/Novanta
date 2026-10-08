import type { SupabaseClient } from "@supabase/supabase-js";

// Clés des modules activables par organisation (table organization_modules). Le cockpit de
// trésorerie ("Futur") n'en fait pas partie : il reste piloté par companies.access_enabled.
export type ModuleKey = "past";

export const ROUTE_FUTUR = "/";
export const ROUTE_PASSE = "/passe";

// Fail-closed : un module n'est actif que si une ligne existe ET enabled vaut exactement true.
export function ligneModuleActive(ligne: { enabled?: unknown } | null | undefined): boolean {
  return ligne?.enabled === true;
}

// Vérifie l'entitlement au niveau de l'organisation (jamais de l'utilisateur). La RLS de
// organization_modules ne laisse lire que les lignes de la société de l'utilisateur connecté :
// passer l'id d'une autre organisation renvoie simplement false.
export async function moduleActifPourOrganisation(
  supabase: SupabaseClient,
  organizationId: string,
  moduleKey: ModuleKey
): Promise<boolean> {
  const { data, error } = await supabase
    .from("organization_modules")
    .select("enabled")
    .eq("organization_id", organizationId)
    .eq("module_key", moduleKey)
    .maybeSingle();
  if (error) throw error;
  return ligneModuleActive(data);
}
