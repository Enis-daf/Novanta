import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { moduleActifPourOrganisation } from "@/lib/organizationModules";
import { marquerResultatTestPennylane, obtenirTokenPennylane, resumeErreurSupabaseSansSecret } from "@/lib/pennylaneRepository";
import { CompanyApiTokenCredentialProvider } from "@/lib/pennylaneCredentialProvider";
import {
  listCustomerInvoices,
  listMatchedTransactions,
  listSupplierInvoices,
  MAX_FACTURES_PAR_LISTE,
  PennylaneApiError,
} from "@/lib/pennylaneClient";
import { cleChiffrementConfiguree } from "@/lib/pennylaneCrypto";
import { MESSAGE_CONFIG_SERVEUR, codeErreurPennylane, messageErreurUtilisationPennylane } from "@/lib/pennylaneMessages";
import { TypeFactureBfr } from "@/lib/pastBfr";
import {
  FacturePennylaneBrute,
  factureBfrDepuisPennylane,
  reglementsDepuisTransactions,
  reglementsNecessaires,
} from "@/lib/pastBfrPennylane";
import {
  chargerEtatFacturesBfr,
  FactureAEnregistrer,
  supprimerFacturesBfrNonRevues,
  upsertFacturesBfr,
} from "@/lib/pastBfrRepository";

// Synchronisation Pennylane -> past_bfr_invoices pour le BFR historique du module "Passé",
// déclenchée à la demande. Lit les factures clients et fournisseurs RÉELLES (payées comprises), et
// date les règlements des factures réglées par leurs transactions rapprochées (un appel par
// facture). Ces dates ne changent pas tant que la facture n'est pas modifiée chez Pennylane : elles
// ne sont redemandées que pour une facture nouvelle ou modifiée (updated_at).
//
// Un appel est borné en nombre de requêtes (limite Pennylane : 25 requêtes / 5 s) : il renvoie le
// nombre de factures dont les règlements restent à dater, et le navigateur rappelle la route
// jusqu'à zéro. Une facture pas encore datée est simplement « au solde inconnu » entre-temps.
//
// L'organisation est toujours dérivée de l'utilisateur connecté. Rien n'est écrit dans les
// situations validées : une synchronisation ne les modifie jamais.

export const maxDuration = 60;

const MESSAGE_ERREUR_SYNC = "La synchronisation des factures Pennylane a échoué. Réessayez.";
const MAX_APPELS_REGLEMENTS = 100;
const BUDGET_MS = 40_000;

const VERS_PENNYLANE: Record<TypeFactureBfr, "customer" | "supplier"> = { client: "customer", fournisseur: "supplier" };

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
  const debut = Date.now();
  const syncedAt = new Date().toISOString();

  try {
    const listes: [TypeFactureBfr, FacturePennylaneBrute[]][] = [
      ["client", (await listCustomerInvoices(provider)) as unknown as FacturePennylaneBrute[]],
      ["fournisseur", (await listSupplierInvoices(provider)) as unknown as FacturePennylaneBrute[]],
    ];
    // Une liste pleine est peut-être tronquée : on n'efface alors rien de ce qui n'a pas été revu.
    const complete = listes.every(([, items]) => items.length < MAX_FACTURES_PAR_LISTE);
    const connu = await chargerEtatFacturesBfr(supabaseAdmin, organizationId);

    const aEnregistrer: FactureAEnregistrer[] = [];
    let appels = 0;
    let restantes = 0;
    for (const [type, items] of listes) {
      for (const item of items) {
        const facture = factureBfrDepuisPennylane(type, item, null);
        if (facture === null) continue;
        const pennylaneUpdatedAt = item.updated_at ?? null;
        if (reglementsNecessaires(facture)) {
          const deja = connu.get(`${type}|${facture.pennylaneId}`);
          const inchangee = deja !== undefined && deja.reglements !== null && pennylaneUpdatedAt !== null && deja.pennylaneUpdatedAt === pennylaneUpdatedAt;
          if (inchangee) {
            facture.reglements = deja.reglements;
          } else if (appels < MAX_APPELS_REGLEMENTS && Date.now() - debut < BUDGET_MS) {
            appels++;
            facture.reglements = reglementsDepuisTransactions(await listMatchedTransactions(provider, VERS_PENNYLANE[type], facture.pennylaneId));
          } else {
            // Pas encore datée : enregistrée sans règlements, et sans date de mise à jour pour être
            // reprise au prochain appel.
            restantes++;
            aEnregistrer.push({ facture, pennylaneUpdatedAt: null });
            continue;
          }
        }
        aEnregistrer.push({ facture, pennylaneUpdatedAt });
      }
    }

    await upsertFacturesBfr(supabaseAdmin, organizationId, aEnregistrer, syncedAt);
    const retirees = complete ? await supprimerFacturesBfrNonRevues(supabaseAdmin, organizationId, syncedAt) : 0;

    console.log(
      `[passe/bfr] OK company=${organizationId} factures=${aEnregistrer.length} reglements_dates=${appels} restantes=${restantes} retirees=${retirees} complete=${complete}`
    );
    return NextResponse.json({ nombreFactures: aEnregistrer.length, restantes, complete, synchroniseesLe: syncedAt });
  } catch (erreur) {
    if (erreur instanceof PennylaneApiError) {
      console.log(`[passe/bfr] Pennylane returned ${erreur.httpStatus ?? "?"} reason=${erreur.reason}`);
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
