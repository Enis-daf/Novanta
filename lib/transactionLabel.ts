/**
 * Rapprochement de libellés de transactions pour la comparaison de périodes — EXPÉRIMENTAL.
 *
 * Seul endroit où vivent ces règles : aucun composant ne normalise un libellé lui-même. Logique
 * déterministe, explicable et testable, sans référentiel de tiers, sans alias à maintenir, sans IA.
 *
 * Priorité absolue : PRÉCISION > COUVERTURE. Un rapprochement évident est fait, un rapprochement
 * ambigu ne l'est pas : mieux vaut laisser séparés deux libellés du même tiers que réunir à tort
 * deux tiers différents. Le libellé d'origine n'est jamais modifié ; la forme normalisée ne sert
 * qu'à comparer, et uniquement à l'intérieur d'une même catégorie (voir lib/pastVariance.ts).
 *
 * Règles, dans l'ordre :
 *  1. minuscules, accents retirés ;
 *  2. dates évidentes retirées (12/09/2026, 09/2026, 09/26, 2026-09) ;
 *  3. ponctuation et tirets remplacés par des espaces, espaces réduits ;
 *  4. noms de mois français et anglais retirés, entiers ou abrégés — SAUF en première position
 *     (« Mai Consulting », « Mars Wrigley » gardent leur premier mot) ;
 *  5. une année (4 ou 2 chiffres) ou un quantième ne sont retirés que collés à un mois retiré :
 *     « septembre 2026 », « 12 septembre 26 ». Hors de ce contexte temporel, un nombre n'est
 *     JAMAIS retiré : « Facture 2026 », « Facture 26 », « ABC 1234 » restent tels quels ;
 *  6. un libellé purement temporel (« Septembre 2026 ») donne une chaîne vide, que l'appelant ne
 *     rapproche d'aucune autre.
 */

const MOIS = new Set([
  // Français (accents déjà retirés à ce stade).
  "janvier", "janv", "jan", "fevrier", "fevr", "fev", "mars", "avril", "avr", "mai", "juin", "juillet", "juil",
  "aout", "septembre", "sept", "sep", "octobre", "oct", "novembre", "nov", "decembre", "dec",
  // Anglais.
  "january", "february", "feb", "march", "mar", "april", "apr", "may", "june", "jun", "july", "jul", "august",
  "aug", "september", "october", "november", "december",
]);

const MOIS_NUM = "(?:0?[1-9]|1[0-2])";
const JOUR_NUM = "(?:0?[1-9]|[12]\\d|3[01])";
const ANNEE_4 = "(?:19|20)\\d{2}";

// Dates écrites en chiffres. L'année sur 2 chiffres n'est acceptée qu'avec des barres obliques :
// « 12-09-26 » ou « 09-26 » ressemblent trop à une référence pour être retirés.
const DATES_EVIDENTES = [
  new RegExp(`(?<!\\d)${JOUR_NUM}[/.\\-]${MOIS_NUM}[/.\\-]${ANNEE_4}(?!\\d)`, "g"), // 12/09/2026
  new RegExp(`(?<!\\d)${JOUR_NUM}/${MOIS_NUM}/\\d{2}(?!\\d)`, "g"), // 12/09/26
  new RegExp(`(?<!\\d)${ANNEE_4}-${MOIS_NUM}(?:-${JOUR_NUM})?(?!\\d)`, "g"), // 2026-09, 2026-09-12
  new RegExp(`(?<!\\d)${MOIS_NUM}[/.\\-]${ANNEE_4}(?!\\d)`, "g"), // 09/2026
  new RegExp(`(?<!\\d)${MOIS_NUM}/\\d{2}(?!\\d)`, "g"), // 09/26
];

const estAnnee = (jeton: string) => new RegExp(`^(?:${ANNEE_4}|\\d{2})$`).test(jeton);
const estAnnee4 = (jeton: string) => new RegExp(`^${ANNEE_4}$`).test(jeton);
const estQuantieme = (jeton: string) => new RegExp(`^${JOUR_NUM}$`).test(jeton);

export function normalizeTransactionLabel(label: string): string {
  let texte = label
    .toLocaleLowerCase("fr")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  for (const date of DATES_EVIDENTES) texte = texte.replace(date, " ");
  const jetons = texte
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (jetons.length === 0) return "";

  // Libellé purement temporel : uniquement des mois, des années et des quantièmes.
  if (jetons.some((j) => MOIS.has(j)) && jetons.every((j) => MOIS.has(j) || estAnnee(j) || estQuantieme(j))) return "";

  const retire = jetons.map((jeton, index) => index > 0 && MOIS.has(jeton));
  jetons.forEach((jeton, index) => {
    if (retire[index] || MOIS.has(jeton)) return;
    // Année juste après un mois retiré (« septembre 2026 », « septembre 26 »), ou année sur 4
    // chiffres juste avant (« 2026 septembre »).
    const apresMois = index > 0 && retire[index - 1] && MOIS.has(jetons[index - 1]);
    const avantMois = index + 1 < jetons.length && retire[index + 1];
    if ((apresMois && estAnnee(jeton)) || (avantMois && estAnnee4(jeton))) retire[index] = true;
    // Quantième juste avant un mois retiré (« 12 septembre »).
    else if (avantMois && estQuantieme(jeton)) retire[index] = true;
  });
  return jetons.filter((_, index) => !retire[index]).join(" ");
}

// --- Flux comparable : ce qui fait qu'un ensemble de transactions est « le même flux » ---

/** Champs d'un prélèvement SEPA lus dans son libellé bancaire. */
export interface PrelevementSepa {
  idEmetteur: string; // identifiant créancier SEPA (ICS) : stable pour un créancier donné
  mandat: string | null; // référence unique de mandat (MDT / RUM) : stable pour un contrat donné
  creancier: string; // texte libre avant les champs balisés
  lib: string; // contenu du champ LIB, tel quel
}

const BALISE = "(?:ECH|ID\\s*EMETTEUR|MDT|REF|LIB)";
const champ = (nom: string) => new RegExp(`\\b${nom}\\s*[/:]\\s*(\\S+)`, "i");

/**
 * Lit les champs balisés d'un prélèvement SEPA (« ID EMETTEUR/… MDT/… REF/… LIB/… », séparateur
 * « / » ou « : »). null si le libellé n'a pas d'identifiant émetteur : ce n'est pas un prélèvement
 * reconnaissable, on ne devine rien.
 */
export function analyserPrelevementSepa(label: string): PrelevementSepa | null {
  const idEmetteur = label.match(champ("ID\\s*EMETTEUR"))?.[1];
  if (!idEmetteur) return null;
  const lib = label.match(new RegExp(`\\bLIB\\s*[/:]\\s*(.*?)(?=\\s+${BALISE}\\s*[/:]|$)`, "i"))?.[1] ?? "";
  const creancier = label
    .replace(new RegExp(`\\b${BALISE}\\s*[/:].*$`, "i"), "")
    .replace(/^\s*(?:PRLV|PRELEVEMENT)(?:\s+SEPA)?\b/i, "");
  return {
    idEmetteur: idEmetteur.toUpperCase(),
    mandat: label.match(champ("MDT"))?.[1]?.toUpperCase() ?? null,
    creancier: creancier.trim(),
    lib: lib.trim(),
  };
}

// Jeton « référence » : mélange de lettres et de chiffres, ou longue suite de chiffres. Dans un
// champ LIB, c'est un numéro de facture ou de paiement qui change à chaque échéance.
const estReferenceVolatile = (jeton: string) =>
  (jeton.length >= 6 && /\d/.test(jeton) && /[a-z]/.test(jeton)) || /^\d{6,}$/.test(jeton);

/**
 * Partie stable du champ LIB d'un prélèvement : sa forme normalisée, sans les références qui
 * changent d'une échéance à l'autre (« FACEBOOK ADS BW6UVZ4AOC » -> « facebook ads »). La valeur
 * du champ REF, quand elle est répétée dans LIB, est retirée en priorité.
 */
export function libStablePrelevement(label: string): string {
  const prelevement = analyserPrelevementSepa(label);
  if (!prelevement) return "";
  const reference = label.match(champ("REF"))?.[1]?.toLowerCase();
  return normalizeTransactionLabel(prelevement.lib)
    .split(" ")
    .filter((jeton) => jeton !== "" && jeton !== reference && !estReferenceVolatile(jeton))
    .join(" ");
}

function enTitre(texte: string): string {
  return texte.replace(/(^|\s)(\p{L})/gu, (_, espace: string, lettre: string) => espace + lettre.toLocaleUpperCase("fr"));
}

export interface FluxComparable {
  // Clé de regroupement À L'INTÉRIEUR d'une catégorie ; null = à ne rapprocher d'aucune autre ligne.
  cle: string | null;
  // 1 : prélèvement SEPA, même émetteur et même mandat (haute confiance).
  // 2 : prélèvement SEPA sans mandat, même émetteur et même LIB stable.
  // 3 : texte normalisé identique.
  niveau: 1 | 2 | 3;
  // Titre lisible du groupe, tiré de la partie stable — jamais le libellé bancaire complet, qui
  // reste visible dans le détail des transactions.
  titre: string;
}

/**
 * Flux auquel appartient une transaction, du critère le plus sûr au plus faible. Ce qui change à
 * chaque échéance (ECH, REF, numéro de facture, suffixe de référence dans LIB) n'entre JAMAIS dans
 * la clé : cinq prélèvements du même mandat sont un seul flux, pas cinq.
 */
export function fluxComparable(label: string): FluxComparable {
  const prelevement = analyserPrelevementSepa(label);
  if (prelevement) {
    const libStable = libStablePrelevement(label);
    const titre = enTitre(libStable || normalizeTransactionLabel(prelevement.creancier) || prelevement.idEmetteur);
    if (prelevement.mandat) return { cle: `sepa:${prelevement.idEmetteur}:${prelevement.mandat}`, niveau: 1, titre };
    if (libStable) return { cle: `sepa:${prelevement.idEmetteur}:lib:${libStable}`, niveau: 2, titre };
  }
  const normalise = normalizeTransactionLabel(label);
  return { cle: normalise === "" ? null : `texte:${normalise}`, niveau: 3, titre: normalise === "" ? label.trim() : enTitre(normalise) };
}

/**
 * Clé de comparaison d'un libellé. Vide quand la normalisation ne laisse rien : l'appelant ne doit
 * alors rapprocher la ligne d'aucune autre — il n'existe jamais de groupe commun « vide ».
 */
export function cleLibelleComparable(label: string): string {
  return normalizeTransactionLabel(label);
}
