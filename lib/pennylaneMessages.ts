import { PennylaneErrorReason } from "./pennylaneClient";

/**
 * Messages utilisateur Pennylane — jamais de stack trace, de JSON brut, de token ou d'erreur
 * technique. Centralisés ici pour rester cohérents entre toutes les routes.
 */

// Test initial d'un nouveau token (connexion / remplacement) : un seul message générique, quelle
// que soit la cause exacte (token invalide, scope insuffisant...) — l'utilisateur est en train de
// saisir un token, pas d'utiliser une connexion déjà établie.
export const MESSAGE_CONNEXION_IMPOSSIBLE = "Connexion Pennylane impossible. Vérifiez le token et ses autorisations.";

export const MESSAGE_CONNECTE = "Pennylane connecté";

// Une connexion déjà établie échoue à l'usage (déclenché depuis Identifier mes charges fixes ou
// Vérifier mes données, ou depuis "Tester la connexion") : message spécifique à la cause.
export function messageErreurUtilisationPennylane(reason: PennylaneErrorReason): string {
  switch (reason) {
    case "invalid_token":
      return "La connexion Pennylane n'est plus valide. Remplacez votre token pour continuer.";
    case "insufficient_scope":
      return "Le token Pennylane ne permet pas de lire les transactions bancaires. Vérifiez ses autorisations.";
    case "rate_limited":
    case "unavailable":
    case "unknown":
    default:
      return "Pennylane est temporairement indisponible. Réessayez.";
  }
}

export const MESSAGE_AUCUNE_TRANSACTION_CHARGES_FIXES = "Aucune transaction exploitable n'a été trouvée sur la période.";
export const MESSAGE_AUCUNE_TRANSACTION_COHERENCE = "Aucune transaction bancaire n'a été trouvée sur les 30 derniers jours.";

/** Code interne stocké en base (last_error_code) à partir d'une raison d'erreur Pennylane. */
export function codeErreurPennylane(reason: PennylaneErrorReason): string {
  return reason;
}
