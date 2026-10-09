import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { obtenirTokenPennylane } from "@/lib/pennylaneRepository";
import { CompanyApiTokenCredentialProvider } from "@/lib/pennylaneCredentialProvider";
import { listSupplierInvoices } from "@/lib/pennylaneClient";

/**
 * DIAGNOSTIC TEMPORAIRE, lecture seule — à retirer avant toute fusion dans main.
 *
 * Deux modes, uniquement des GET vers Pennylane, aucune écriture nulle part, aucune synchronisation :
 *  - "liste"  : toutes les factures fournisseurs (même appel que la synchronisation), réduites aux
 *               champs utiles au statut payé ;
 *  - "detail" : pour quelques identifiants, les transactions rapprochées et les paiements ;
 *  - "brut"   : l'objet complet (sans lignes ni lien de fichier) de quelques numéros de facture.
 * Désactivé en production.
 */
export const maxDuration = 60;

const BASE = "https://app.pennylane.com";
const MAX_IDS_PAR_APPEL = 10;

type Brut = Record<string, unknown>;

const estPrimitif = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

/** Ne garde que les champs simples d'un objet imbriqué : lisible, sans sous-payload. */
function champsSimples(item: Brut): Brut {
  return Object.fromEntries(Object.entries(item).filter(([, v]) => estPrimitif(v)));
}

/** Liste imbriquée telle que renvoyée dans la liste : tableau en ligne, ou simple lien { url }. */
function resumeImbrique(valeur: unknown): unknown {
  if (Array.isArray(valeur)) return { enLigne: true, nombre: valeur.length, elements: valeur.slice(0, 20).map((v) => champsSimples(v as Brut)) };
  if (valeur && typeof valeur === "object") return { enLigne: false, cles: Object.keys(valeur as Brut) };
  return valeur ?? "<<absent>>";
}

async function lireSousRessource(token: string, id: string, ressource: "matched_transactions" | "payments"): Promise<unknown> {
  const elements: Brut[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    let reponse: Response | null = null;
    for (let tentative = 0; tentative < 3; tentative++) {
      reponse = await fetch(`${BASE}/api/external/v2/supplier_invoices/${encodeURIComponent(id)}/${ressource}?${params}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (reponse.status !== 429) break;
      await new Promise((r) => setTimeout(r, (Number(reponse!.headers.get("retry-after")) || 2) * 1000));
    }
    if (!reponse || !reponse.ok) return { erreur: `HTTP ${reponse?.status ?? "?"}` };
    const corps = (await reponse.json()) as { items?: Brut[]; has_more?: boolean; next_cursor?: string | null };
    elements.push(...(corps.items ?? []));
    if (!corps.has_more || !corps.next_cursor) break;
    cursor = corps.next_cursor;
  }
  return { nombre: elements.length, elements: elements.map(champsSimples) };
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
  const corps = (await req.json().catch(() => ({}))) as { mode?: unknown; ids?: unknown; numeros?: unknown };

  try {
    const company = await getOrCreateCompanyForBilling(auth.supabase, auth.user);
    if (!company?.id) return NextResponse.json({ error: "Société introuvable." }, { status: 500 });
    const token = await obtenirTokenPennylane(supabaseAdmin, company.id);
    if (!token) return NextResponse.json({ error: "Aucune connexion Pennylane enregistrée." }, { status: 404 });

    if (corps.mode === "detail") {
      const ids = (Array.isArray(corps.ids) ? corps.ids : []).filter((v): v is string => typeof v === "string" && /^\d+$/.test(v));
      const details = await Promise.all(
        ids.slice(0, MAX_IDS_PAR_APPEL).map(async (id) => ({
          id,
          matched_transactions: await lireSousRessource(token, id, "matched_transactions"),
          payments: await lireSousRessource(token, id, "payments"),
        }))
      );
      return NextResponse.json({ details });
    }

    const items = (await listSupplierInvoices(new CompanyApiTokenCredentialProvider(token))) as unknown as Brut[];

    if (corps.mode === "brut") {
      const numeros = (Array.isArray(corps.numeros) ? corps.numeros : []).filter((v): v is string => typeof v === "string").slice(0, 10);
      const exclus = new Set(["public_file_url", "invoice_lines", "matched_transactions", "payments"]);
      return NextResponse.json({
        factures: items
          .filter((item) => numeros.includes(String(item.invoice_number)))
          .map((item) => Object.fromEntries(Object.entries(item).filter(([cle]) => !exclus.has(cle)))),
      });
    }

    return NextResponse.json({
      societeNovanta: company.id,
      objetsRecus: items.length,
      // Forme réelle des champs imbriqués, sur le premier objet : en ligne ou simple lien.
      formeImbriquee: items[0]
        ? { matched_transactions: resumeImbrique(items[0].matched_transactions), payments: resumeImbrique(items[0].payments) }
        : null,
      factures: items.map((item) => ({
        id: String(item.id),
        invoice_number: item.invoice_number ?? null,
        label: item.label ?? null,
        amount: item.amount ?? null,
        date: item.date ?? null,
        deadline: item.deadline ?? null,
        paid: "paid" in item ? item.paid : "<<absent>>",
        payment_status: item.payment_status ?? null,
        accounting_status: item.accounting_status ?? null,
        archived_at: item.archived_at ?? null,
        remaining_amount_with_tax: item.remaining_amount_with_tax ?? null,
        reconciled: "reconciled" in item ? item.reconciled : "<<absent>>",
        matched_transactions: Array.isArray(item.matched_transactions) ? resumeImbrique(item.matched_transactions) : undefined,
        payments: Array.isArray(item.payments) ? resumeImbrique(item.payments) : undefined,
      })),
    });
  } catch (erreur) {
    return NextResponse.json({ error: erreur instanceof Error ? erreur.message : "Erreur inattendue." }, { status: 500 });
  }
}
