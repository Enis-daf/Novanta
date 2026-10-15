import { MENTION_HT_ESTIME, MENTION_TTC } from "@/lib/format";

/**
 * Mention « TTC » du module Passé, toujours en SUFFIXE et toujours secondaire (gris, plus petite,
 * graisse normale, sans fond ni bordure). Trois usages, choisis par l'écran :
 *  - après un gros chiffre : « 2 477 907 € TTC » ;
 *  - après le nom d'un indicateur principal du P&L : « Marge brute TTC » ;
 *  - après l'intitulé d'une colonne ou d'un bloc de montants : « Montant TTC », « · montants TTC ».
 * Jamais devant un montant, jamais sur une ligne secondaire où le contexte est déjà posé.
 */
export default function MentionTTC({ libelle = MENTION_TTC }: { libelle?: string }) {
  // Mention de bloc (« montants TTC ») : séparée de l'intitulé par un point médian.
  const mentionSimple = libelle === MENTION_TTC || libelle === MENTION_HT_ESTIME;
  return <span className="mention-ttc">{mentionSimple ? libelle : `· ${libelle}`}</span>;
}

/** Mention d'un tableau ou d'un bloc dont toutes les valeurs sont des montants. */
export const LIBELLE_MONTANTS_TTC = `montants ${MENTION_TTC}`;
