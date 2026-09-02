import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { enregistrerCredentialPennylane, resumeErreurSupabaseSansSecret } from "@/lib/pennylaneRepository";
import { CompanyApiTokenCredentialProvider } from "@/lib/pennylaneCredentialProvider";
import { getMe, listTransactions, PennylaneApiError } from "@/lib/pennylaneClient";
import { cleChiffrementConfiguree } from "@/lib/pennylaneCrypto";
import { todayISO } from "@/lib/dates";
import { MESSAGE_CONFIG_SERVEUR, messageErreurConnexionInitiale } from "@/lib/pennylaneMessages";

/**
 * Reçoit un Company API Token en clair (jamais journalisé, jamais renvoyé), le valide en 2 étapes
 * distinctes contre l'API Pennylane réelle (voir ci-dessous), et ne le sauvegarde (chiffré) que si
 * les deux étapes réussissent. La company est toujours dérivée de l'utilisateur connecté — jamais
 * du corps de la requête.
 *
 * Étape 1 — GET /me : valide le token lui-même, quel que soit son scope (401 = token
 * absent/invalide -> erreur utilisateur "vérifiez le token", jamais un 500).
 * Étape 2 — GET /transactions (1 jour, minimal) : valide spécifiquement le scope
 * transactions:readonly (403 = scope insuffisant -> message dédié, jamais un 500).
 *
 * Toute erreur prévisible (config serveur manquante, société introuvable, échec DB) est
 * interceptée précisément et journalisée sans secret — plus de "catch" générique qui transforme
 * n'importe quelle cause en 500 "Impossible d'enregistrer la connexion Pennylane."
 */
export async function POST(req: NextRequest) {
  if (!supabaseAdminConfigured || !supabaseAdmin) {
    console.error("[pennylane/connect] config serveur manquante: SUPABASE_SERVICE_ROLE_KEY absente");
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
  }
  // Vérifié AVANT tout appel Pennylane : inutile de faire attendre l'utilisateur pour un token
  // qui, de toute façon, ne pourra pas être sauvegardé ensuite.
  if (!cleChiffrementConfiguree()) {
    console.error("[pennylane/connect] config serveur manquante: PENNYLANE_TOKEN_ENCRYPTION_KEY absente ou invalide");
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
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
  const tokenClair = token.trim();

  let companyId: string;
  try {
    const company = await getOrCreateCompanyForBilling(supabase, user);
    if (!company?.id) {
      console.error(`[pennylane/connect] company_id introuvable pour l'utilisateur ${user.id}`);
      return NextResponse.json({ error: "Impossible de déterminer votre société. Reconnectez-vous." }, { status: 500 });
    }
    companyId = company.id;
  } catch (erreur) {
    console.error(`[pennylane/connect] échec de résolution de la société pour l'utilisateur ${user.id}`, erreur);
    return NextResponse.json({ error: "Impossible de déterminer votre société. Reconnectez-vous." }, { status: 500 });
  }

  const provider = new CompanyApiTokenCredentialProvider(tokenClair);

  try {
    await getMe(provider);
    console.log("[pennylane/connect] /me returned 200");
  } catch (erreur) {
    if (erreur instanceof PennylaneApiError) {
      console.log(`[pennylane/connect] /me returned ${erreur.httpStatus ?? "?"} reason=${erreur.reason}`);
      return NextResponse.json({ error: messageErreurConnexionInitiale(erreur.reason) }, { status: 400 });
    }
    console.error("[pennylane/connect] /me: erreur inattendue", erreur);
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
  }

  try {
    const jour = todayISO();
    await listTransactions(provider, jour, jour); // appel minimal, uniquement pour valider le scope transactions:readonly
    console.log("[pennylane/connect] transactions scope OK");
  } catch (erreur) {
    if (erreur instanceof PennylaneApiError) {
      console.log(`[pennylane/connect] transactions returned ${erreur.httpStatus ?? "?"} reason=${erreur.reason}`);
      return NextResponse.json({ error: messageErreurConnexionInitiale(erreur.reason) }, { status: 400 });
    }
    console.error("[pennylane/connect] transactions: erreur inattendue", erreur);
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
  }

  try {
    console.log(`[pennylane/connect] saving for company ${companyId}`);
    await enregistrerCredentialPennylane(supabaseAdmin, companyId, tokenClair);
  } catch (erreur) {
    console.error(`[pennylane/connect] DB save failed ${resumeErreurSupabaseSansSecret(erreur)}`);
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
  }

  console.log(`[pennylane/connect] saved successfully for company ${companyId}`);
  return NextResponse.json({ connected: true });
}
