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
 * Formulations bancaires purement structurelles (ne portent jamais d'identité de bénéficiaire) et
 * civilités génériques. Générique et standard sur tout export bancaire français — pas spécifique à
 * un client — donc retiré sans risque de fusionner deux bénéficiaires différents.
 */
const PREFIXES_STRUCTURELS = new Set([
  "VIREMENT",
  "EMIS",
  "RECU",
  "VIR",
  "INST",
  "SEPA",
  "WEB",
  "VERS",
  "PRLV",
  "PRELEVEMENT",
  "PAIEMENT",
  "PAR",
  "CARTE",
  "M",
  "MME",
  "MR",
  "MONSIEUR",
  "MADAME",
  "OU",
]);

const MOIS_LETTRES = new Set([
  "JANVIER",
  "FEVRIER",
  "MARS",
  "AVRIL",
  "MAI",
  "JUIN",
  "JUILLET",
  "AOUT",
  "SEPTEMBRE",
  "OCTOBRE",
  "NOVEMBRE",
  "DECEMBRE",
]);

/** Retire, en tête de libellé, la suite de tokens purement structurels (ex: numéro de carte "X1234"). */
function retirerPrefixesStructurels(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && (PREFIXES_STRUCTURELS.has(tokens[i]) || /^X\d+$/.test(tokens[i]))) {
    i++;
  }
  return tokens.slice(i);
}

/** Retire les mois en toutes lettres et les années à 4 chiffres, partout dans le libellé (pas seulement en tête). */
function retirerMoisEtAnnees(tokens: string[]): string[] {
  return tokens.filter((t) => !MOIS_LETTRES.has(t) && !/^(19|20)\d{2}$/.test(t));
}

/**
 * Retire jusqu'à 2 tokens finaux s'ils ressemblent fortement à une référence technique variable
 * (mélange lettres+chiffres, ou purement numérique et long) — reste conservateur pour ne jamais
 * retirer un token qui porterait une vraie identité.
 */
function retirerReferencesFinales(tokens: string[]): string[] {
  const resultat = [...tokens];
  let retires = 0;
  while (resultat.length > 1 && retires < 2) {
    const dernier = resultat[resultat.length - 1];
    const ressembleReferenceTechnique =
      (/\d/.test(dernier) && /[A-Z]/.test(dernier) && dernier.length >= 5) || /^\d{6,}$/.test(dernier);
    if (!ressembleReferenceTechnique) break;
    resultat.pop();
    retires++;
  }
  return resultat;
}

/**
 * Normalisation déterministe d'un libellé bancaire, utilisée pour rapprocher les occurrences
 * d'un même bénéficiaire malgré des formulations bancaires variables (préfixes "VIREMENT EMIS",
 * "PRLV SEPA"...), des mois en toutes lettres ("Loyer Juillet" / "Loyer Août"...) et des références
 * techniques variables (ex : "PRLV SEPA ADOBE SYSTEMS IRELAND 8J2K39" / "...KJ29DK" / "...92JD03"
 * → même signature).
 *
 * Reste volontairement conservatrice : aucune tentative de compréhension sémantique (pas de NLP,
 * pas d'IA), uniquement des règles de nettoyage génériques et déterministes — jamais spécifiques à
 * un bénéficiaire précis.
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

  let tokens = nettoye.split(" ");
  tokens = retirerPrefixesStructurels(tokens);
  tokens = retirerMoisEtAnnees(tokens);
  tokens = retirerReferencesFinales(tokens);

  return tokens.join(" ");
}
