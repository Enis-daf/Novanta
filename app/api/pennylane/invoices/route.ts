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
import {
  getCustomerInvoiceDetail,
  listCustomerInvoices,
  listSupplierInvoices,
  PennylaneApiError,
} from "@/lib/pennylaneClient";
import {
  candidatFactureClient,
  candidatFactureFournisseur,
  CandidatFacturePennylane,
} from "@/lib/pennylaneInvoiceAdapter";
import { cleChiffrementConfiguree } from "@/lib/pennylaneCrypto";
import { MESSAGE_CONFIG_SERVEUR, codeErreurPennylane, messageErreurUtilisationPennylane } from "@/lib/pennylaneMessages";

// Factures déjà connues de Novanta, envoyées par le client pour éviter tout appel détail inutile
// côté factures clients (voir stratégie N+1 bornée, diagnostic §11) : seul l'ensemble
// {pennylaneId, payee} est nécessaire ici, jamais la facture complète.
interface FactureConnue {
  pennylaneId: string;
  payee: boolean;
}

interface RequeteInvoices {
  facturesClientsConnues?: FactureConnue[];
  facturesFournisseursConnues?: FactureConnue[];
}

interface ReponseType {
  clientCandidates: CandidatFacturePennylane[] | null;
  fournisseurCandidates: CandidatFacturePennylane[] | null;
  erreurClients: string | null;
  erreurFournisseurs: string | null;
}

/**
 * Récupère les factures fournisseurs candidates. payment_status est déjà présent dans la liste
 * Pennylane (voir lib/pennylaneClient.ts) : aucun appel détail, un seul aller-retour paginé.
 */
async function candidatsFournisseurs(provider: PennylaneCredentialProvider): Promise<CandidatFacturePennylane[]> {
  const brutes = await listSupplierInvoices(provider);
  const candidats: CandidatFacturePennylane[] = [];
  for (const brute of brutes) {
    const candidat = candidatFactureFournisseur(brute);
    if (candidat) candidats.push(candidat);
  }
  return candidats;
}

/**
 * Récupère les factures clients candidates. La liste Pennylane ne contient PAS payment_status
 * (vérifié empiriquement, voir lib/pennylaneClient.ts) : un appel détail est nécessaire, mais
 * UNIQUEMENT pour les factures que Novanta ne connaît pas encore, ou connaît encore comme non
 * payées — jamais pour une facture déjà marquée Payée côté Novanta (elle n'est plus jamais
 * revérifiée, conformément à la règle "jamais Payée true -> false" : inutile de la re-fetcher).
 * Appels strictement séquentiels (pas de Promise.all en rafale) pour rester sous la limite
 * documentée de 25 requêtes / 5 secondes ; le retry sur 429 déjà présent dans appelerPennylane()
 * absorbe les dépassements ponctuels.
 */
async function candidatsClients(
  provider: PennylaneCredentialProvider,
  facturesConnues: FactureConnue[]
): Promise<CandidatFacturePennylane[]> {
  const idsDejaPayesConnus = new Set(facturesConnues.filter((f) => f.payee).map((f) => f.pennylaneId));

  const liste = await listCustomerInvoices(provider);
  const candidats: CandidatFacturePennylane[] = [];
  for (const item of liste) {
    const id = String(item.id);
    if (idsDejaPayesConnus.has(id)) continue; // terminal, jamais revérifié

    const detail = await getCustomerInvoiceDetail(provider, id);
    const candidat = candidatFactureClient(detail);
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

  let requete: RequeteInvoices;
  try {
    requete = await req.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const facturesClientsConnues = requete.facturesClientsConnues ?? [];
  const facturesFournisseursConnues = requete.facturesFournisseursConnues ?? [];

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
    resultat.clientCandidates = await candidatsClients(provider, facturesClientsConnues);
    console.log(`[pennylane/invoices] clients OK company=${companyId} candidats=${resultat.clientCandidates.length}`);
  } catch (erreur) {
    resultat.erreurClients = await traiterErreur("clients", erreur);
  }

  // facturesFournisseursConnues n'est pas utilisée pour l'instant (les factures fournisseurs
  // n'ont pas besoin d'appel détail), mais est acceptée dans le contrat pour une évolution
  // symétrique future sans changement de forme de requête.
  void facturesFournisseursConnues;

  if (resultat.clientCandidates === null && resultat.fournisseurCandidates === null) {
    // Échec total : un seul message d'erreur exploitable, jamais deux messages redondants.
    return NextResponse.json({ error: resultat.erreurClients ?? resultat.erreurFournisseurs }, { status: 400 });
  }

  return NextResponse.json(resultat);
}
