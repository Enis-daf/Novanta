/**
 * Modèle interne minimal partagé par toutes les sources d'historique bancaire (XLSX aujourd'hui,
 * Pennylane potentiellement demain). Le moteur de détection de récurrences (bankRecurringDetector.ts)
 * ne dépend que de ce type — jamais de la source d'origine — ce qui permet de brancher une future
 * source sans modifier la logique métier.
 *
 * signedAmount : débit = négatif, crédit = positif. Les charges récurrentes ne sont recherchées
 * que parmi les montants négatifs.
 */
export interface NormalizedBankTransaction {
  date: string; // YYYY-MM-DD
  labelOriginal: string;
  labelNormalized: string;
  signedAmount: number;
}

/**
 * Normalisation déterministe d'un libellé bancaire, utilisée pour rapprocher les occurrences
 * d'un même fournisseur malgré des références techniques variables (ex : "PRLV SEPA ADOBE
 * SYSTEMS IRELAND 8J2K39" / "...KJ29DK" / "...92JD03" → même signature).
 *
 * Reste volontairement conservatrice : aucune tentative de compréhension sémantique (pas de NLP,
 * pas d'IA). Au plus 2 tokens finaux sont retirés, uniquement s'ils ressemblent fortement à une
 * référence technique variable (mélange lettres+chiffres, ou purement numérique et long) — pour
 * ne jamais fusionner par erreur deux fournisseurs différents.
 */
export function normaliserLibelleBancaire(labelOriginal: string): string {
  const nettoye = labelOriginal
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!nettoye) return "";

  const tokens = nettoye.split(" ");
  let retires = 0;
  while (tokens.length > 1 && retires < 2) {
    const dernier = tokens[tokens.length - 1];
    const ressembleReferenceTechnique =
      (/\d/.test(dernier) && /[A-Z]/.test(dernier) && dernier.length >= 5) || /^\d{6,}$/.test(dernier);
    if (!ressembleReferenceTechnique) break;
    tokens.pop();
    retires++;
  }

  return tokens.join(" ");
}
