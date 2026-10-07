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
// Les mêmes lignes sont renvoyées dans la réponse (champ `diagnostic`) pour être lisibles depuis la
// page, sans passer par les logs d'hébergement.
// DIAGNOSTIC TEMPORAIRE (catégories absentes du tableau) — forme de la réponse Pennylane, sans
// aucune valeur métier : uniquement des noms de clés, des types et des compteurs.
function typeDe(valeur: unknown): string {
  if (valeur === null) return "null";
  if (Array.isArray(valeur)) return "array";
  return typeof valeur;
}

export async function POST(req: NextRequest) {
  const journal: string[] = [];
  const diag = (message: string) => {
    console.log(`[passe/sync] ${message}`);
    journal.push(message);
  };
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
    return NextResponse.json({ error: "Aucune connexion Pennylane enregistrée.", diagnostic: journal }, { status: 404 });
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
  const stats = {
    total: 0,
    categorisees: 0,
    affectations: 0,
    categoriesBrutes: 0,
    typesChampCategories: {} as Record<string, number>,
    formeLoguee: false,
  };
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
      for (const brute of brutes) {
        const type = typeDe((brute as unknown as Record<string, unknown>).categories);
        stats.typesChampCategories[type] = (stats.typesChampCategories[type] ?? 0) + 1;
        if (Array.isArray(brute.categories)) stats.categoriesBrutes += brute.categories.length;
        if (!stats.formeLoguee) {
          stats.formeLoguee = true;
          diag(`shape=transaction keys=${Object.keys(brute).sort().join(",")}`);
        }
        const premiere = Array.isArray(brute.categories) ? (brute.categories[0] as unknown as Record<string, unknown>) : null;
        if (premiere && !("categorieLoguee" in stats)) {
          (stats as Record<string, unknown>).categorieLoguee = true;
          const groupe = premiere.category_group;
          diag(
            `shape=category keys=${Object.keys(premiere).sort().join(",")} types=id:${typeDe(premiere.id)},label:${typeDe(premiere.label)},weight:${typeDe(premiere.weight)},category_group:${typeDe(groupe)} category_group_keys=${
              groupe && typeof groupe === "object" ? Object.keys(groupe).sort().join(",") : "-"
            }`
          );
        }
      }
      stats.total += normalisees.length;
      stats.categorisees += normalisees.filter((t) => t.affectations.length > 0).length;
      stats.affectations += normalisees.reduce((n, t) => n + t.affectations.length, 0);
      etape = { step: "db_upsert_transactions", endpoint: "supabase:past_transactions", month };
      await upsertPastTransactionsPennylane(supabaseAdmin, organizationId, normalisees, syncedAt);
      nombreSynchronisees += normalisees.length;
      for (const t of normalisees) for (const a of t.affectations) axesUtilises.add(a.groupId);
    }

    diag(`total_transactions=${stats.total}`);
    diag(`categorized_transactions=${stats.categorisees}`);
    diag(`uncategorized_transactions=${stats.total - stats.categorisees}`);
    diag(
      `raw_categories_field_types=${JSON.stringify(stats.typesChampCategories)} raw_categories=${stats.categoriesBrutes} normalized_assignments=${stats.affectations} axes_in_transactions=${[...axesUtilises].join(",") || "-"} axes_with_label=${axes.size}`
    );
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
      return NextResponse.json(
        { error: messageErreurUtilisationPennylane(erreur.reason), diagnostic: journal },
        { status: 400 }
      );
    }
    const err = erreur as { code?: string; message?: string } | null;
    diag(`ECHEC step=${etape.step} endpoint=${etape.endpoint}${etape.month ? ` month=${etape.month}` : ""} code=${err?.code ?? "inconnu"} message=${err?.message ?? "inconnu"}`);
    return NextResponse.json({ error: MESSAGE_ERREUR_SYNC, diagnostic: journal }, { status: 500 });
  }

  let nombreRetirees = 0;
  if (complete) {
    try {
      nombreRetirees = await supprimerPennylaneNonRevues(supabaseAdmin, organizationId, periode, syncedAt);
    } catch (erreur) {
      // Les transactions sont à jour ; seul le retrait des lignes disparues a échoué. Non bloquant.
      const err = erreur as { code?: string; message?: string } | null;
      diag(`ECHEC step=db_delete_stale code=${err?.code ?? "inconnu"} message=${err?.message ?? "inconnu"}`);
    }
  }

  console.log(`[passe/sync] OK company=${organizationId} synchronisees=${nombreSynchronisees} retirees=${nombreRetirees} complete=${complete}`);
  return NextResponse.json({ nombreSynchronisees, nombreRetirees, complete, libellesAxesDisponibles, diagnostic: journal });
}
