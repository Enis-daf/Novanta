import type { SupabaseClient, User } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { getOrCreateCompanyForBilling } from "./billing";
import { pnlComptableActif } from "./featureFlags";
import { chargerDroitsOrganisation, refusOffre } from "./offres";
import { moduleActifPourOrganisation } from "./organizationModules";
import { supabaseAdmin, supabaseAdminConfigured } from "./supabaseAdmin";
import { requireUser } from "./supabaseServer";

/**
 * Garde commune des routes du P&L comptable. L'organisation vient TOUJOURS de l'utilisateur connecté,
 * jamais de la requête ; toute erreur refuse l'accès (fail-closed). Une offre sans la capacité reçoit le
 * 403 commun : un appel direct à l'API ne contourne pas le verrou de l'écran.
 */

export interface AccesCompta {
  admin: SupabaseClient;
  organizationId: string;
  user: User;
}

export async function exigerAccesCompta(req: NextRequest): Promise<AccesCompta | NextResponse> {
  // Drapeau éteint : la route n'existe pas pour l'appelant.
  if (!pnlComptableActif()) return NextResponse.json({ error: "Introuvable." }, { status: 404 });
  if (!supabaseAdminConfigured || !supabaseAdmin) {
    console.error("[passe/compta] config serveur manquante: SUPABASE_SERVICE_ROLE_KEY absente");
    return NextResponse.json({ error: "Le P&L comptable est indisponible." }, { status: 500 });
  }
  const auth = await requireUser(req);
  if (!auth) return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  const { supabase, user } = auth;
  try {
    const company = await getOrCreateCompanyForBilling(supabase, user);
    if (!company.accessEnabled) return NextResponse.json({ error: "Accès non activé." }, { status: 403 });
    if (!(await moduleActifPourOrganisation(supabase, company.id, "past"))) {
      return NextResponse.json({ error: "Module non activé." }, { status: 403 });
    }
    const droits = await chargerDroitsOrganisation(supabase, company.id);
    if (!droits.capacites.canViewAccountingPnl) return NextResponse.json(refusOffre("canViewAccountingPnl"), { status: 403 });
    return { admin: supabaseAdmin, organizationId: company.id, user };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? "inconnu";
    console.error(`[passe/compta] step=access code=${code}`);
    return NextResponse.json({ error: "Le P&L comptable est indisponible." }, { status: 500 });
  }
}
