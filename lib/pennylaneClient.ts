import { PennylaneCredentialProvider } from "./pennylaneCredentialProvider";

/**
 * Client HTTP minimal pour l'API Pennylane V2 — SERVEUR UNIQUEMENT (le token ne doit jamais
 * transiter par le navigateur). Ne fournit que ce dont ce MVP a besoin : valider un token
 * (getMe) et lister les transactions bancaires (listTransactions). Ce n'est volontairement PAS
 * un SDK Pennylane complet.
 *
 * Endpoints officiels V2 (documentation Pennylane, https://pennylane.readme.io) :
 *   GET https://app.pennylane.com/api/external/v2/me
 *     -> valide un token QUELS QUE SOIENT ses scopes (utilisé pour distinguer "token invalide"
 *        de "token valide mais scope insuffisant" — voir getMe).
 *   GET https://app.pennylane.com/api/external/v2/transactions
 *     Scope requis : transactions:readonly (ou transactions:all, non utilisé par Novanta)
 *     Pagination par curseur : ?cursor=...&limit=1..100 -> { items, has_more, next_cursor }
 *     Filtre de date : ?filter=[{"field":"date","operator":"gteq","value":"YYYY-MM-DD"},...]
 *   GET https://app.pennylane.com/api/external/v2/customer_invoices
 *     Scope requis : customer_invoices:readonly. Pagination PAR NUMÉRO DE PAGE (?page=1,2,...),
 *     PAS par curseur — différent de /transactions, vérifié empiriquement (voir
 *     pennylaneInvoiceAdapter.ts pour le détail de la vérification). 100 résultats/page.
 *     Champs de la LISTE : id, date, label, amount (négatif = avoir), currency, accountants_status
 *     (workflow comptable, PAS le statut de paiement), deadline, url. NE CONTIENT PAS
 *     payment_status ni customer_name/number — nécessite un appel détail (ci-dessous).
 *   GET https://app.pennylane.com/api/external/v2/customer_invoices/{id}
 *     Détail d'une facture : ajoute notamment number, customer_name, draft, et surtout
 *     payment_status (séparé de accountants_status) — seule source fiable du statut de paiement
 *     pour les factures clients, vérifiée en direct sur une facture réelle.
 *   GET https://app.pennylane.com/api/external/v2/supplier_invoices
 *     Scope requis : supplier_invoices:readonly. Même pagination par page. Champs de la LISTE :
 *     id, date, label, amount, currency, payment_status, deadline, paid_at, url — payment_status
 *     EST déjà présent dans la liste (contrairement aux factures clients), aucun appel détail
 *     nécessaire pour déterminer le statut de paiement.
 *     Valeurs réelles et complètes de payment_status (obtenues par une erreur de validation de
 *     l'API elle-même, donc faisant foi) : to_be_processed, to_be_paid, partially_paid,
 *     payment_error, payment_scheduled, payment_in_progress, payment_emitted, payment_found,
 *     paid_offline, fully_paid. Voir pennylaneInvoiceAdapter.ts pour l'interprétation métier.
 *   Authorization: Bearer <Company API Token> sur tous les endpoints.
 *   Rate limit documenté : 25 requêtes / 5 secondes -> 429 + header "retry-after" (secondes).
 *
 * Codes de statut gérés explicitement : 200 (ok), 401 (token absent/invalide), 403 (scope
 * insuffisant), 404 (endpoint/base URL incorrect — erreur Novanta, pas celle de l'utilisateur),
 * 429 (rate limit, avec retry), 5xx (Pennylane indisponible).
 *
 * Point non documenté par Pennylane : le signe du champ "amount" (débit/crédit) n'est pas
 * explicité. PennylaneTransactionAdapter suppose la convention standard (négatif = sortie,
 * positif = entrée, comme NormalizedBankTransaction.signedAmount) — À VÉRIFIER avec un vrai
 * token avant mise en production.
 */

const BASE_URL = "https://app.pennylane.com";
const ENDPOINT_ME = "/api/external/v2/me";
const ENDPOINT_TRANSACTIONS = "/api/external/v2/transactions";
const ENDPOINT_CUSTOMER_INVOICES = "/api/external/v2/customer_invoices";
const ENDPOINT_SUPPLIER_INVOICES = "/api/external/v2/supplier_invoices";
const LIMITE_PAR_PAGE = 100; // maximum autorisé par l'API, minimise le nombre d'appels
const MAX_PAGES = 50; // garde-fou : borne la pagination même en cas de réponse inattendue
const MAX_TENTATIVES_RATE_LIMIT = 3;
const TIMEOUT_MS = 15_000;

export type PennylaneErrorReason = "invalid_token" | "insufficient_scope" | "rate_limited" | "unavailable" | "unknown";

/** Erreur typée, jamais un message brut de l'API ou un token exposés à l'appelant. */
export class PennylaneApiError extends Error {
  readonly reason: PennylaneErrorReason;
  readonly httpStatus: number | null;
  constructor(reason: PennylaneErrorReason, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "PennylaneApiError";
    this.reason = reason;
    this.httpStatus = httpStatus;
  }
}

export interface PennylaneTransactionRaw {
  id: number;
  date: string; // YYYY-MM-DD
  label: string | null;
  amount: string; // décimal signé, en euros (voir note de convention ci-dessus)
}

interface ReponsePaginee {
  items: PennylaneTransactionRaw[];
  has_more: boolean;
  next_cursor: string | null;
}

// --- Factures clients (customer_invoices) ---

/** Élément de LISTE — ne contient PAS payment_status (voir note d'en-tête de fichier). */
export interface PennylaneCustomerInvoiceListItem {
  id: number | string; // observé tantôt en nombre, tantôt en chaîne selon l'appel — toujours normalisé en string par l'adaptateur
  date: string | null;
  label: string | null;
  amount: string; // négatif = avoir, jamais importé comme facture classique
  deadline: string | null;
}

/** Réponse du détail d'UNE facture cliente — seule source de payment_status. */
export interface PennylaneCustomerInvoiceDetail {
  id: number | string;
  number: string | null;
  date: string | null;
  deadline: string | null;
  amount: string;
  draft: boolean;
  payment_status: string;
  customer_name: string | null;
}

interface ReponseListeCustomerInvoices {
  customer_invoices: PennylaneCustomerInvoiceListItem[];
}

// --- Factures fournisseurs (supplier_invoices) ---

/** Élément de LISTE — payment_status déjà présent ici (contrairement aux factures clients). */
export interface PennylaneSupplierInvoiceListItem {
  id: number | string;
  date: string | null;
  label: string | null;
  amount: string;
  deadline: string | null;
  payment_status: string;
  paid_at: string | null;
}

interface ReponseListeSupplierInvoices {
  supplier_invoices: PennylaneSupplierInvoiceListItem[];
}

function attendre(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function construireFiltreDate(dateDebut: string, dateFin: string): string {
  return JSON.stringify([
    { field: "date", operator: "gteq", value: dateDebut },
    { field: "date", operator: "lteq", value: dateFin },
  ]);
}

/**
 * Appel HTTP bas niveau partagé par getMe() et listTransactions() : mêmes règles d'authentification,
 * de timeout, de retry sur 429, et de mapping code HTTP -> PennylaneApiError pour les deux endpoints.
 */
async function appelerPennylane(bearer: string, endpoint: string, params: URLSearchParams): Promise<unknown> {
  for (let tentative = 1; tentative <= MAX_TENTATIVES_RATE_LIMIT; tentative++) {
    const controller = new AbortController();
    const minuteur = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let reponse: Response;
    try {
      reponse = await fetch(`${BASE_URL}${endpoint}?${params.toString()}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (erreur) {
      clearTimeout(minuteur);
      const estAbort = erreur instanceof Error && erreur.name === "AbortError";
      throw new PennylaneApiError(
        "unavailable",
        estAbort ? "Délai d'attente dépassé en contactant Pennylane." : "Impossible de contacter Pennylane."
      );
    }
    clearTimeout(minuteur);

    if (reponse.status === 401) {
      throw new PennylaneApiError("invalid_token", "Token Pennylane invalide ou expiré.", 401);
    }
    if (reponse.status === 403) {
      throw new PennylaneApiError("insufficient_scope", "Le token Pennylane n'a pas les autorisations requises.", 403);
    }
    if (reponse.status === 404) {
      // Erreur côté Novanta (mauvais chemin/base URL), jamais imputable au token de l'utilisateur.
      throw new PennylaneApiError("unknown", `Endpoint Pennylane introuvable : ${endpoint} (404).`, 404);
    }
    if (reponse.status === 429) {
      if (tentative === MAX_TENTATIVES_RATE_LIMIT) {
        throw new PennylaneApiError("rate_limited", "Limite de requêtes Pennylane atteinte.", 429);
      }
      const retryAfter = Number(reponse.headers.get("retry-after"));
      await attendre((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2) * 1000);
      continue;
    }
    if (reponse.status >= 500) {
      throw new PennylaneApiError("unavailable", `Pennylane a répondu une erreur serveur (${reponse.status}).`, reponse.status);
    }
    if (!reponse.ok) {
      throw new PennylaneApiError("unknown", `Pennylane a répondu une erreur inattendue (${reponse.status}).`, reponse.status);
    }

    return reponse.json();
  }

  // Inatteignable (la boucle retourne ou lève à chaque itération) — satisfait le typage.
  throw new PennylaneApiError("rate_limited", "Limite de requêtes Pennylane atteinte.");
}

/**
 * Valide un Company API Token via GET /api/external/v2/me, qui répond 200 pour un token valide
 * QUEL QUE SOIT son scope (documentation Pennylane). C'est le test à utiliser pour distinguer
 * "token absent/invalide" (401) de "token valide mais scope transactions manquant" (détecté
 * séparément par listTransactions -> 403) — jamais confondus dans un seul appel.
 */
export async function getMe(credentialProvider: PennylaneCredentialProvider): Promise<void> {
  const bearer = await credentialProvider.getBearerToken();
  await appelerPennylane(bearer, ENDPOINT_ME, new URLSearchParams());
}

/**
 * Récupère toutes les transactions bancaires Pennylane dont la date est comprise entre dateDebut
 * et dateFin (bornes incluses, YYYY-MM-DD), en paginant automatiquement. Le filtre de date est
 * appliqué côté API Pennylane — jamais récupéré en entier puis filtré côté serveur Novanta.
 */
export async function listTransactions(
  credentialProvider: PennylaneCredentialProvider,
  dateDebut: string,
  dateFin: string
): Promise<PennylaneTransactionRaw[]> {
  const bearer = await credentialProvider.getBearerToken();
  const filtreDate = construireFiltreDate(dateDebut, dateFin);

  const toutes: PennylaneTransactionRaw[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(LIMITE_PAR_PAGE), filter: filtreDate, sort: "id" });
    if (cursor) params.set("cursor", cursor);
    const reponse = (await appelerPennylane(bearer, ENDPOINT_TRANSACTIONS, params)) as ReponsePaginee;
    toutes.push(...reponse.items);
    if (!reponse.has_more || !reponse.next_cursor) break;
    cursor = reponse.next_cursor;
  }

  return toutes;
}

/**
 * Récupère TOUTES les factures clients (customer_invoices), tous statuts confondus — avoirs,
 * brouillons et factures payées inclus : c'est à pennylaneInvoiceAdapter.ts de filtrer, jamais ici.
 * Pagination par NUMÉRO DE PAGE (voir note d'en-tête) : la boucle s'arrête dès qu'une page renvoie
 * moins de LIMITE_PAR_PAGE éléments, sans dépendre d'un champ de métadonnées "dernière page" —
 * fonctionne quelle que soit la forme exacte de la réponse.
 */
export async function listCustomerInvoices(
  credentialProvider: PennylaneCredentialProvider
): Promise<PennylaneCustomerInvoiceListItem[]> {
  const bearer = await credentialProvider.getBearerToken();
  const toutes: PennylaneCustomerInvoiceListItem[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({ page: String(page) });
    const reponse = (await appelerPennylane(bearer, ENDPOINT_CUSTOMER_INVOICES, params)) as ReponseListeCustomerInvoices;
    const items = reponse.customer_invoices ?? [];
    toutes.push(...items);
    if (items.length < LIMITE_PAR_PAGE) break;
  }
  return toutes;
}

/**
 * Détail d'UNE facture cliente — seul moyen de connaître son payment_status (absent de la liste).
 * Appelé par l'adaptateur uniquement pour les factures candidates (nouvelles ou déjà connues et
 * encore non payées côté Novanta), jamais pour l'historique complet — voir pennylaneInvoiceAdapter.ts.
 */
export async function getCustomerInvoiceDetail(
  credentialProvider: PennylaneCredentialProvider,
  invoiceId: string
): Promise<PennylaneCustomerInvoiceDetail> {
  const bearer = await credentialProvider.getBearerToken();
  return (await appelerPennylane(
    bearer,
    `${ENDPOINT_CUSTOMER_INVOICES}/${encodeURIComponent(invoiceId)}`,
    new URLSearchParams()
  )) as PennylaneCustomerInvoiceDetail;
}

/**
 * Récupère TOUTES les factures fournisseurs (supplier_invoices), tous statuts confondus.
 * payment_status est déjà présent dans cette liste : aucun appel détail nécessaire, contrairement
 * aux factures clients (voir note d'en-tête de fichier).
 */
export async function listSupplierInvoices(
  credentialProvider: PennylaneCredentialProvider
): Promise<PennylaneSupplierInvoiceListItem[]> {
  const bearer = await credentialProvider.getBearerToken();
  const toutes: PennylaneSupplierInvoiceListItem[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({ page: String(page) });
    const reponse = (await appelerPennylane(bearer, ENDPOINT_SUPPLIER_INVOICES, params)) as ReponseListeSupplierInvoices;
    const items = reponse.supplier_invoices ?? [];
    toutes.push(...items);
    if (items.length < LIMITE_PAR_PAGE) break;
  }
  return toutes;
}
