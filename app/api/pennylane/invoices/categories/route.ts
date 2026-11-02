import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { chargerDroitsOrganisation, refusOffre } from "@/lib/offres";
import { obtenirTokenPennylane, resumeErreurSupabaseSansSecret } from "@/lib/pennylaneRepository";
import { CompanyApiTokenCredentialProvider } from "@/lib/pennylaneCredentialProvider";
import { listSupplierInvoiceCategories, PennylaneApiError } from "@/lib/pennylaneClient";
import { cleChiffrementConfiguree } from "@/lib/pennylaneCrypto";
import { categoriesDeFacture } from "@/lib/pennylaneInvoiceAdapter";
import type { CategorieFacture } from "@/lib/futurPnl";

// Catégories analytiques des factures fournisseurs Pennylane, pour l'étage P&L de Futur
// (lib/futurPnl.ts). Appelée par le cockpit après une synchronisation, pour les seules factures à
// relire (lib/futurPnl.ts::categoriesARelire). N'écrit QUE pennylane_categories et leur date de
// lecture : jamais pnl_stage_manual (choix de l'utilisateur), jamais un montant ou une date.
//
// Le navigateur n'envoie que des ids Novanta : la facture, son pennylane_id et sa société sont relus
// en base, bornés à la société de l'utilisateur connecté. Erreur Pennylane : rien n'est écrit, la
// facture garde ses catégories précédentes (ou reste « À classer »). Ne dépend pas du module Passé.

export const maxDuration = 60;

const MAX_FACTURES = 50;

export async function POST(req: NextRequest) {
  if (!supabaseAdminConfigured || !supabaseAdmin || !cleChiffrementConfiguree()) {
    console.error("[pennylane/categories] config serveur manquante");
    return NextResponse.json({ error: "Configuration serveur incomplète." }, { status: 500 });
  }
  const auth = await requireUser(req);
  if (!auth) return NextResponse.json({ error: "Authentification requise." }, { status: 401 });

  let corps: { ids?: unknown };
  try {
    corps = await req.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  if (!Array.isArray(corps.ids)) return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  const ids = corps.ids.filter((id): id is string => typeof id === "string").slice(0, MAX_FACTURES);

  let companyId: string;
  try {
    const company = await getOrCreateCompanyForBilling(auth.supabase, auth.user);
    if (!company?.id) return NextResponse.json({ error: "Société introuvable." }, { status: 500 });
    // Route du cockpit Futur (projection de trésorerie) : réservée aux offres qui l'incluent.
    if (!(await chargerDroitsOrganisation(auth.supabase, company.id)).capacites.canViewForecast) {
      return NextResponse.json(refusOffre("canViewForecast"), { status: 403 });
    }
    companyId = company.id;
  } catch (erreur) {
    console.error(`[pennylane/categories] échec de résolution de la société pour l'utilisateur ${auth.user.id}`, erreur);
    return NextResponse.json({ error: "Société introuvable." }, { status: 500 });
  }

  let token: string | null;
  try {
    token = await obtenirTokenPennylane(supabaseAdmin, companyId);
  } catch (erreur) {
    console.error(`[pennylane/categories] lecture du credential échouée ${resumeErreurSupabaseSansSecret(erreur)}`);
    return NextResponse.json({ error: "Configuration serveur incomplète." }, { status: 500 });
  }
  if (!token) return NextResponse.json({ error: "Aucune connexion Pennylane enregistrée." }, { status: 404 });

  // Seules les factures fournisseurs de la société issues de Pennylane.
  const { data, error } = await supabaseAdmin
    .from("supplier_invoices")
    .select("id, pennylane_id")
    .eq("company_id", companyId)
    .not("pennylane_id", "is", null)
    .in("id", ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"]);
  if (error) {
    console.error(`[pennylane/categories] lecture des factures échouée code=${error.code ?? "inconnu"}`);
    return NextResponse.json({ error: "Lecture des factures impossible." }, { status: 500 });
  }

  const provider = new CompanyApiTokenCredentialProvider(token);
  const lues: { id: string; categories: CategorieFacture[]; luesLe: string }[] = [];
  let erreurs = 0;
  for (const ligne of (data ?? []) as { id: string; pennylane_id: string }[]) {
    try {
      const categories = categoriesDeFacture(await listSupplierInvoiceCategories(provider, ligne.pennylane_id));
      const luesLe = new Date().toISOString();
      const { error: erreurEcriture } = await supabaseAdmin
        .from("supplier_invoices")
        .update({ pennylane_categories: categories, pennylane_categories_synced_at: luesLe })
        .eq("company_id", companyId)
        .eq("id", ligne.id);
      if (erreurEcriture) throw erreurEcriture;
      lues.push({ id: ligne.id, categories, luesLe });
    } catch (erreur) {
      erreurs++;
      // Plafond ou indisponibilité Pennylane : on s'arrête, la prochaine synchronisation reprendra.
      if (erreur instanceof PennylaneApiError && (erreur.reason === "rate_limited" || erreur.reason === "unavailable" || erreur.reason === "invalid_token")) break;
      // Colonne absente (migration non passée) : inutile d'insister.
      if (!(erreur instanceof PennylaneApiError)) {
        console.error(`[pennylane/categories] écriture impossible ${resumeErreurSupabaseSansSecret(erreur)}`);
        break;
      }
    }
  }

  console.log(
    `[pennylane/categories] company=${companyId} demandees=${ids.length} eligibles=${(data ?? []).length} lues=${lues.length} categorisees=${lues.filter((l) => l.categories.length > 0).length} erreurs=${erreurs}`
  );
  return NextResponse.json({ lues });
}
