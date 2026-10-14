import { MENTION_TTC } from "@/lib/format";

/**
 * « TTC » discret à côté d'un montant du module Passé : gris secondaire, plus petit, sans fond ni
 * bordure. `avant` (défaut) précède un montant (« TTC 125 k€ ») ; `apres` suit un intitulé
 * (« Montant TTC ») quand la mention vaut pour toute une colonne ou tout un bloc.
 */
export default function MentionTTC({ position = "avant", libelle = MENTION_TTC }: { position?: "avant" | "apres"; libelle?: string }) {
  // Mention de bloc (« montants TTC ») après un intitulé : séparée de lui par un point médian.
  const texte = position === "apres" && libelle !== MENTION_TTC ? `· ${libelle}` : libelle;
  return <span className={`mention-ttc mention-ttc--${position}`}>{texte}</span>;
}

/** Mention d'un tableau ou d'un bloc dont toutes les valeurs sont des montants. */
export const LIBELLE_MONTANTS_TTC = `montants ${MENTION_TTC}`;
