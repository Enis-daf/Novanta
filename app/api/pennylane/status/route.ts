import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { obtenirStatutPennylane } from "@/lib/pennylaneRepository";

// État visible du navigateur uniquement : connected, dernière utilisation, code d'erreur éventuel.
// Ne renvoie jamais le token, même chiffré. La company est toujours dérivée de l'utilisateur
// connecté (jamais d'un company_id envoyé par le client) : impossible de lire l'état d'une autre société.
export async function GET(req: NextRequest) {
  if (!supabaseAdminConfigured || !supabaseAdmin) {
    return NextResponse.json({ error: "Supabase (service_role) n'est pas configuré." }, { status: 500 });
  }

  const auth = await requireUser(req);
  if (!auth) {
    return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  }
  const { supabase, user } = auth;

  try {
    const company = await getOrCreateCompanyForBilling(supabase, user);
    const statut = await obtenirStatutPennylane(supabaseAdmin, company.id);
    return NextResponse.json(statut);
  } catch (error) {
    console.error("[pennylane/status] échec", error);
    return NextResponse.json({ error: "Impossible de récupérer l'état de la connexion Pennylane." }, { status: 500 });
  }
}
