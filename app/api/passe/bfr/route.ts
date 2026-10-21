import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { moduleActifPourOrganisation } from "@/lib/organizationModules";
import { marquerResultatTestPennylane, obtenirTokenPennylane, resumeErreurSupabaseSansSecret } from "@/lib/pennylaneRepository";
import { CompanyApiTokenCredentialProvider } from "@/lib/pennylaneCredentialProvider";
import { listerFacturesPourBfr, listMatchedTransactions, PennylaneApiError } from "@/lib/pennylaneClient";
import { cleChiffrementConfiguree } from "@/lib/pennylaneCrypto";
import { MESSAGE_CONFIG_SERVEUR, codeErreurPennylane, messageErreurUtilisationPennylane } from "@/lib/pennylaneMessages";
import { TypeFactureBfr } from "@/lib/pastBfr";
import { FacturePennylaneBrute } from "@/lib/pastBfrPennylane";
import { avecMesures, ClientFacturesBfr, daterReglements, limiteurDebit, MesuresSynchro, nouvellesMesures, synchroniserFactures } from "@/lib/pastBfrSync";
import { depotFacturesBfr } from "@/lib/pastBfrDepot";

// Synchronisation Pennylane -> past_bfr_invoices pour le BFR historique du module "Passé",
// déclenchée à la demande, en deux étapes (voir lib/pastBfrSync.ts) :
//   - etape "factures" : liste complète des factures, écriture des seules lignes nouvelles ou
//     modifiées, factures à dater marquées ;
//   - etape "reglements" : datation par lots des factures marquées, rappelée par le navigateur tant
//     qu'il en reste. Aucune liste n'est relue à cette étape.
// Chaque appel journalise ses mesures (durées, appels Pennylane par endpoint, 429, opérations
// Supabase) avec l'identifiant de synchronisation envoyé par le navigateur — jamais de token ni de
// contenu de facture. Rien n'est écrit dans les situations validées.
//
// L'organisation est toujours dérivée de l'utilisateur connecté.

export const maxDuration = 60;

const MESSAGE_ERREUR_SYNC = "La synchronisation des factures Pennylane a échoué. Réessayez.";
// Datation : au plus 300 factures par appel, 4 appels en vol, et jamais plus de 24 démarrages par
// fenêtre de 5 s — l'API en autorise 25. Mesuré sur le Preview (21/10, 1 203 factures) : c'est ce
// plafond qui fixe le débit (Pennylane répond en ~240 ms), à 20 il n'y a eu aucun 429 ; un 429
// éventuel est réessayé, puis le lot s'arrête proprement. Aucun nouvel appel après 40 s.
const MAX_FACTURES_PAR_APPEL = 300;
const CONCURRENCE = 4;
const BUDGET_MS = 40_000;

const VERS_PENNYLANE: Record<TypeFactureBfr, "customer" | "supplier"> = { client: "customer", fournisseur: "supplier" };

function journaliser(synchro: string, etape: string, organizationId: string, debut: number, mesures: MesuresSynchro, resultat: Record<string, unknown>) {
  const appels = Object.entries(mesures.appelsPennylane).map(([endpoint, n]) => `${endpoint}:${n}`).join(",");
  const details = Object.entries(resultat).map(([cle, valeur]) => `${cle}=${valeur}`).join(" ");
  console.log(
    `[passe/bfr] synchro=${synchro} etape=${etape} company=${organizationId} duree_ms=${Date.now() - debut} pennylane_ms=${mesures.dureePennylaneMs} appels=${appels || "aucun"} r429=${mesures.reponses429} attente_429_ms=${mesures.attente429Ms} supabase_ops=${mesures.operationsSupabase} supabase_ms=${mesures.dureeSupabaseMs} ${details}`
  );
}

export async function POST(req: NextRequest) {
  if (!supabaseAdminConfigured || !supabaseAdmin) {
    console.error("[passe/bfr] config serveur manquante: SUPABASE_SERVICE_ROLE_KEY absente");
    return NextResponse.json({ error: MESSAGE_ERREUR_SYNC }, { status: 500 });
  }
  if (!cleChiffrementConfiguree()) {
    console.error("[passe/bfr] config serveur manquante: PENNYLANE_TOKEN_ENCRYPTION_KEY absente ou invalide");
    return NextResponse.json({ error: MESSAGE_ERREUR_SYNC }, { status: 500 });
  }

  const auth = await requireUser(req);
  if (!auth) {
    return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  }
  const { supabase, user } = auth;

  let corps: { etape?: unknown; synchro?: unknown };
  try {
    corps = await req.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const etape = corps.etape;
  if (etape !== "factures" && etape !== "reglements") {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  // Identifiant de corrélation des journaux : jamais une donnée, borné et filtré.
  const synchro = typeof corps.synchro === "string" ? corps.synchro.replace(/[^\w-]/g, "").slice(0, 40) : "inconnue";

  let organizationId: string;
  try {
    const company = await getOrCreateCompanyForBilling(supabase, user);
    if (!company?.id || !company.accessEnabled) {
      return NextResponse.json({ error: "Accès au module Passé refusé." }, { status: 403 });
    }
    if (!(await moduleActifPourOrganisation(supabase, company.id, "past"))) {
      return NextResponse.json({ error: "Accès au module Passé refusé." }, { status: 403 });
    }
    organizationId = company.id;
  } catch (erreur) {
    console.error(`[passe/bfr] échec de résolution de la société pour l'utilisateur ${user.id}`, erreur);
    return NextResponse.json({ error: "Impossible de déterminer votre société. Reconnectez-vous." }, { status: 500 });
  }

  let token: string | null;
  try {
    token = await obtenirTokenPennylane(supabaseAdmin, organizationId);
  } catch (erreur) {
    console.error(`[passe/bfr] lecture du credential échouée ${resumeErreurSupabaseSansSecret(erreur)}`);
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
  }
  if (!token) {
    return NextResponse.json({ error: "Aucune connexion Pennylane enregistrée." }, { status: 404 });
  }

  const provider = new CompanyApiTokenCredentialProvider(token);
  const client: ClientFacturesBfr = {
    async listerFactures(type) {
      const { items, complete } = await listerFacturesPourBfr(provider, VERS_PENNYLANE[type]);
      return { items: items as FacturePennylaneBrute[], complete };
    },
    async listerTransactionsRapprochees(type, pennylaneId) {
      try {
        return await listMatchedTransactions(provider, VERS_PENNYLANE[type], pennylaneId);
      } catch (erreur) {
        // Facture introuvable à cette adresse (supprimée entre-temps) : aucune transaction datée —
        // elle restera « au solde inconnu », sans bloquer la datation des autres.
        if (erreur instanceof PennylaneApiError && erreur.httpStatus === 404) return [];
        throw erreur;
      }
    },
  };
  const depot = depotFacturesBfr(supabaseAdmin, organizationId);
  const debut = Date.now();
  const maintenant = new Date().toISOString();
  const mesures = nouvellesMesures();

  try {
    if (etape === "factures") {
      const resultat = await avecMesures(mesures, () => synchroniserFactures(client, depot, maintenant));
      journaliser(synchro, etape, organizationId, debut, mesures, { ...resultat });
      return NextResponse.json({ ...resultat, synchroniseesLe: maintenant });
    }
    const resultat = await avecMesures(mesures, () =>
      daterReglements(client, depot, { maxFactures: MAX_FACTURES_PAR_APPEL, concurrence: CONCURRENCE, budgetMs: BUDGET_MS, maintenant, reserver: limiteurDebit(24, 5_000) })
    );
    journaliser(synchro, etape, organizationId, debut, mesures, { ...resultat });
    return NextResponse.json(resultat);
  } catch (erreur) {
    if (erreur instanceof PennylaneApiError) {
      journaliser(synchro, `${etape}-echec`, organizationId, debut, mesures, { http: erreur.httpStatus ?? "?", raison: erreur.reason });
      if (erreur.reason === "invalid_token" || erreur.reason === "insufficient_scope") {
        try {
          await marquerResultatTestPennylane(supabaseAdmin, organizationId, {
            status: "invalid",
            lastErrorCode: codeErreurPennylane(erreur.reason),
          });
        } catch (dbErreur) {
          console.error(`[passe/bfr] DB save (statut invalide) failed ${resumeErreurSupabaseSansSecret(dbErreur)}`);
        }
      }
      return NextResponse.json({ error: messageErreurUtilisationPennylane(erreur.reason) }, { status: 400 });
    }
    const err = erreur as { code?: string; message?: string } | null;
    console.error(`[passe/bfr] échec code=${err?.code ?? "inconnu"} message=${err?.message ?? "inconnu"}`);
    return NextResponse.json({ error: MESSAGE_ERREUR_SYNC }, { status: 500 });
  }
}
