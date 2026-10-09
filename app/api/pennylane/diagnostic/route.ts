import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { obtenirTokenPennylane } from "@/lib/pennylaneRepository";
import { CompanyApiTokenCredentialProvider } from "@/lib/pennylaneCredentialProvider";
import { listCustomerInvoices, listSupplierInvoices } from "@/lib/pennylaneClient";
import { decisionPaiementClient, decisionPaiementFournisseur } from "@/lib/pennylaneInvoiceAdapter";

/**
 * DIAGNOSTIC TEMPORAIRE, lecture seule — à retirer avant toute fusion dans main.
 *
 * Renvoie la réponse BRUTE de Pennylane pour une liste de numéros de facture, par le même chemin
 * que la synchronisation (app/api/pennylane/invoices/route.ts) : même société, même token, mêmes
 * fonctions de liste, aucun filtre. N'écrit rien, ni dans Supabase ni dans Pennylane, et ne
 * déclenche aucune synchronisation. Désactivé en production.
 */

// Champs recopiés tels que reçus. `champ in item` distingue « absent de la réponse » de « false ».
const CHAMPS = [
  "id", "invoice_number", "label", "amount", "currency_amount", "date", "deadline", "paid", "payment_status", "accounting_status",
  "status", "draft", "remaining_amount_with_tax", "remaining_amount_without_tax", "archived_at",
];

type Brut = Record<string, unknown>;

function extrait(item: Brut): Brut {
  const sortie: Brut = {};
  for (const champ of CHAMPS) sortie[champ] = champ in item ? item[champ] : "<<absent de la réponse>>";
  return sortie;
}

function croisement(items: Brut[], champStatut: string): Record<string, number> {
  const compte: Record<string, number> = {};
  for (const item of items) {
    const cle = `${champStatut}=${String(item[champStatut])} | paid=${"paid" in item ? String(item.paid) : "absent"}`;
    compte[cle] = (compte[cle] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(compte).sort());
}

function rapport(items: Brut[], numeros: string[], champStatut: string, decision: (item: never) => { payee: boolean }) {
  return {
    objetsRecus: items.length,
    champsPresents: items[0] ? Object.keys(items[0]).sort() : [],
    // Comparaison stricte sur le numéro brut : « #594119819 » et « 594119819 » restent deux factures.
    factures: Object.fromEntries(
      numeros.map((numero) => [
        numero,
        items
          .filter((item) => item.invoice_number === numero)
          .map((item) => ({ ...extrait(item), novantaPayee: decision(item as never).payee })),
      ])
    ),
    croisementStatutPaid: croisement(items, champStatut),
  };
}

export async function POST(req: NextRequest) {
  if (process.env.VERCEL_ENV === "production") {
    return NextResponse.json({ error: "Introuvable." }, { status: 404 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Configuration serveur manquante." }, { status: 500 });
  }
  const auth = await requireUser(req);
  if (!auth) {
    return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  }

  const corps = (await req.json().catch(() => ({}))) as { fournisseurs?: unknown; clients?: unknown };
  const numeros = (valeur: unknown) => (Array.isArray(valeur) ? valeur.filter((v): v is string => typeof v === "string") : []);

  try {
    const company = await getOrCreateCompanyForBilling(auth.supabase, auth.user);
    if (!company?.id) return NextResponse.json({ error: "Société introuvable." }, { status: 500 });
    const token = await obtenirTokenPennylane(supabaseAdmin, company.id);
    if (!token) return NextResponse.json({ error: "Aucune connexion Pennylane enregistrée." }, { status: 404 });
    const provider = new CompanyApiTokenCredentialProvider(token);

    const fournisseurs = (await listSupplierInvoices(provider)) as unknown as Brut[];
    const clients = (await listCustomerInvoices(provider)) as unknown as Brut[];
    return NextResponse.json({
      societeNovanta: company.id,
      supplier_invoices: rapport(fournisseurs, numeros(corps.fournisseurs), "payment_status", decisionPaiementFournisseur),
      customer_invoices: rapport(clients, numeros(corps.clients), "status", decisionPaiementClient),
    });
  } catch (erreur) {
    return NextResponse.json({ error: erreur instanceof Error ? erreur.message : "Erreur inattendue." }, { status: 500 });
  }
}
