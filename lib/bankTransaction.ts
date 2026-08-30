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

// Connecteurs génériques du français courant (prépositions/conjonctions), retirés partout dans le
// libellé. Volontairement restreint aux mots qui ne portent jamais d'identité : "LE"/"LA"/"LES" en
// sont exclus car ils peuvent faire partie intégrante d'une raison sociale (ex: "SCI Les Ateliers").
const CONNECTEURS_GENERIQUES = new Set(["A", "AU", "AUX", "DE", "DU", "ET"]);

/**
 * Retire les tokens purement structurels (ex: numéro de carte "X1234"), PARTOUT dans le libellé —
 * pas seulement en tête. Certains libellés bancaires répètent ce vocabulaire au milieu de la chaîne
 * (ex: "Frais virement SEPA Instantané VIREMENT DE 7620,00€"), donc un simple retrait en tête ne
 * suffit pas.
 */
function retirerTokensStructurels(tokens: string[]): string[] {
  return tokens.filter((t) => !PREFIXES_STRUCTURELS.has(t) && !/^X\d+$/.test(t));
}

/** Retire les mois en toutes lettres et les années à 4 chiffres, partout dans le libellé (pas seulement en tête). */
function retirerMoisEtAnnees(tokens: string[]): string[] {
  return tokens.filter((t) => !MOIS_LETTRES.has(t) && !/^(19|20)\d{2}$/.test(t));
}

/** Retire les connecteurs génériques (voir CONNECTEURS_GENERIQUES), partout dans le libellé. */
function retirerConnecteurs(tokens: string[]): string[] {
  return tokens.filter((t) => !CONNECTEURS_GENERIQUES.has(t));
}

/**
 * Retire "FACTURE" et le numéro qui le suit éventuellement (avec ou sans "N°" intermédiaire, ex:
 * "FACTURE N 2623300289819" ou "FACTURE 842") — jamais pertinent pour identifier un bénéficiaire.
 */
function retirerNumeroFacture(tokens: string[]): string[] {
  const resultat: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "FACTURE") {
      resultat.push(tokens[i]);
      continue;
    }
    let j = i + 1;
    if (tokens[j] === "N") j++;
    while (j < tokens.length && /^\d+$/.test(tokens[j])) j++;
    i = j - 1;
  }
  return resultat;
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
 * "PRLV SEPA"...), des mois en toutes lettres ("Loyer Juillet" / "Loyer Août"...), des connecteurs
 * français génériques ("à", "du"...), des numéros de facture ("Facture N°...") et des références
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
  tokens = retirerTokensStructurels(tokens);
  tokens = retirerMoisEtAnnees(tokens);
  tokens = retirerConnecteurs(tokens);
  tokens = retirerNumeroFacture(tokens);
  tokens = retirerReferencesFinales(tokens);

  return tokens.join(" ");
}
