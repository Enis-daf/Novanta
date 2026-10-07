import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { moduleActifPourOrganisation } from "@/lib/organizationModules";
import { marquerResultatTestPennylane, obtenirTokenPennylane, resumeErreurSupabaseSansSecret } from "@/lib/pennylaneRepository";
import { CompanyApiTokenCredentialProvider } from "@/lib/pennylaneCredentialProvider";
import {
  listCategoryGroups,
  listTransactions,
  MAX_TRANSACTIONS_PAR_APPEL,
  PennylaneApiError,
} from "@/lib/pennylaneClient";
import { cleChiffrementConfiguree } from "@/lib/pennylaneCrypto";
import { MESSAGE_CONFIG_SERVEUR, codeErreurPennylane, messageErreurUtilisationPennylane } from "@/lib/pennylaneMessages";
import { decouperPeriodeParMois, normaliserNomCategorie, Periode, periodeValide } from "@/lib/pastTransactions";
import { depuisTransactionsPennylane } from "@/lib/pastTransactionAdapters";
import {
  supprimerPennylaneNonRevues,
  upsertAxesAnalytiques,
  upsertPastTransactionsPennylane,
} from "@/lib/pastTransactionsRepository";

// Synchronisation Pennylane -> past_transactions pour le module "Passé", déclenchée à la demande
// (pas de job planifié en V1). Réutilise telle quelle la connexion Pennylane existante (credential
// chiffré, CredentialProvider, client HTTP) : aucun second système d'authentification.
//
// L'organisation est toujours dérivée de l'utilisateur connecté, jamais d'un identifiant envoyé
// par le client : impossible de synchroniser les transactions d'une autre société.

export const maxDuration = 60;

const MESSAGE_ERREUR_SYNC = "La synchronisation Pennylane a échoué. Réessayez.";
const FORMAT_DATE_ISO = /^\d{4}-\d{2}-\d{2}$/;
// Garde-fou : une demande ne couvre jamais plus de 3 années civiles (36 tranches mensuelles).
const MAX_TRANCHES = 36;

// DIAGNOSTIC TEMPORAIRE (404 de synchronisation) — à retirer une fois la panne localisée. Ne logue
// que l'étape, l'endpoint, la méthode et le statut : jamais de token, de libellé ni de transaction.
function diag(message: string) {
  console.log(`[passe/sync] ${message}`);
}

export async function POST(req: NextRequest) {
  if (!supabaseAdminConfigured || !supabaseAdmin) {
    console.error("[passe/sync] config serveur manquante: SUPABASE_SERVICE_ROLE_KEY absente");
    return NextResponse.json({ error: MESSAGE_ERREUR_SYNC }, { status: 500 });
  }
  if (!cleChiffrementConfiguree()) {
    console.error("[passe/sync] config serveur manquante: PENNYLANE_TOKEN_ENCRYPTION_KEY absente ou invalide");
    return NextResponse.json({ error: MESSAGE_ERREUR_SYNC }, { status: 500 });
  }

  const auth = await requireUser(req);
  if (!auth) {
    return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  }
  const { supabase, user } = auth;

  let corps: { dateDebut?: unknown; dateFin?: unknown };
  try {
    corps = await req.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const { dateDebut, dateFin } = corps;
  if (
    typeof dateDebut !== "string" ||
    typeof dateFin !== "string" ||
    !FORMAT_DATE_ISO.test(dateDebut) ||
    !FORMAT_DATE_ISO.test(dateFin)
  ) {
    return NextResponse.json({ error: "Période invalide." }, { status: 400 });
  }
  const periode: Periode = { debut: dateDebut, fin: dateFin };
  if (!periodeValide(periode)) {
    return NextResponse.json({ error: "Période invalide." }, { status: 400 });
  }
  const tranches = decouperPeriodeParMois(periode);
  if (tranches.length > MAX_TRANCHES) {
    return NextResponse.json({ error: "La période à synchroniser ne peut pas dépasser 3 ans." }, { status: 400 });
  }

  let organizationId: string;
  try {
    const company = await getOrCreateCompanyForBilling(supabase, user);
    if (!company?.id || !company.accessEnabled) {
      return NextResponse.json({ error: "Accès au module Passé refusé." }, { status: 403 });
    }
    // Même entitlement que la page /passe, revérifié ici : cacher le bouton ne suffit pas.
    if (!(await moduleActifPourOrganisation(supabase, company.id, "past"))) {
      return NextResponse.json({ error: "Accès au module Passé refusé." }, { status: 403 });
    }
    organizationId = company.id;
  } catch (erreur) {
    console.error(`[passe/sync] échec de résolution de la société pour l'utilisateur ${user.id}`, erreur);
    return NextResponse.json({ error: "Impossible de déterminer votre société. Reconnectez-vous." }, { status: 500 });
  }

  let token: string | null;
  try {
    token = await obtenirTokenPennylane(supabaseAdmin, organizationId);
  } catch (erreur) {
    console.error(`[passe/sync] lecture du credential échouée ${resumeErreurSupabaseSansSecret(erreur)}`);
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
  }
  if (!token) {
    diag("step=credential source=novanta status=404 (aucun token Pennylane pour cette société)");
    return NextResponse.json({ error: "Aucune connexion Pennylane enregistrée." }, { status: 404 });
  }

  const provider = new CompanyApiTokenCredentialProvider(token);
  const syncedAt = new Date().toISOString();
  let nombreSynchronisees = 0;
  // Une tranche revenue pleine est peut-être tronquée par la pagination bornée du client : dans ce
  // cas on n'efface rien (on ne peut pas distinguer "supprimée côté Pennylane" de "non récupérée").
  let complete = true;
  // Axes analytiques rencontrés dans les transactions ; leur libellé vient de la liste des groupes
  // de catégories quand le token y a accès (scope categories:readonly), sinon il reste inconnu.
  const axes = new Map<string, string | null>();
  let libellesAxesDisponibles = true;
  // Étape en cours, pour nommer dans les logs celle qui échoue (diagnostic temporaire).
  let etape: { step: string; endpoint: string; month?: string } = { step: "category_groups", endpoint: "/category_groups" };
  diag(`step=start tranches=${tranches.length}`);

  try {
    try {
      const groupes = await listCategoryGroups(provider);
      diag(`step=category_groups method=GET endpoint=/category_groups status=200 count=${groupes.length}`);
      for (const groupe of groupes) {
        axes.set(String(groupe.id), normaliserNomCategorie(groupe.label));
      }
    } catch (erreur) {
      if (erreur instanceof PennylaneApiError && erreur.reason === "insufficient_scope") {
        diag("step=category_groups method=GET endpoint=/category_groups status=403 (toléré, synchronisation poursuivie)");
      }
      // Scope absent : la synchronisation des transactions reste possible, sans libellés d'axes.
      if (!(erreur instanceof PennylaneApiError) || erreur.reason !== "insufficient_scope") throw erreur;
      libellesAxesDisponibles = false;
    }
    const axesUtilises = new Set<string>();

    for (const tranche of tranches) {
      const month = tranche.debut.slice(0, 7);
      etape = { step: "transactions", endpoint: "/transactions", month };
      const brutes = await listTransactions(provider, tranche.debut, tranche.fin);
      diag(`step=transactions method=GET endpoint=/transactions status=200 month=${month} count=${brutes.length}`);
      if (brutes.length >= MAX_TRANSACTIONS_PAR_APPEL) complete = false;
      const normalisees = depuisTransactionsPennylane(brutes);
      etape = { step: "db_upsert_transactions", endpoint: "supabase:past_transactions", month };
      await upsertPastTransactionsPennylane(supabaseAdmin, organizationId, normalisees, syncedAt);
      nombreSynchronisees += normalisees.length;
      for (const t of normalisees) for (const a of t.affectations) axesUtilises.add(a.groupId);
    }

    etape = { step: "db_upsert_axes", endpoint: "supabase:past_analytic_groups" };
    // Seuls les axes réellement portés par des transactions sont proposés au module.
    await upsertAxesAnalytiques(
      supabaseAdmin,
      organizationId,
      [...axesUtilises].map((groupId) => ({ groupId, name: axes.get(groupId) ?? null }))
    );
  } catch (erreur) {
    if (erreur instanceof PennylaneApiError) {
      console.log(`[passe/sync] Pennylane returned ${erreur.httpStatus ?? "?"} reason=${erreur.reason}`);
      diag(`step=${etape.step} method=GET endpoint=${etape.endpoint} status=${erreur.httpStatus ?? "aucun"} reason=${erreur.reason}${etape.month ? ` month=${etape.month}` : ""}`);
      if (erreur.reason === "invalid_token" || erreur.reason === "insufficient_scope") {
        try {
          await marquerResultatTestPennylane(supabaseAdmin, organizationId, {
            status: "invalid",
            lastErrorCode: codeErreurPennylane(erreur.reason),
          });
        } catch (dbErreur) {
          console.error(`[passe/sync] DB save (statut invalide) failed ${resumeErreurSupabaseSansSecret(dbErreur)}`);
        }
      }
      return NextResponse.json({ error: messageErreurUtilisationPennylane(erreur.reason) }, { status: 400 });
    }
    const err = erreur as { code?: string; message?: string } | null;
    console.error(`[passe/sync] échec step=${etape.step} endpoint=${etape.endpoint}${etape.month ? ` month=${etape.month}` : ""} code=${err?.code ?? "inconnu"} message=${err?.message ?? "inconnu"}`);
    return NextResponse.json({ error: MESSAGE_ERREUR_SYNC }, { status: 500 });
  }

  let nombreRetirees = 0;
  if (complete) {
    try {
      nombreRetirees = await supprimerPennylaneNonRevues(supabaseAdmin, organizationId, periode, syncedAt);
    } catch (erreur) {
      // Les transactions sont à jour ; seul le retrait des lignes disparues a échoué. Non bloquant.
      const err = erreur as { code?: string; message?: string } | null;
      console.error(`[passe/sync] retrait des lignes non revues échoué code=${err?.code ?? "inconnu"} message=${err?.message ?? "inconnu"}`);
    }
  }

  console.log(`[passe/sync] OK company=${organizationId} synchronisees=${nombreSynchronisees} retirees=${nombreRetirees} complete=${complete}`);
  return NextResponse.json({ nombreSynchronisees, nombreRetirees, complete, libellesAxesDisponibles });
}
