import { PennylaneCredentialProvider } from "./pennylaneCredentialProvider";
import { estModeStaging } from "./environnementGuard";

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
 *     Scope requis : customer_invoices:readonly. Pagination PAR CURSEUR, comme /transactions :
 *     { items, has_more, next_cursor }. CORRECTIF IMPORTANT (voir git blame) : une première
 *     version de ce fichier supposait une pagination par ?page=1,2,... et une clé de réponse
 *     "customer_invoices" — déduit à tort d'un connecteur MCP utilisé pendant le diagnostic qui
 *     reformatait sa réponse (résumé "warnings" en prose, clé renommée) au lieu de refléter le
 *     JSON brut de l'API. Vérifié ensuite contre la documentation officielle Pennylane
 *     (readme.io/reference/getcustomerinvoices) : la liste contient déjà invoice_number, paid
 *     (booléen) et draft — donc AUCUN appel détail n'est nécessaire pour déterminer si une facture
 *     cliente est payée (contrairement à ce que le premier diagnostic concluait).
 *   GET https://app.pennylane.com/api/external/v2/supplier_invoices
 *     Scope requis : supplier_invoices:readonly. Même pagination par curseur. La liste contient
 *     déjà invoice_number et paid (booléen) — aucun appel détail nécessaire non plus.
 *   Interprétation "payée" (les deux types de facture) : le booléen paid renvoyé par l'API,
 *     directement — jamais une correspondance de chaîne sur un statut textuel (customer_invoices
 *     et supplier_invoices ont des vocabulaires de statut différents et non strictement alignés :
 *     s'appuyer sur paid est la seule interprétation robuste aux deux). Voir
 *     pennylaneInvoiceAdapter.ts.
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

/**
 * Adresse du serveur mock local, si le mode mock est demandé ET autorisé ; null sinon.
 *
 * Deux modes, jamais mélangés :
 *  - RÉEL (par défaut, partout) : PENNYLANE_API_BASE_URL vide ou absente -> API officielle Pennylane ;
 *  - MOCK (staging uniquement) : PENNYLANE_API_BASE_URL désigne le serveur mock local
 *    (scripts/staging/pennylane-mock.ts), pour rejouer des scénarios déterministes.
 *
 * Hors mode staging la variable est ignorée, et seule une adresse locale est acceptée : un token
 * ne peut donc jamais être envoyé ailleurs qu'à Pennylane ou à cette machine.
 */
function adresseMockPennylane(): string | null {
  const surcharge = (process.env.PENNYLANE_API_BASE_URL ?? "").trim();
  if (!surcharge || !estModeStaging()) return null;
  let hote: string;
  try {
    hote = new URL(surcharge).hostname;
  } catch {
    return null;
  }
  return hote === "localhost" || hote === "127.0.0.1" ? surcharge.replace(/\/+$/, "") : null;
}

export type ModePennylane = "reel" | "mock";

/** Mode Pennylane effectif de ce serveur. "mock" n'est possible qu'en staging. */
export function modePennylane(): ModePennylane {
  return adresseMockPennylane() ? "mock" : "reel";
}

export function baseUrlPennylane(): string {
  return adresseMockPennylane() ?? BASE_URL;
}

const ENDPOINT_ME = "/api/external/v2/me";
const ENDPOINT_TRANSACTIONS = "/api/external/v2/transactions";
const ENDPOINT_CATEGORY_GROUPS = "/api/external/v2/category_groups";
const ENDPOINT_CUSTOMER_INVOICES = "/api/external/v2/customer_invoices";
const ENDPOINT_SUPPLIER_INVOICES = "/api/external/v2/supplier_invoices";
const LIMITE_PAR_PAGE = 100; // maximum autorisé par l'API, minimise le nombre d'appels
const MAX_PAGES = 50; // garde-fou : borne la pagination même en cas de réponse inattendue
const MAX_TENTATIVES_RATE_LIMIT = 3;
const TIMEOUT_MS = 15_000;

/**
 * Cause d'un échec, telle que Pennylane l'a réellement signalée — jamais devinée, jamais
 * regroupée sous une cause voisine :
 *  - invalid_token : 401 ;
 *  - insufficient_scope : 403, le token n'a pas l'autorisation de CET endpoint ;
 *  - not_found : 404, chemin inconnu de Pennylane (erreur Novanta, pas du token) ;
 *  - rate_limited : 429 persistant ;
 *  - unavailable : 5xx, Pennylane en erreur ;
 *  - network : aucune réponse (réseau, délai dépassé, serveur mock arrêté) ;
 *  - unknown : tout autre statut.
 */
export type PennylaneErrorReason =
  | "invalid_token"
  | "insufficient_scope"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "network"
  | "unknown";

/** Erreur typée, jamais un message brut de l'API ou un token exposés à l'appelant. */
export class PennylaneApiError extends Error {
  readonly reason: PennylaneErrorReason;
  readonly httpStatus: number | null;
  // Endpoint appelé (« /api/external/v2/supplier_invoices ») : sert à dire QUELLE autorisation manque.
  readonly endpoint: string | null;
  constructor(reason: PennylaneErrorReason, message: string, httpStatus: number | null = null, endpoint: string | null = null) {
    super(message);
    this.name = "PennylaneApiError";
    this.reason = reason;
    this.httpStatus = httpStatus;
    this.endpoint = endpoint;
  }
}

/**
 * Trace d'un appel Pennylane en échec : endpoint, statut HTTP et cause. Hors Production, l'extrait
 * du corps de l'erreur renvoyée par Pennylane est ajouté pour le diagnostic. Jamais le token, jamais
 * les en-têtes, jamais les paramètres de la requête.
 */
async function journaliserEchec(endpoint: string, reponse: Response | null, reason: PennylaneErrorReason): Promise<void> {
  let detail = "";
  if (reponse && process.env.VERCEL_ENV !== "production") {
    try {
      const corps = (await reponse.text()).replace(/\s+/g, " ").trim();
      if (corps) detail = ` corps=${corps.slice(0, 300)}`;
    } catch {
      // Corps illisible : le statut suffit.
    }
  }
  console.warn(`[pennylane] GET ${endpoint} -> ${reponse ? `HTTP ${reponse.status}` : "aucune réponse"} reason=${reason}${detail}`);
}

/** Catégorie analytique rattachée à une transaction (champ `categories` de la liste). */
export interface PennylaneTransactionCategoryRaw {
  id: number | string;
  label: string | null;
  weight?: string | null; // part de la transaction affectée à cette catégorie, ex. "0.25"
  category_group?: { id: number } | null;
}

export interface PennylaneTransactionRaw {
  id: number;
  date: string; // YYYY-MM-DD
  label: string | null;
  amount: string; // décimal signé, en euros (voir note de convention ci-dessus)
  // Champs également renvoyés par la liste (documentation officielle, getTransactions), utilisés
  // uniquement par le module Passé (lib/pastTransactionAdapters.ts) — optionnels ici pour ne rien
  // imposer aux usages existants.
  categories?: PennylaneTransactionCategoryRaw[] | null;
  created_at?: string | null;
  updated_at?: string | null;
  archived_at?: string | null;
}

// Nombre maximal de transactions qu'un appel à listTransactions peut renvoyer (pagination bornée
// par MAX_PAGES) : un résultat de cette taille exacte est potentiellement tronqué.
export const MAX_TRANSACTIONS_PAR_APPEL = LIMITE_PAR_PAGE * MAX_PAGES;

// --- Factures clients (customer_invoices) ---

/**
 * Élément de LISTE. paid (booléen) et invoice_number sont bien présents ici — vérifié contre la
 * documentation officielle (readme.io/reference/getcustomerinvoices), qui énumère explicitement
 * ces deux champs parmi ceux de la réponse de liste.
 */
export interface PennylaneCustomerInvoiceListItem {
  id: number | string; // observé tantôt en nombre, tantôt en chaîne selon l'appel — toujours normalisé en string par l'adaptateur
  invoice_number: string | null;
  date: string | null;
  label: string | null;
  amount: string; // négatif = avoir, jamais importé comme facture classique
  deadline: string | null;
  paid: boolean;
  draft: boolean;
  // Statut textuel de la facture (« paid », « late », « upcoming », « archived », « cancelled »...) et
  // date d'archivage : lus par pennylaneInvoiceAdapter.ts pour ne pas dépendre du seul booléen paid.
  status?: string | null;
  archived_at?: string | null;
  // Reste à encaisser, TTC, POSITIF tant qu'il reste dû (observé sur l'API réelle : "109088.1" pour
  // une facture ouverte de 109 088,10 €, "0.0" une fois réglée) — voir montantRestantDu.
  remaining_amount_with_tax?: string | null;
  // Devise de la facture (« EUR », « USD »...). `amount` est exprimé en euros ; le reste à payer
  // n'est retenu que pour une facture en euros (voir montantRestantDu).
  currency?: string | null;
}

// --- Factures fournisseurs (supplier_invoices) ---

/** Élément de LISTE — paid et invoice_number déjà présents ici aussi. */
export interface PennylaneSupplierInvoiceListItem {
  id: number | string;
  invoice_number: string | null;
  date: string | null;
  label: string | null;
  amount: string;
  deadline: string | null;
  paid: boolean;
  // Présents dans la liste (documentation officielle, getSupplierInvoices) et indispensables pour
  // interpréter correctement une facture — voir pennylaneInvoiceAdapter.ts :
  //  - payment_status : to_be_processed, to_be_paid, partially_paid, payment_error,
  //    payment_scheduled, payment_in_progress, payment_emitted, payment_found, paid_offline,
  //    fully_paid ;
  //  - accounting_status : draft, archived, entry, validation_needed, complete ;
  //  - archived_at : renseigné quand la facture a été archivée (version remplacée ou écartée).
  payment_status?: string | null;
  accounting_status?: string | null;
  archived_at?: string | null;
  // Montant restant à régler. Sur une facture fournisseur il est NÉGATIF tant qu'il reste dû
  // (-montant = rien de réglé), et vaut "0.0" une fois la facture entièrement couverte.
  remaining_amount_with_tax?: string | null;
  // Voir PennylaneCustomerInvoiceListItem.currency.
  currency?: string | null;
  supplier?: { id: number | string } | null;
}

interface ReponsePagineeGenerique<T> {
  items: T[];
  has_more: boolean;
  next_cursor: string | null;
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
      reponse = await fetch(`${baseUrlPennylane()}${endpoint}?${params.toString()}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (erreur) {
      clearTimeout(minuteur);
      const estAbort = erreur instanceof Error && erreur.name === "AbortError";
      await journaliserEchec(endpoint, null, "network");
      throw new PennylaneApiError(
        "network",
        estAbort ? "Délai d'attente dépassé en contactant Pennylane." : "Impossible de contacter Pennylane.",
        null,
        endpoint
      );
    }
    clearTimeout(minuteur);

    if (reponse.status === 401) {
      await journaliserEchec(endpoint, reponse, "invalid_token");
      throw new PennylaneApiError("invalid_token", "Token Pennylane invalide ou expiré.", 401, endpoint);
    }
    if (reponse.status === 403) {
      await journaliserEchec(endpoint, reponse, "insufficient_scope");
      throw new PennylaneApiError("insufficient_scope", "Le token Pennylane n'a pas les autorisations requises.", 403, endpoint);
    }
    if (reponse.status === 404) {
      // Erreur côté Novanta (mauvais chemin/base URL), jamais imputable au token de l'utilisateur.
      await journaliserEchec(endpoint, reponse, "not_found");
      throw new PennylaneApiError("not_found", `Endpoint Pennylane introuvable : ${endpoint} (404).`, 404, endpoint);
    }
    if (reponse.status === 429) {
      if (tentative === MAX_TENTATIVES_RATE_LIMIT) {
        await journaliserEchec(endpoint, reponse, "rate_limited");
        throw new PennylaneApiError("rate_limited", "Limite de requêtes Pennylane atteinte.", 429, endpoint);
      }
      const retryAfter = Number(reponse.headers.get("retry-after"));
      await attendre((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2) * 1000);
      continue;
    }
    if (reponse.status >= 500) {
      await journaliserEchec(endpoint, reponse, "unavailable");
      throw new PennylaneApiError("unavailable", `Pennylane a répondu une erreur serveur (${reponse.status}).`, reponse.status, endpoint);
    }
    if (!reponse.ok) {
      await journaliserEchec(endpoint, reponse, "unknown");
      throw new PennylaneApiError("unknown", `Pennylane a répondu une erreur inattendue (${reponse.status}).`, reponse.status, endpoint);
    }

    return reponse.json();
  }

  // Inatteignable (la boucle retourne ou lève à chaque itération) — satisfait le typage.
  throw new PennylaneApiError("rate_limited", "Limite de requêtes Pennylane atteinte.", 429, endpoint);
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
 * Pagination par curseur générique, partagée par tous les endpoints de liste V2 (transactions,
 * customer_invoices, supplier_invoices) : { items, has_more, next_cursor }. Centralisée ici après
 * un bug réel où une pagination par numéro de page avait été supposée à tort pour les factures —
 * une seule implémentation, testée une fois, évite de reproduire l'erreur endpoint par endpoint.
 */
async function paginerParCurseur<T>(
  bearer: string,
  endpoint: string,
  paramsBase: Record<string, string>
): Promise<T[]> {
  const toutes: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ ...paramsBase, limit: String(LIMITE_PAR_PAGE) });
    if (cursor) params.set("cursor", cursor);
    const reponse = (await appelerPennylane(bearer, endpoint, params)) as ReponsePagineeGenerique<T>;
    toutes.push(...reponse.items);
    if (!reponse.has_more || !reponse.next_cursor) break;
    cursor = reponse.next_cursor;
  }
  return toutes;
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
  return paginerParCurseur<PennylaneTransactionRaw>(bearer, ENDPOINT_TRANSACTIONS, { filter: filtreDate, sort: "id" });
}

/**
 * Récupère TOUTES les factures clients (customer_invoices), tous statuts confondus — avoirs,
 * brouillons et factures payées inclus : c'est à pennylaneInvoiceAdapter.ts de filtrer, jamais ici.
 * paid et invoice_number sont déjà présents dans cette liste : aucun appel détail nécessaire (voir
 * note d'en-tête de fichier).
 */
export async function listCustomerInvoices(
  credentialProvider: PennylaneCredentialProvider
): Promise<PennylaneCustomerInvoiceListItem[]> {
  const bearer = await credentialProvider.getBearerToken();
  return paginerParCurseur<PennylaneCustomerInvoiceListItem>(bearer, ENDPOINT_CUSTOMER_INVOICES, {});
}

/**
 * Récupère TOUTES les factures fournisseurs (supplier_invoices), tous statuts confondus. paid et
 * invoice_number déjà présents dans cette liste, aucun appel détail nécessaire.
 */
export async function listSupplierInvoices(
  credentialProvider: PennylaneCredentialProvider
): Promise<PennylaneSupplierInvoiceListItem[]> {
  const bearer = await credentialProvider.getBearerToken();
  return paginerParCurseur<PennylaneSupplierInvoiceListItem>(bearer, ENDPOINT_SUPPLIER_INVOICES, {});
}

/** Groupe de catégories analytiques (un "axe" analytique côté Pennylane). */
export interface PennylaneCategoryGroupRaw {
  id: number | string;
  label: string | null;
}

/**
 * Liste les groupes de catégories analytiques (GET /category_groups, pagination par curseur).
 * Scope requis : categories:readonly — DISTINCT de transactions:readonly : un token déjà connecté
 * peut ne pas l'avoir (-> PennylaneApiError "insufficient_scope", à traiter par l'appelant comme
 * "libellés d'axes indisponibles", pas comme une connexion invalide).
 */
export async function listCategoryGroups(
  credentialProvider: PennylaneCredentialProvider
): Promise<PennylaneCategoryGroupRaw[]> {
  const bearer = await credentialProvider.getBearerToken();
  return paginerParCurseur<PennylaneCategoryGroupRaw>(bearer, ENDPOINT_CATEGORY_GROUPS, {});
}
