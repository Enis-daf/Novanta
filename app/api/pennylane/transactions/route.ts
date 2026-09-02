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
import { listTransactions, PennylaneApiError } from "@/lib/pennylaneClient";
import { versNormalizedBankTransactions } from "@/lib/pennylaneTransactionAdapter";
import { cleChiffrementConfiguree } from "@/lib/pennylaneCrypto";
import { decalerDateISO, todayISO } from "@/lib/dates";
import { FENETRE_JOURS } from "@/lib/consistencyChecker";
import { MESSAGE_CONFIG_SERVEUR, codeErreurPennylane, messageErreurUtilisationPennylane } from "@/lib/pennylaneMessages";

// Récupération à la demande des transactions Pennylane nécessaires à UNE des deux features
// existantes — jamais plus que nécessaire (voir la fenêtre par usage ci-dessous), jamais stockées :
// la réponse est directement le NormalizedBankTransaction[] consommé par
// detecterChargesRecurrentes / controlerCoherence côté client, exactement comme pour le XLSX.
type Usage = "charges_fixes" | "consistency";

// Charges fixes : même profondeur d'historique que ce que l'import XLSX manuel couvre
// habituellement (6 mois), pour permettre au moteur de détection de trouver au moins 3 occurrences
// d'une charge mensuelle. Vérifier mes données : exactement la fenêtre J-30 du ConsistencyChecker
// (FENETRE_JOURS importée depuis lib/consistencyChecker.ts — jamais dupliquée/désynchronisée).
const JOURS_HISTORIQUE_CHARGES_FIXES = 30 * 6;

function fenetreDates(usage: Usage): { dateDebut: string; dateFin: string } {
  const dateFin = todayISO();
  const jours = usage === "charges_fixes" ? JOURS_HISTORIQUE_CHARGES_FIXES : FENETRE_JOURS;
  return { dateDebut: decalerDateISO(dateFin, -(jours - 1)), dateFin };
}

export async function POST(req: NextRequest) {
  if (!supabaseAdminConfigured || !supabaseAdmin) {
    console.error("[pennylane/transactions] config serveur manquante: SUPABASE_SERVICE_ROLE_KEY absente");
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
  }
  if (!cleChiffrementConfiguree()) {
    console.error("[pennylane/transactions] config serveur manquante: PENNYLANE_TOKEN_ENCRYPTION_KEY absente ou invalide");
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
  }

  const auth = await requireUser(req);
  if (!auth) {
    return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  }
  const { supabase, user } = auth;

  let usage: unknown;
  try {
    ({ usage } = await req.json());
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  if (usage !== "charges_fixes" && usage !== "consistency") {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }

  let companyId: string;
  try {
    const company = await getOrCreateCompanyForBilling(supabase, user);
    if (!company?.id) {
      console.error(`[pennylane/transactions] company_id introuvable pour l'utilisateur ${user.id}`);
      return NextResponse.json({ error: "Impossible de déterminer votre société. Reconnectez-vous." }, { status: 500 });
    }
    companyId = company.id;
  } catch (erreur) {
    console.error(`[pennylane/transactions] échec de résolution de la société pour l'utilisateur ${user.id}`, erreur);
    return NextResponse.json({ error: "Impossible de déterminer votre société. Reconnectez-vous." }, { status: 500 });
  }

  let token: string | null;
  try {
    token = await obtenirTokenPennylane(supabaseAdmin, companyId);
  } catch (erreur) {
    console.error(`[pennylane/transactions] lecture du credential échouée ${resumeErreurSupabaseSansSecret(erreur)}`);
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
  }
  if (!token) {
    return NextResponse.json({ error: "Aucune connexion Pennylane enregistrée." }, { status: 404 });
  }

  const { dateDebut, dateFin } = fenetreDates(usage);
  const provider = new CompanyApiTokenCredentialProvider(token);

  let brutes;
  try {
    brutes = await listTransactions(provider, dateDebut, dateFin);
    console.log(`[pennylane/transactions] fetched OK usage=${usage} company=${companyId}`);
  } catch (erreur) {
    if (erreur instanceof PennylaneApiError) {
      console.log(`[pennylane/transactions] Pennylane returned ${erreur.httpStatus ?? "?"} reason=${erreur.reason}`);
      // Une connexion jusqu'ici valide peut se révéler invalide à l'usage (token révoqué côté
      // Pennylane entre-temps, par exemple) : on met à jour le statut persisté en conséquence,
      // pour que l'écran d'intégration reflète l'état réel sans attendre un "Tester la connexion".
      if (erreur.reason === "invalid_token" || erreur.reason === "insufficient_scope") {
        try {
          await marquerResultatTestPennylane(supabaseAdmin, companyId, {
            status: "invalid",
            lastErrorCode: codeErreurPennylane(erreur.reason),
          });
        } catch (dbErreur) {
          console.error(`[pennylane/transactions] DB save (statut invalide) failed ${resumeErreurSupabaseSansSecret(dbErreur)}`);
        }
      }
      return NextResponse.json({ error: messageErreurUtilisationPennylane(erreur.reason) }, { status: 400 });
    }
    console.error("[pennylane/transactions] erreur inattendue en contactant Pennylane", erreur);
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
  }

  const transactions = versNormalizedBankTransactions(brutes);
  return NextResponse.json({ transactions, periode: { debut: dateDebut, fin: dateFin } });
}
