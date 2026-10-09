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
import { listCustomerInvoices, listSupplierInvoices, PennylaneApiError } from "@/lib/pennylaneClient";
import {
  CandidatFacturePennylane,
  candidatsClientsPennylane,
  candidatsFournisseursPennylane,
  CandidatsPennylane,
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
 * Un seul aller-retour paginé par catégorie : le statut de paiement, le statut comptable et le
 * numéro sont dans les listes Pennylane, aucun appel détail par facture n'est nécessaire. La
 * décision « payée / archivée / doublon » est prise dans lib/pennylaneInvoiceAdapter.ts.
 */
function journaliser(categorie: string, companyId: string, { candidats, statutsInconnus }: CandidatsPennylane) {
  const soldees = (motif: string) => candidats.filter((c) => c.motifSolde === motif).length;
  console.log(
    `[pennylane/invoices] ${categorie} OK company=${companyId} candidats=${candidats.length} payees=${soldees("payee")} archivees=${soldees("archivee")} doublons=${soldees("doublon")}`
  );
  // Statut de paiement que le code ne connaît pas : visible dans les logs plutôt que classé en
  // silence. La facture concernée reste impayée.
  for (const [statut, nombre] of Object.entries(statutsInconnus)) {
    console.warn(`[pennylane/invoices] ${categorie} payment_status inconnu="${statut}" occurrences=${nombre} company=${companyId}`);
  }
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
    const fournisseurs = candidatsFournisseursPennylane(await listSupplierInvoices(provider));
    resultat.fournisseurCandidates = fournisseurs.candidats;
    journaliser("fournisseurs", companyId, fournisseurs);
  } catch (erreur) {
    resultat.erreurFournisseurs = await traiterErreur("fournisseurs", erreur);
  }

  try {
    const clients = candidatsClientsPennylane(await listCustomerInvoices(provider));
    resultat.clientCandidates = clients.candidats;
    journaliser("clients", companyId, clients);
  } catch (erreur) {
    resultat.erreurClients = await traiterErreur("clients", erreur);
  }

  if (resultat.clientCandidates === null && resultat.fournisseurCandidates === null) {
    // Échec total : un seul message d'erreur exploitable, jamais deux messages redondants.
    return NextResponse.json({ error: resultat.erreurClients ?? resultat.erreurFournisseurs }, { status: 400 });
  }

  return NextResponse.json(resultat);
}
