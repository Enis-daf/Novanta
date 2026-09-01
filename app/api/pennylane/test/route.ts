import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { marquerResultatTestPennylane, obtenirTokenPennylane } from "@/lib/pennylaneRepository";
import { CompanyApiTokenCredentialProvider } from "@/lib/pennylaneCredentialProvider";
import { listTransactions, PennylaneApiError } from "@/lib/pennylaneClient";
import { todayISO } from "@/lib/dates";
import { codeErreurPennylane, messageErreurUtilisationPennylane } from "@/lib/pennylaneMessages";

// Revalide une connexion déjà établie (bouton "Tester la connexion"), sans redemander le token —
// il n'est jamais renvoyé au navigateur, il est relu (déchiffré) côté serveur uniquement.
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
    const token = await obtenirTokenPennylane(supabaseAdmin, company.id);
    if (!token) {
      return NextResponse.json({ connected: false, error: "Aucune connexion Pennylane enregistrée." }, { status: 404 });
    }

    const jour = todayISO();
    const provider = new CompanyApiTokenCredentialProvider(token);
    try {
      await listTransactions(provider, jour, jour);
    } catch (erreur) {
      if (erreur instanceof PennylaneApiError) {
        await marquerResultatTestPennylane(supabaseAdmin, company.id, {
          status: "invalid",
          lastErrorCode: codeErreurPennylane(erreur.reason),
        });
        return NextResponse.json({ connected: false, error: messageErreurUtilisationPennylane(erreur.reason) });
      }
      throw erreur;
    }

    await marquerResultatTestPennylane(supabaseAdmin, company.id, { status: "connected", lastErrorCode: null });
    return NextResponse.json({ connected: true });
  } catch (error) {
    console.error("[pennylane/test] échec", error);
    return NextResponse.json({ error: "Impossible de tester la connexion Pennylane." }, { status: 500 });
  }
}
