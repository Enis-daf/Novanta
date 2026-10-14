import { modePennylane, PennylaneErrorReason } from "./pennylaneClient";

/**
 * Messages utilisateur Pennylane — jamais de stack trace, de JSON brut, de token ou d'erreur
 * technique. Centralisés ici pour rester cohérents entre toutes les routes.
 */

export const MESSAGE_CONNECTE = "Pennylane connecté";

export const MESSAGE_TOKEN_INVALIDE = "Connexion Pennylane impossible. Vérifiez le token.";
export const MESSAGE_SCOPE_INSUFFISANT =
  "Le token Pennylane ne permet pas de lire les transactions bancaires. Vérifiez ses autorisations.";
export const MESSAGE_INDISPONIBLE = "Pennylane est temporairement indisponible. Réessayez.";
// Panne côté Novanta (config serveur manquante, erreur base de données) — jamais imputable au
// token de l'utilisateur, jamais de détail technique dans le message.
export const MESSAGE_CONFIG_SERVEUR = "La connexion Pennylane ne peut pas être enregistrée pour le moment.";
export const MESSAGE_INJOIGNABLE = "Impossible de joindre Pennylane. Vérifiez la connexion et réessayez.";
export const MESSAGE_LIMITE_REQUETES = "Trop de requêtes envoyées à Pennylane. Réessayez dans quelques instants.";
export const MESSAGE_INTROUVABLE =
  "Pennylane ne reconnaît pas cette demande. C'est une erreur de configuration Novanta, pas de votre token.";
export const MESSAGE_REPONSE_INATTENDUE = "Pennylane a renvoyé une réponse inattendue. Réessayez ; si cela persiste, contactez-nous.";
// Environnement de test uniquement : l'application est réglée sur le serveur mock local et il ne
// répond pas. À ne pas confondre avec une panne de Pennylane ni avec un token invalide.
export const MESSAGE_MOCK_INJOIGNABLE =
  "Mode mock Pennylane : le serveur mock local ne répond pas. Lancez-le (npm run staging:mock), ou redémarrez le staging en mode Pennylane réel (npm run dev:staging).";

/**
 * Ce que chaque endpoint permet de lire, et l'autorisation Pennylane qu'il exige. Un 403 dit
 * QUELLE autorisation manque : un token qui lit les transactions mais pas les factures ne doit
 * jamais être présenté comme incapable de lire les transactions.
 */
const AUTORISATIONS: Record<string, { ressource: string; scope: string }> = {
  "/api/external/v2/transactions": { ressource: "les transactions bancaires", scope: "transactions:readonly" },
  "/api/external/v2/supplier_invoices": { ressource: "les factures fournisseurs", scope: "supplier_invoices:readonly" },
  "/api/external/v2/customer_invoices": { ressource: "les factures clients", scope: "customer_invoices:readonly" },
  "/api/external/v2/category_groups": { ressource: "les catégories analytiques", scope: "categories:readonly" },
};

/** Autorisation manquante, nommée d'après l'endpoint refusé. Sans endpoint connu : transactions. */
export function messageAutorisationManquante(endpoint: string | null = null): string {
  const autorisation = endpoint ? AUTORISATIONS[endpoint] : undefined;
  if (!autorisation) return MESSAGE_SCOPE_INSUFFISANT;
  return `Le token Pennylane ne permet pas de lire ${autorisation.ressource}. Ajoutez-lui l'autorisation ${autorisation.scope} dans Pennylane.`;
}

/** Factures clients ET fournisseurs refusées : un seul message, les deux autorisations nommées. */
export function messageAutorisationsFacturesManquantes(): string {
  return `Le token Pennylane ne permet pas de lire les factures clients ni les factures fournisseurs. Ajoutez-lui les autorisations ${AUTORISATIONS["/api/external/v2/customer_invoices"].scope} et ${AUTORISATIONS["/api/external/v2/supplier_invoices"].scope} dans Pennylane.`;
}

/** Causes communes au test initial et à l'usage d'une connexion : une cause réelle, un message. */
function messageAutreCause(reason: PennylaneErrorReason): string {
  switch (reason) {
    case "rate_limited":
      return MESSAGE_LIMITE_REQUETES;
    case "not_found":
      return MESSAGE_INTROUVABLE;
    case "network":
      return modePennylane() === "mock" ? MESSAGE_MOCK_INJOIGNABLE : MESSAGE_INJOIGNABLE;
    case "unavailable":
      return MESSAGE_INDISPONIBLE;
    default:
      return MESSAGE_REPONSE_INATTENDUE;
  }
}

/**
 * Test initial d'un nouveau token (connexion / remplacement) — GET /me a déjà distingué token
 * invalide de scope insuffisant à ce stade, donc chaque raison a son propre message précis.
 */
export function messageErreurConnexionInitiale(reason: PennylaneErrorReason, endpoint: string | null = null): string {
  if (reason === "invalid_token") return MESSAGE_TOKEN_INVALIDE;
  if (reason === "insufficient_scope") return messageAutorisationManquante(endpoint);
  return messageAutreCause(reason);
}

// Une connexion déjà établie échoue à l'usage (déclenché depuis Identifier mes charges fixes ou
// Vérifier mes données) : message spécifique à la cause, formulé différemment ("n'est plus
// valide") puisque l'utilisateur ne vient pas de saisir ce token à l'instant.
export function messageErreurUtilisationPennylane(reason: PennylaneErrorReason, endpoint: string | null = null): string {
  if (reason === "invalid_token") return "La connexion Pennylane n'est plus valide. Remplacez votre token pour continuer.";
  if (reason === "insufficient_scope") return messageAutorisationManquante(endpoint);
  return messageAutreCause(reason);
}

export const MESSAGE_AUCUNE_TRANSACTION_CHARGES_FIXES = "Aucune transaction exploitable n'a été trouvée sur la période.";
export const MESSAGE_AUCUNE_TRANSACTION_COHERENCE = "Aucune transaction bancaire n'a été trouvée sur les 30 derniers jours.";

/** Code interne stocké en base (last_error_code) à partir d'une raison d'erreur Pennylane. */
export function codeErreurPennylane(reason: PennylaneErrorReason): string {
  return reason;
}
