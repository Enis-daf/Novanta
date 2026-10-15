import { ExclusionFacture, FactureBfr, ReglementBfr, TypeFactureBfr } from "./pastBfr";
import { extraireTiersEtNumero } from "./pennylaneInvoiceAdapter";

/**
 * Factures Pennylane -> faits du BFR historique (lib/pastBfr.ts). Pur, sans réseau.
 *
 * AUDIT DE L'API PENNYLANE V2 (documentation officielle, octobre 2026) — ce qui fonde ce fichier :
 *
 *  Listes GET /customer_invoices et /supplier_invoices (scopes *_invoices:readonly, déjà utilisés
 *  par Novanta), paginées par curseur, toutes factures confondues (payées comprises), filtrables
 *  par date d'émission :
 *   - id stable, invoice_number, date (émission), deadline (échéance), updated_at ;
 *   - amount (TTC en euros), currency, currency_amount, currency_amount_before_tax (HT, devise) ;
 *   - remaining_amount_with_tax / remaining_amount_without_tax : reste dû ACTUEL, TTC et HT
 *     (négatif sur une facture fournisseur tant qu'il reste dû — constaté sur l'API réelle) ;
 *   - clients : status (paid, partially_paid, cancelled, partially_cancelled, credit_note,
 *     archived, draft, proforma, estimate_*...), draft, archived_at, credited_invoice (avoir) ;
 *   - fournisseurs : payment_status, accounting_status, archived_at ; aucun champ ne désigne un
 *     avoir, qui ne se reconnaît qu'à son montant négatif, sans lien vers la facture créditée.
 *
 *  Règlements — aucun historique daté et ventilé n'existe dans ces scopes :
 *   - GET /{type}_invoices/{id}/payments : montant et statut, mais AUCUNE date de règlement
 *     (seulement created_at / updated_at de l'enregistrement), rien d'HT : inutilisable ;
 *   - GET /{type}_invoices/{id}/matched_transactions : les transactions bancaires rapprochées,
 *     AVEC leur date, mais sans la part de chaque transaction affectée à la facture (une
 *     transaction peut régler plusieurs factures), en TTC. Vide pour une facture archivée.
 *   - Le lettrage comptable (GET /ledger_entry_lines, lettered_ledger_entry_lines) demande un
 *     scope de plus (ledger_entries:readonly), reste en TTC et ne porte pas de date de lettrage.
 *
 *  Conséquence : seules les DATES des transactions rapprochées sont exploitées (voir
 *  lib/pastBfr.ts::soldeALaDate) ; leurs montants sont conservés pour l'explication, jamais
 *  soustraits d'un montant HT.
 */

/** Champs lus sur un élément de liste — tous optionnels : rien n'est supposé présent. */
export interface FacturePennylaneBrute {
  id: number | string;
  invoice_number?: string | null;
  label?: string | null;
  date?: string | null;
  deadline?: string | null;
  amount?: string | null;
  currency?: string | null;
  currency_amount?: string | null;
  currency_amount_before_tax?: string | null;
  remaining_amount_with_tax?: string | null;
  remaining_amount_without_tax?: string | null;
  draft?: boolean | null;
  status?: string | null;
  accounting_status?: string | null;
  archived_at?: string | null;
  credited_invoice?: { id?: number | string | null } | null;
  updated_at?: string | null;
}

export interface TransactionRapprocheeBrute {
  id: number | string;
  date?: string | null;
  amount?: string | null;
}

const nombre = (valeur: string | null | undefined): number | null => {
  if (typeof valeur !== "string" || valeur.trim() === "") return null;
  const n = Number(valeur);
  return Number.isFinite(n) ? n : null;
};

// Statuts clients qui ne sont pas des factures émises : devis, pro forma, bons de commande.
const STATUTS_HORS_FACTURE = new Set(["proforma", "shipping_order", "purchasing_order", "incomplete"]);

export function exclusionClient(item: FacturePennylaneBrute, montantTtc: number): ExclusionFacture | null {
  const statut = item.status ?? "";
  if (item.draft === true || statut === "draft") return "brouillon";
  if (statut === "credit_note" || item.credited_invoice?.id != null || montantTtc < 0) return "avoir";
  if (statut === "archived" || item.archived_at) return "archivee";
  if (statut === "cancelled") return "annulee";
  if (STATUTS_HORS_FACTURE.has(statut) || statut.startsWith("estimate")) return "hors_facture";
  return null;
}

export function exclusionFournisseur(item: FacturePennylaneBrute, montantTtc: number): ExclusionFacture | null {
  if (montantTtc < 0) return "avoir";
  if (item.accounting_status === "archived" || item.archived_at) return "archivee";
  return null;
}

/**
 * Montant HT en euros : celui de la facture. En devise, converti au taux de la facture elle-même
 * (amount / currency_amount) — le rapport HT / TTC ne change pas, rien n'est estimé.
 */
function montantHtEuros(item: FacturePennylaneBrute, montantTtc: number): number | null {
  const htDevise = nombre(item.currency_amount_before_tax);
  if (htDevise === null) return null;
  const devise = (item.currency ?? "EUR").toUpperCase();
  if (devise === "EUR") return htDevise;
  const ttcDevise = nombre(item.currency_amount);
  if (ttcDevise === null || ttcDevise === 0) return null;
  return htDevise * (montantTtc / ttcDevise);
}

export function factureBfrDepuisPennylane(
  type: TypeFactureBfr,
  item: FacturePennylaneBrute,
  reglements: ReglementBfr[] | null
): FactureBfr | null {
  const montantTtcSigne = nombre(item.amount);
  if (montantTtcSigne === null) return null;
  const id = String(item.id);
  const { tiers, numero } = extraireTiersEtNumero(item.label ?? null, id, type === "client" ? "Client Pennylane" : "Fournisseur Pennylane");
  const exclusion = type === "client" ? exclusionClient(item, montantTtcSigne) : exclusionFournisseur(item, montantTtcSigne);
  const ht = montantHtEuros(item, montantTtcSigne);
  const resteTtc = nombre(item.remaining_amount_with_tax);
  const resteHt = nombre(item.remaining_amount_without_tax);
  const montantTtc = Math.abs(montantTtcSigne);
  return {
    pennylaneId: id,
    type,
    numero: item.invoice_number || numero,
    tiers,
    dateEmission: item.date ?? null,
    echeance: item.deadline ?? null,
    devise: (item.currency ?? "EUR").toUpperCase(),
    montantTtc,
    montantHt: ht === null ? null : Math.abs(ht),
    // Reste dû absent : la facture est tenue pour non réglée — c'est ce que dit un reste égal au
    // montant, et rien ne permet d'affirmer le contraire.
    resteTtc: resteTtc === null ? montantTtc : Math.abs(resteTtc),
    resteHt: resteHt === null ? null : Math.abs(resteHt),
    exclusion,
    factureAvoireeId: type === "client" && item.credited_invoice?.id != null ? String(item.credited_invoice.id) : null,
    reglements,
  };
}

/**
 * Faut-il dater les règlements de cette facture ? Seulement si une partie en est réglée
 * aujourd'hui : une facture dont rien n'est réglé se lit sans eux (voir soldeALaDate).
 */
export function reglementsNecessaires(facture: FactureBfr): boolean {
  return facture.exclusion === null && facture.resteTtc < facture.montantTtc - 0.01;
}

export function reglementsDepuisTransactions(transactions: TransactionRapprocheeBrute[]): ReglementBfr[] {
  return transactions
    .filter((t) => typeof t.date === "string" && t.date !== "")
    .map((t) => ({ date: (t.date as string).slice(0, 10), montant: Math.abs(nombre(t.amount) ?? 0) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
