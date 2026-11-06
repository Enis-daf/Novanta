import type { SupabaseClient } from "@supabase/supabase-js";
import { chargerDroitsOrganisation } from "./offres";

// Modules du produit hors cockpit de trésorerie ("Futur"), qui dépend seulement de l'offre.
export type ModuleKey = "past";

export const ROUTE_FUTUR = "/";
export const ROUTE_PASSE = "/passe";

// Le module Passé porte le reporting, inclus dans toutes les offres (Essentiel compris) : il suit la
// capacité canViewReporting de l'offre de l'organisation, sans activation au cas par cas. La table
// organization_modules n'est plus lue. Droits relus en base (RLS : seulement la société de
// l'utilisateur connecté) ; une société illisible est une erreur, jamais un accès.
export async function moduleActifPourOrganisation(
  supabase: SupabaseClient,
  organizationId: string,
  moduleKey: ModuleKey
): Promise<boolean> {
  const { capacites } = await chargerDroitsOrganisation(supabase, organizationId);
  return moduleKey === "past" && capacites.canViewReporting;
}
