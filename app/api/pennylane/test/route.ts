import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import {
  marquerResultatTestPennylane,
  obtenirTokenPennylane,
  resumeErreurSupabaseSansSecret,
} from "@/lib/pennylaneRepository";
import { CompanyApiTokenCredentialProvider } from "@/lib/pennylaneCredentialProvider";
import { getMe, listTransactions, PennylaneApiError } from "@/lib/pennylaneClient";
import { cleChiffrementConfiguree } from "@/lib/pennylaneCrypto";
import { todayISO } from "@/lib/dates";
import { MESSAGE_CONFIG_SERVEUR, codeErreurPennylane, messageErreurUtilisationPennylane } from "@/lib/pennylaneMessages";

// Revalide une connexion déjà établie (bouton "Tester la connexion"), sans redemander le token —
// il n'est jamais renvoyé au navigateur, il est relu (déchiffré) côté serveur uniquement. Même
// validation en 2 étapes (/me puis scope transactions) que la connexion initiale, voir
// app/api/pennylane/connect/route.ts.
export async function POST(req: NextRequest) {
  if (!supabaseAdminConfigured || !supabaseAdmin) {
    console.error("[pennylane/test] config serveur manquante: SUPABASE_SERVICE_ROLE_KEY absente");
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
  }
  if (!cleChiffrementConfiguree()) {
    console.error("[pennylane/test] config serveur manquante: PENNYLANE_TOKEN_ENCRYPTION_KEY absente ou invalide");
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
      console.error(`[pennylane/test] company_id introuvable pour l'utilisateur ${user.id}`);
      return NextResponse.json({ error: "Impossible de déterminer votre société. Reconnectez-vous." }, { status: 500 });
    }
    companyId = company.id;
  } catch (erreur) {
    console.error(`[pennylane/test] échec de résolution de la société pour l'utilisateur ${user.id}`, erreur);
    return NextResponse.json({ error: "Impossible de déterminer votre société. Reconnectez-vous." }, { status: 500 });
  }

  let token: string | null;
  try {
    token = await obtenirTokenPennylane(supabaseAdmin, companyId);
  } catch (erreur) {
    console.error(`[pennylane/test] lecture du credential échouée ${resumeErreurSupabaseSansSecret(erreur)}`);
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
  }
  if (!token) {
    return NextResponse.json({ connected: false, error: "Aucune connexion Pennylane enregistrée." }, { status: 404 });
  }

  const provider = new CompanyApiTokenCredentialProvider(token);

  const echec = async (erreur: PennylaneApiError) => {
    console.log(`[pennylane/test] Pennylane returned ${erreur.httpStatus ?? "?"} reason=${erreur.reason}`);
    try {
      await marquerResultatTestPennylane(supabaseAdmin!, companyId, {
        status: "invalid",
        lastErrorCode: codeErreurPennylane(erreur.reason),
      });
    } catch (dbErreur) {
      console.error(`[pennylane/test] DB save (statut invalide) failed ${resumeErreurSupabaseSansSecret(dbErreur)}`);
    }
    return NextResponse.json({ connected: false, error: messageErreurUtilisationPennylane(erreur.reason) });
  };

  try {
    await getMe(provider);
    console.log("[pennylane/test] /me returned 200");
    await listTransactions(provider, todayISO(), todayISO());
    console.log("[pennylane/test] transactions scope OK");
  } catch (erreur) {
    if (erreur instanceof PennylaneApiError) return echec(erreur);
    console.error("[pennylane/test] erreur inattendue en contactant Pennylane", erreur);
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
  }

  try {
    await marquerResultatTestPennylane(supabaseAdmin, companyId, { status: "connected", lastErrorCode: null });
  } catch (erreur) {
    console.error(`[pennylane/test] DB save (statut connecté) failed ${resumeErreurSupabaseSansSecret(erreur)}`);
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
  }

  console.log(`[pennylane/test] connection confirmed for company ${companyId}`);
  return NextResponse.json({ connected: true });
}
