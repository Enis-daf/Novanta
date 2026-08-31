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
 * Formulations bancaires purement structurelles (ne portent jamais d'identité de bénéficiaire),
 * civilités génériques et marqueurs de routage bancaire (XR, ICS, IBAN, BIC...). Générique et
 * standard sur tout export bancaire français — pas spécifique à un client — donc retiré sans risque
 * de fusionner deux bénéficiaires différents.
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
  "XR",
  "ICS",
  "IBAN",
  "BIC",
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

// Qualificatifs juridiques/géographiques génériques : n'apportent aucune valeur d'identification une
// fois qu'un nom de marque/enseigne est déjà présent (ex: "AMAZON BUSINESS EU SARL-SUCCURSA" → le nom
// utile est "Amazon Business", pas sa filiale/zone géographique). Liste générique standard, jamais
// un nom de bénéficiaire.
const QUALIFICATIFS_GENERIQUES = new Set([
  "EU",
  "EUROPE",
  "INTERNATIONAL",
  "GROUP",
  "GROUPE",
  "HOLDING",
  "SUCCURSALE",
  "SUCCURSA",
  "FILIALE",
]);

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

/** Retire les qualificatifs juridiques/géographiques génériques (voir QUALIFICATIFS_GENERIQUES). */
function retirerQualificatifsGeneriques(tokens: string[]): string[] {
  return tokens.filter((t) => !QUALIFICATIFS_GENERIQUES.has(t));
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
 * Retire, dans le texte BRUT (avant tokenisation, tant que les tirets sont encore présents), les
 * références multi-blocs entièrement numériques du type "407-2682920-5134736" (numéro de commande /
 * référence de paiement) : au moins 3 blocs de chiffres séparés par des tirets. Un bloc isolé comme
 * "407" ne ressemble à rien de technique pris seul (trop court) ; c'est la STRUCTURE de la référence
 * complète (plusieurs blocs numériques accolés par des tirets) qui la trahit.
 */
function retirerReferencesMultiBlocs(texte: string): string {
  return texte.replace(/\b\d+(?:-\d+){2,}\b/g, " ");
}

const VOYELLES = new Set(["A", "E", "I", "O", "U", "Y"]);

/**
 * Un token ressemble à une référence technique (à retirer partout, jamais seulement en fin de
 * chaîne) s'il correspond à l'un de ces motifs structurels :
 *  - un seul caractère (ex: "S", "C" — initiales issues d'abréviations bancaires type "S.C.A.") :
 *    jamais un mot ni un nom exploitable ;
 *  - mélange de lettres ET de chiffres, longueur ≥ 5 (ex: "6SI0036K3D5UQ74P", "YYNSV0") ;
 *  - purement numérique, longueur ≥ 6 (ex: "0000000000000002054") ;
 *  - purement alphabétique mais avec une proportion de voyelles anormalement basse (< 25 %) sur au
 *    moins 8 caractères (ex: "DRDMLLAHUPGRSPYGNPOW") — signature d'un code de routage bancaire
 *    plutôt que d'un mot naturel, sans dictionnaire ni IA : uniquement une statistique de caractères
 *    (un vrai mot, même long comme "TELECOMMUNICATIONS", a toujours une proportion de voyelles
 *    normale et n'est donc jamais retiré par cette règle).
 * Exporté pour être réutilisé comme garde-fou final (ne jamais proposer un libellé entièrement
 * technique) et pour les tests.
 */
export function ressembleReferenceTechnique(token: string): boolean {
  if (!token) return false;
  if (token.length === 1) return true;
  const contientChiffre = /\d/.test(token);
  const contientLettre = /[A-Z]/.test(token);
  if (contientChiffre && contientLettre && token.length >= 5) return true;
  if (contientChiffre && !contientLettre && token.length >= 6) return true;
  if (!contientChiffre && contientLettre && token.length >= 8) {
    const voyelles = [...token].filter((c) => VOYELLES.has(c)).length;
    if (voyelles / token.length < 0.25) return true;
  }
  return false;
}

/** Retire, PARTOUT dans le libellé, tout token ressemblant à une référence technique (voir ci-dessus). */
function retirerTokensTechniques(tokens: string[]): string[] {
  return tokens.filter((t) => !ressembleReferenceTechnique(t));
}

/**
 * Normalisation déterministe d'un libellé bancaire, utilisée pour rapprocher les occurrences
 * d'un même bénéficiaire malgré des formulations bancaires variables (préfixes "VIREMENT EMIS",
 * "PRLV SEPA"...), des mois en toutes lettres ("Loyer Juillet" / "Loyer Août"...), des connecteurs
 * français génériques ("à", "du"...), des qualificatifs juridiques/géographiques génériques ("EU",
 * "Succursale"...), des numéros de facture ("Facture N°...") et des références techniques (numéros
 * de commande multi-blocs, identifiants alphanumériques longs, codes de routage bancaire type
 * "XR:...", IBAN-like "LU39ZZZ...").
 *
 * Reste volontairement conservatrice : aucune tentative de compréhension sémantique (pas de NLP,
 * pas d'IA), uniquement des règles de nettoyage génériques et déterministes (listes de mots
 * structurels + statistiques de caractères) — jamais spécifiques à un bénéficiaire précis.
 */
export function normaliserLibelleBancaire(labelOriginal: string): string {
  const sansReferencesMultiBlocs = retirerReferencesMultiBlocs(labelOriginal);

  const nettoye = sansReferencesMultiBlocs
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
  tokens = retirerQualificatifsGeneriques(tokens);
  tokens = retirerNumeroFacture(tokens);
  tokens = retirerTokensTechniques(tokens);

  return tokens.join(" ");
}
