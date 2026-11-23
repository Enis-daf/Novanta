import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "./supabaseServer";
import { getOrCreateCompanyForBilling } from "./billing";
import { chargerDroitsOrganisation, refusOffre } from "./offres";

/**
 * Contrôle d'accès commun aux routes de la prévision probabiliste : utilisateur authentifié,
 * société dérivée de l'utilisateur (jamais un identifiant envoyé par le navigateur), offre relue en
 * base à chaque appel. Sans l'offre Pilotage : 403, aucun calcul, aucun résultat.
 */
export async function accesPrevisionProbabiliste(
  req: NextRequest,
  journal: string
): Promise<{ ok: true; supabase: SupabaseClient; companyId: string } | { ok: false; reponse: NextResponse }> {
  const auth = await requireUser(req);
  if (!auth) return { ok: false, reponse: NextResponse.json({ error: "Authentification requise." }, { status: 401 }) };
  try {
    const company = await getOrCreateCompanyForBilling(auth.supabase, auth.user);
    if (!company?.id) return { ok: false, reponse: NextResponse.json({ error: "Accès refusé." }, { status: 403 }) };
    const { capacites } = await chargerDroitsOrganisation(auth.supabase, company.id);
    if (!capacites.canViewForecast) return { ok: false, reponse: NextResponse.json(refusOffre("canViewForecast"), { status: 403 }) };
    if (!capacites.canViewProbabilisticForecast) {
      return { ok: false, reponse: NextResponse.json(refusOffre("canViewProbabilisticForecast"), { status: 403 }) };
    }
    return { ok: true, supabase: auth.supabase, companyId: company.id };
  } catch (erreur) {
    console.error(`[${journal}] société ou offre illisible pour l'utilisateur ${auth.user.id}`, erreur);
    return { ok: false, reponse: NextResponse.json({ error: "Impossible de vérifier votre accès." }, { status: 500 }) };
  }
}
