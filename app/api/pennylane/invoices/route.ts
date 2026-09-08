import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import {
  marquerResultatTestPennylane,
  obtenirTokenPennylane,
  resumeErreurSupabaseSansSecret,
} from "@/lib/pennylaneRepository";
import { CompanyApiTokenCredentialProvider, PennylaneCredentialProvider } from "@/lib/pennylaneCredentialProvider";
import { listCustomerInvoices, listSupplierInvoices, PennylaneApiError } from "@/lib/pennylaneClient";
import {
  candidatFactureClient,
  candidatFactureFournisseur,
  CandidatFacturePennylane,
} from "@/lib/pennylaneInvoiceAdapter";
import { cleChiffrementConfiguree } from "@/lib/pennylaneCrypto";
import { MESSAGE_CONFIG_SERVEUR, codeErreurPennylane, messageErreurUtilisationPennylane } from "@/lib/pennylaneMessages";

interface ReponseType {
  clientCandidates: CandidatFacturePennylane[] | null;
  fournisseurCandidates: CandidatFacturePennylane[] | null;
  erreurClients: string | null;
  erreurFournisseurs: string | null;
}

/**
 * paid (booléen) et invoice_number sont présents directement dans les DEUX listes Pennylane —
 * aucun appel détail par facture n'est nécessaire pour ni l'un ni l'autre type (voir
 * lib/pennylaneClient.ts et lib/pennylaneInvoiceAdapter.ts pour la vérification). Un seul aller-
 * retour paginé par catégorie, quel que soit le volume d'historique.
 */
async function candidatsClients(provider: PennylaneCredentialProvider): Promise<CandidatFacturePennylane[]> {
  const brutes = await listCustomerInvoices(provider);
  const candidats: CandidatFacturePennylane[] = [];
  for (const brute of brutes) {
    const candidat = candidatFactureClient(brute);
    if (candidat) candidats.push(candidat);
  }
  return candidats;
}

async function candidatsFournisseurs(provider: PennylaneCredentialProvider): Promise<CandidatFacturePennylane[]> {
  const brutes = await listSupplierInvoices(provider);
  const candidats: CandidatFacturePennylane[] = [];
  for (const brute of brutes) {
    const candidat = candidatFactureFournisseur(brute);
    if (candidat) candidats.push(candidat);
  }
  return candidats;
}

export async function POST(req: NextRequest) {
  if (!supabaseAdminConfigured || !supabaseAdmin) {
    console.error("[pennylane/invoices] config serveur manquante: SUPABASE_SERVICE_ROLE_KEY absente");
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
  }
  if (!cleChiffrementConfiguree()) {
    console.error("[pennylane/invoices] config serveur manquante: PENNYLANE_TOKEN_ENCRYPTION_KEY absente ou invalide");
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
      console.error(`[pennylane/invoices] company_id introuvable pour l'utilisateur ${user.id}`);
      return NextResponse.json({ error: "Impossible de déterminer votre société. Reconnectez-vous." }, { status: 500 });
    }
    companyId = company.id;
  } catch (erreur) {
    console.error(`[pennylane/invoices] échec de résolution de la société pour l'utilisateur ${user.id}`, erreur);
    return NextResponse.json({ error: "Impossible de déterminer votre société. Reconnectez-vous." }, { status: 500 });
  }

  let token: string | null;
  try {
    token = await obtenirTokenPennylane(supabaseAdmin, companyId);
  } catch (erreur) {
    console.error(`[pennylane/invoices] lecture du credential échouée ${resumeErreurSupabaseSansSecret(erreur)}`);
    return NextResponse.json({ error: MESSAGE_CONFIG_SERVEUR }, { status: 500 });
  }
  if (!token) {
    return NextResponse.json({ error: "Aucune connexion Pennylane enregistrée." }, { status: 404 });
  }

  const provider = new CompanyApiTokenCredentialProvider(token);

  // Comportement atomique délibéré : factures clients et factures fournisseurs utilisent des
  // scopes Pennylane INDÉPENDANTS (customer_invoices:readonly / supplier_invoices:readonly). Un
  // token peut légitimement avoir l'un sans l'autre. Chaque catégorie est donc tentée
  // séparément : un échec sur l'une n'empêche jamais de renvoyer le succès de l'autre — jamais
  // d'échec masqué, jamais de "tout ou rien" artificiel. Voir ImportFactures.tsx pour l'affichage.
  const resultat: ReponseType = {
    clientCandidates: null,
    fournisseurCandidates: null,
    erreurClients: null,
    erreurFournisseurs: null,
  };

  const traiterErreur = async (categorie: "clients" | "fournisseurs", erreur: unknown): Promise<string> => {
    if (erreur instanceof PennylaneApiError) {
      console.log(`[pennylane/invoices] Pennylane returned ${erreur.httpStatus ?? "?"} reason=${erreur.reason} categorie=${categorie}`);
      if (erreur.reason === "invalid_token" || erreur.reason === "insufficient_scope") {
        try {
          await marquerResultatTestPennylane(supabaseAdmin!, companyId, {
            status: "invalid",
            lastErrorCode: codeErreurPennylane(erreur.reason),
          });
        } catch (dbErreur) {
          console.error(`[pennylane/invoices] DB save (statut invalide) failed ${resumeErreurSupabaseSansSecret(dbErreur)}`);
        }
      }
      return messageErreurUtilisationPennylane(erreur.reason);
    }
    console.error(`[pennylane/invoices] erreur inattendue en contactant Pennylane (${categorie})`, erreur);
    return MESSAGE_CONFIG_SERVEUR;
  };

  try {
    resultat.fournisseurCandidates = await candidatsFournisseurs(provider);
    console.log(`[pennylane/invoices] fournisseurs OK company=${companyId} candidats=${resultat.fournisseurCandidates.length}`);
  } catch (erreur) {
    resultat.erreurFournisseurs = await traiterErreur("fournisseurs", erreur);
  }

  try {
    resultat.clientCandidates = await candidatsClients(provider);
    console.log(`[pennylane/invoices] clients OK company=${companyId} candidats=${resultat.clientCandidates.length}`);
  } catch (erreur) {
    resultat.erreurClients = await traiterErreur("clients", erreur);
  }

  if (resultat.clientCandidates === null && resultat.fournisseurCandidates === null) {
    // Échec total : un seul message d'erreur exploitable, jamais deux messages redondants.
    return NextResponse.json({ error: resultat.erreurClients ?? resultat.erreurFournisseurs }, { status: 400 });
  }

  return NextResponse.json(resultat);
}
