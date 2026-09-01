import { PennylaneCredentialProvider } from "./pennylaneCredentialProvider";

/**
 * Client HTTP minimal pour l'API Pennylane V2 — SERVEUR UNIQUEMENT (le token ne doit jamais
 * transiter par le navigateur). Ne fournit que ce dont ce MVP a besoin : lister les transactions
 * bancaires. Ce n'est volontairement PAS un SDK Pennylane complet.
 *
 * Endpoint officiel V2 (documentation Pennylane, https://pennylane.readme.io/reference/gettransactions) :
 *   GET https://app.pennylane.com/api/external/v2/transactions
 *   Authorization: Bearer <Company API Token>
 *   Scope requis : transactions:readonly
 *   Pagination par curseur : ?cursor=...&limit=1..100 -> { items, has_more, next_cursor }
 *   Filtre de date : ?filter=[{"field":"date","operator":"gteq","value":"YYYY-MM-DD"},...]
 *   Rate limit documenté : 25 requêtes / 5 secondes -> 429 + header "retry-after" (secondes).
 *
 * Point non documenté par Pennylane : le signe du champ "amount" (débit/crédit) n'est pas
 * explicité. Ce client suppose la convention standard (négatif = sortie, positif = entrée, comme
 * NormalizedBankTransaction.signedAmount) — À VÉRIFIER avec un vrai token avant mise en production
 * (voir PennylaneTransactionAdapter, mapping isolé sur une seule ligne pour rester trivial à
 * inverser si nécessaire).
 */

const BASE_URL = "https://app.pennylane.com";
const ENDPOINT_TRANSACTIONS = "/api/external/v2/transactions";
const LIMITE_PAR_PAGE = 100; // maximum autorisé par l'API, minimise le nombre d'appels
const MAX_PAGES = 50; // garde-fou : borne la pagination même en cas de réponse inattendue
const MAX_TENTATIVES_RATE_LIMIT = 3;
const TIMEOUT_MS = 15_000;

export type PennylaneErrorReason = "invalid_token" | "insufficient_scope" | "rate_limited" | "unavailable" | "unknown";

/** Erreur typée, jamais un message brut de l'API ou un token exposés à l'appelant. */
export class PennylaneApiError extends Error {
  readonly reason: PennylaneErrorReason;
  constructor(reason: PennylaneErrorReason, message: string) {
    super(message);
    this.name = "PennylaneApiError";
    this.reason = reason;
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

function attendre(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function construireFiltreDate(dateDebut: string, dateFin: string): string {
  return JSON.stringify([
    { field: "date", operator: "gteq", value: dateDebut },
    { field: "date", operator: "lteq", value: dateFin },
  ]);
}

async function appelerPageTransactions(
  bearer: string,
  filtreDate: string,
  cursor: string | null
): Promise<ReponsePaginee> {
  const params = new URLSearchParams({ limit: String(LIMITE_PAR_PAGE), filter: filtreDate, sort: "id" });
  if (cursor) params.set("cursor", cursor);

  for (let tentative = 1; tentative <= MAX_TENTATIVES_RATE_LIMIT; tentative++) {
    const controller = new AbortController();
    const minuteur = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let reponse: Response;
    try {
      reponse = await fetch(`${BASE_URL}${ENDPOINT_TRANSACTIONS}?${params.toString()}`, {
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
      throw new PennylaneApiError("invalid_token", "Token Pennylane invalide ou expiré.");
    }
    if (reponse.status === 403) {
      throw new PennylaneApiError("insufficient_scope", "Le token Pennylane n'a pas les autorisations requises.");
    }
    if (reponse.status === 429) {
      if (tentative === MAX_TENTATIVES_RATE_LIMIT) {
        throw new PennylaneApiError("rate_limited", "Limite de requêtes Pennylane atteinte.");
      }
      const retryAfter = Number(reponse.headers.get("retry-after"));
      await attendre((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2) * 1000);
      continue;
    }
    if (reponse.status >= 500) {
      throw new PennylaneApiError("unavailable", `Pennylane a répondu une erreur serveur (${reponse.status}).`);
    }
    if (!reponse.ok) {
      throw new PennylaneApiError("unknown", `Pennylane a répondu une erreur inattendue (${reponse.status}).`);
    }

    const donnees = (await reponse.json()) as ReponsePaginee;
    return donnees;
  }

  // Inatteignable (la boucle retourne ou lève à chaque itération) — satisfait le typage.
  throw new PennylaneApiError("rate_limited", "Limite de requêtes Pennylane atteinte.");
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
    const reponse = await appelerPageTransactions(bearer, filtreDate, cursor);
    toutes.push(...reponse.items);
    if (!reponse.has_more || !reponse.next_cursor) break;
    cursor = reponse.next_cursor;
  }

  return toutes;
}
