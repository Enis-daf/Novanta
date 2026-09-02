import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { supprimerCredentialPennylane, resumeErreurSupabaseSansSecret } from "@/lib/pennylaneRepository";
import { MESSAGE_CONFIG_SERVEUR } from "@/lib/pennylaneMessages";

// Supprime le credential Pennylane de cette société uniquement. N'affecte aucune donnée métier :
// les Charges fixes déjà validées et les modifications faites via Vérifier mes données (Payée,
// Facturée, Versé...) vivent dans des tables entièrement distinctes, jamais touchées ici.
export async function POST(req: NextRequest) {
  if (!supabaseAdminConfigured || !supabaseAdmin) {
    console.error("[pennylane/disconnect] config serveur manquante: SUPABASE_SERVICE_ROLE_KEY absente");
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
  }

  const auth = await requireUser(req);
  if (!auth) {
    return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  }
  const { supabase, user } = auth;

  let companyId: string;
  try {
    const company = await getOrCreateCompanyForBilling(supabase, user);
    if (!company?.id) {
      console.error(`[pennylane/disconnect] company_id introuvable pour l'utilisateur ${user.id}`);
      return NextResponse.json({ error: "Impossible de déterminer votre société. Reconnectez-vous." }, { status: 500 });
    }
    companyId = company.id;
  } catch (erreur) {
    console.error(`[pennylane/disconnect] échec de résolution de la société pour l'utilisateur ${user.id}`, erreur);
    return NextResponse.json({ error: "Impossible de déterminer votre société. Reconnectez-vous." }, { status: 500 });
  }

  try {
    await supprimerCredentialPennylane(supabaseAdmin, companyId);
  } catch (erreur) {
    console.error(`[pennylane/disconnect] DB delete failed ${resumeErreurSupabaseSansSecret(erreur)}`);
    return NextResponse.json({ error: "Impossible de déconnecter Pennylane pour le moment." }, { status: 500 });
  }

  console.log(`[pennylane/disconnect] disconnected company ${companyId}`);
  return NextResponse.json({ connected: false });
}
