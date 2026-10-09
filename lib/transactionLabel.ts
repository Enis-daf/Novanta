/**
 * Normalisation de texte d'un libellé de transaction — EXPÉRIMENTAL. C'est le dernier recours du
 * moteur de regroupement des flux (lib/flowMatching.ts), utilisé quand aucune contrepartie stable
 * ne peut être extraite du libellé.
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

export const MOIS = new Set([
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
