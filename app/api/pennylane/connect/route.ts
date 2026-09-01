import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { enregistrerCredentialPennylane } from "@/lib/pennylaneRepository";
import { CompanyApiTokenCredentialProvider } from "@/lib/pennylaneCredentialProvider";
import { listTransactions, PennylaneApiError } from "@/lib/pennylaneClient";
import { todayISO } from "@/lib/dates";
import { MESSAGE_CONNEXION_IMPOSSIBLE } from "@/lib/pennylaneMessages";

// Reçoit un Company API Token en clair (jamais journalisé, jamais renvoyé), le teste contre l'API
// Pennylane réelle, et ne le sauvegarde (chiffré) que si le test réussit. La company est toujours
// dérivée de l'utilisateur connecté — jamais du corps de la requête.
export async function POST(req: NextRequest) {
  if (!supabaseAdminConfigured || !supabaseAdmin) {
    return NextResponse.json({ error: "Supabase (service_role) n'est pas configuré." }, { status: 500 });
  }

  const auth = await requireUser(req);
  if (!auth) {
    return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  }
  const { supabase, user } = auth;

  let token: unknown;
  try {
    ({ token } = await req.json());
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  if (typeof token !== "string" || !token.trim()) {
    return NextResponse.json({ error: "Le token Pennylane est requis." }, { status: 400 });
  }

  try {
    const company = await getOrCreateCompanyForBilling(supabase, user);

    const jour = todayISO();
    const provider = new CompanyApiTokenCredentialProvider(token.trim());
    try {
      await listTransactions(provider, jour, jour); // appel minimal, uniquement pour valider le token/scope
    } catch (erreur) {
      if (erreur instanceof PennylaneApiError) {
        return NextResponse.json({ error: MESSAGE_CONNEXION_IMPOSSIBLE }, { status: 400 });
      }
      throw erreur;
    }

    await enregistrerCredentialPennylane(supabaseAdmin, company.id, token.trim());
    return NextResponse.json({ connected: true });
  } catch (error) {
    console.error("[pennylane/connect] échec", error);
    return NextResponse.json({ error: "Impossible d'enregistrer la connexion Pennylane." }, { status: 500 });
  }
}
