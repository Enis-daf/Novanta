import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { supprimerCredentialPennylane } from "@/lib/pennylaneRepository";

// Supprime le credential Pennylane de cette société uniquement. N'affecte aucune donnée métier :
// les Charges fixes déjà validées et les modifications faites via Vérifier mes données (Payée,
// Facturée, Versé...) vivent dans des tables entièrement distinctes, jamais touchées ici.
export async function POST(req: NextRequest) {
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
    await supprimerCredentialPennylane(supabaseAdmin, company.id);
    return NextResponse.json({ connected: false });
  } catch (error) {
    console.error("[pennylane/disconnect] échec", error);
    return NextResponse.json({ error: "Impossible de déconnecter Pennylane." }, { status: 500 });
  }
}
