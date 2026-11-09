/**
 * Suppression définitive d'un chantier clôturé (fonction action_supprimer_chantier, migration
 * 20261109_action_delete_closed_initiative.sql) : lecture de la réponse, sans accès réseau.
 *
 * La règle elle-même (jamais un chantier actif, sa propre société seulement) est tenue en base ;
 * ce module ne fait que traduire la réponse en une issue et un message.
 */

export type IssueSuppression =
  // Le chantier n'existe plus.
  | { type: "supprime" }
  // Rien à supprimer : déjà supprimé (autre onglet, autre appareil) ou introuvable.
  | { type: "deja_absent" }
  // Le chantier est encore là ; message à afficher sur la fiche.
  | { type: "echec"; raison: "actif" | "droits" | "non_activee" | "serveur"; message: string };

export const MESSAGES_SUPPRESSION = {
  supprime: "Chantier supprimé.",
  deja_absent: "Ce chantier avait déjà été supprimé.",
  actif: "Un chantier actif ne peut pas être supprimé : clôturez-le d'abord.",
  droits: "Vous n'avez pas les droits pour supprimer ce chantier.",
  non_activee: "La suppression des chantiers n'est pas encore activée sur votre espace.",
  serveur: "Suppression impossible pour le moment. Réessayez.",
} as const;

function echec(raison: "actif" | "droits" | "non_activee" | "serveur"): IssueSuppression {
  return { type: "echec", raison, message: MESSAGES_SUPPRESSION[raison] };
}

/** Traduit la réponse de l'appel (données ou erreur) en issue. Toute réponse inattendue est un échec. */
export function issueSuppression(data: unknown, error: unknown): IssueSuppression {
  if (error) {
    const code = (error as { code?: string } | null)?.code;
    // 55000 : chantier encore actif (refus de la fonction).
    if (code === "55000") return echec("actif");
    // 42501 : pas sa société / module non activé ; PGRST301/PGRST302 : session absente ou expirée.
    if (code === "42501" || code === "PGRST301" || code === "PGRST302") return echec("droits");
    // Fonction introuvable : la migration n'a pas été exécutée.
    if (code === "PGRST202" || code === "42883") return echec("non_activee");
    return echec("serveur");
  }
  if (data === "supprime") return { type: "supprime" };
  if (data === "absent") return { type: "deja_absent" };
  return echec("serveur");
}
