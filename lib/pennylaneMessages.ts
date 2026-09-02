import { PennylaneErrorReason } from "./pennylaneClient";

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

/**
 * Test initial d'un nouveau token (connexion / remplacement) — GET /me a déjà distingué token
 * invalide de scope insuffisant à ce stade, donc chaque raison a son propre message précis.
 */
export function messageErreurConnexionInitiale(reason: PennylaneErrorReason): string {
  switch (reason) {
    case "invalid_token":
      return MESSAGE_TOKEN_INVALIDE;
    case "insufficient_scope":
      return MESSAGE_SCOPE_INSUFFISANT;
    case "rate_limited":
    case "unavailable":
    case "unknown":
    default:
      return MESSAGE_INDISPONIBLE;
  }
}

// Une connexion déjà établie échoue à l'usage (déclenché depuis Identifier mes charges fixes ou
// Vérifier mes données) : message spécifique à la cause, formulé différemment ("n'est plus
// valide") puisque l'utilisateur ne vient pas de saisir ce token à l'instant.
export function messageErreurUtilisationPennylane(reason: PennylaneErrorReason): string {
  switch (reason) {
    case "invalid_token":
      return "La connexion Pennylane n'est plus valide. Remplacez votre token pour continuer.";
    case "insufficient_scope":
      return MESSAGE_SCOPE_INSUFFISANT;
    case "rate_limited":
    case "unavailable":
    case "unknown":
    default:
      return MESSAGE_INDISPONIBLE;
  }
}

export const MESSAGE_AUCUNE_TRANSACTION_CHARGES_FIXES = "Aucune transaction exploitable n'a été trouvée sur la période.";
export const MESSAGE_AUCUNE_TRANSACTION_COHERENCE = "Aucune transaction bancaire n'a été trouvée sur les 30 derniers jours.";

/** Code interne stocké en base (last_error_code) à partir d'une raison d'erreur Pennylane. */
export function codeErreurPennylane(reason: PennylaneErrorReason): string {
  return reason;
}
