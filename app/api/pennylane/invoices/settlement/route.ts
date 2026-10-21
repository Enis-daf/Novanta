import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { obtenirTokenPennylane, resumeErreurSupabaseSansSecret } from "@/lib/pennylaneRepository";
import { CompanyApiTokenCredentialProvider } from "@/lib/pennylaneCredentialProvider";
import { listMatchedTransactions, PennylaneApiError } from "@/lib/pennylaneClient";
import { cleChiffrementConfiguree } from "@/lib/pennylaneCrypto";
import { dateDeReglementReel } from "@/lib/pennylaneInvoiceAdapter";

// Règlement réel des factures Pennylane payées : la date de leur dernière transaction bancaire
// rapprochée, écrite dans settled_on (customer_invoices / supplier_invoices). Appelée par le cockpit
// après une synchronisation, pour les seules factures payées encore visibles (voir
// lib/dates.ts::reglementReelARecuperer). Ne sert qu'au masquage des factures payées.
//
// Le navigateur n'envoie que des ids Novanta : la facture, son pennylane_id et sa société sont relus
// en base, bornés à la société de l'utilisateur connecté. Facture sans transaction rapprochée, ou
// erreur Pennylane : rien n'est écrit, le masquage continue de partir de paid_at — jamais une date
// inventée.

export const maxDuration = 60;

const MAX_FACTURES = 50;
const TABLES = { client: "customer_invoices", fournisseur: "supplier_invoices" } as const;
const TYPES_PENNYLANE = { client: "customer", fournisseur: "supplier" } as const;

export async function POST(req: NextRequest) {
  if (!supabaseAdminConfigured || !supabaseAdmin || !cleChiffrementConfiguree()) {
    console.error("[pennylane/settlement] config serveur manquante");
    return NextResponse.json({ error: "Configuration serveur incomplète." }, { status: 500 });
  }
  const auth = await requireUser(req);
  if (!auth) return NextResponse.json({ error: "Authentification requise." }, { status: 401 });

  let corps: { type?: unknown; ids?: unknown };
  try {
    corps = await req.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const type = corps.type;
  if ((type !== "client" && type !== "fournisseur") || !Array.isArray(corps.ids)) {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const ids = corps.ids.filter((id): id is string => typeof id === "string").slice(0, MAX_FACTURES);

  let companyId: string;
  try {
    const company = await getOrCreateCompanyForBilling(auth.supabase, auth.user);
    if (!company?.id) return NextResponse.json({ error: "Société introuvable." }, { status: 500 });
    companyId = company.id;
  } catch (erreur) {
    console.error(`[pennylane/settlement] échec de résolution de la société pour l'utilisateur ${auth.user.id}`, erreur);
    return NextResponse.json({ error: "Société introuvable." }, { status: 500 });
  }

  let token: string | null;
  try {
    token = await obtenirTokenPennylane(supabaseAdmin, companyId);
  } catch (erreur) {
    console.error(`[pennylane/settlement] lecture du credential échouée ${resumeErreurSupabaseSansSecret(erreur)}`);
    return NextResponse.json({ error: "Configuration serveur incomplète." }, { status: 500 });
  }
  if (!token) return NextResponse.json({ error: "Aucune connexion Pennylane enregistrée." }, { status: 404 });

  // Seules les factures de la société, payées, issues de Pennylane et sans date réelle.
  const { data, error } = await supabaseAdmin
    .from(TABLES[type])
    .select("id, pennylane_id")
    .eq("company_id", companyId)
    .eq("paid", true)
    .is("settled_on", null)
    .not("pennylane_id", "is", null)
    .in("id", ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"]);
  if (error) {
    console.error(`[pennylane/settlement] lecture des factures échouée code=${error.code ?? "inconnu"}`);
    return NextResponse.json({ error: "Lecture des factures impossible." }, { status: 500 });
  }

  const provider = new CompanyApiTokenCredentialProvider(token);
  const reglements: { id: string; settledOn: string }[] = [];
  let sansTransaction = 0;
  let erreurs = 0;
  for (const ligne of (data ?? []) as { id: string; pennylane_id: string }[]) {
    try {
      const date = dateDeReglementReel(await listMatchedTransactions(provider, TYPES_PENNYLANE[type], ligne.pennylane_id));
      if (date === null) {
        sansTransaction++;
        continue;
      }
      const { error: erreurEcriture } = await supabaseAdmin.from(TABLES[type]).update({ settled_on: date }).eq("company_id", companyId).eq("id", ligne.id);
      if (erreurEcriture) throw erreurEcriture;
      reglements.push({ id: ligne.id, settledOn: date });
    } catch (erreur) {
      erreurs++;
      // Plafond ou indisponibilité Pennylane : on s'arrête, la prochaine synchronisation reprendra.
      if (erreur instanceof PennylaneApiError && (erreur.reason === "rate_limited" || erreur.reason === "unavailable" || erreur.reason === "invalid_token")) break;
    }
  }

  console.log(
    `[pennylane/settlement] company=${companyId} type=${type} demandees=${ids.length} eligibles=${(data ?? []).length} datees=${reglements.length} sans_transaction=${sansTransaction} erreurs=${erreurs}`
  );
  return NextResponse.json({ reglements });
}
