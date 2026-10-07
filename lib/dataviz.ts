import { EtagePnl } from "./pastCategoryMapping";
import { CLE_AUTRES, PartStructure, PnlCategorie } from "./pastPnl";

/**
 * Palette dataviz Novanta — SEULE source des couleurs des graphiques du module "Passé". Aucun
 * composant ne code de couleur en dur : il lit cette palette.
 */

// Du plus sombre au plus clair.
export const FAMILLE_ROSE = ["#7A003F", "#98004F", "#B80060", "#D20A76", "#F02894", "#F45AAE", "#F786C4", "#FBB5DB"] as const;
export const FAMILLE_BLEU_VERT = ["#0F766E", "#0D9488", "#14B8A6", "#2DD4BF", "#5EEAD4", "#99F6E4", "#BFEFE4", "#DCFFF5"] as const;

export const NEUTRES = {
  encre: "#030A16",
  secondaire: "#6B7280",
  autres: "#9CA3AF", // réservé à la part "Autres"
  bordure: "#E5E7EB",
  fond: "#FFFEFA",
} as const;

/**
 * Teintes des catégories, dans l'ordre d'attribution : les familles rose et bleu/vert alternent,
 * les teintes les plus fortes vont aux catégories principales, les plus claires aux secondaires.
 * Deux teintes voisines dans cet ordre diffèrent à la fois de famille et de clarté : c'est ce qui
 * les garde distinguables, y compris pour une vision des couleurs altérée (ordre vérifié à
 * l'outil). Jamais recyclées : au-delà, les catégories vont dans "Autres".
 */
export const TEINTES_CATEGORIES = [
  FAMILLE_ROSE[3],
  FAMILLE_BLEU_VERT[2],
  FAMILLE_ROSE[0],
  FAMILLE_BLEU_VERT[5],
  FAMILLE_ROSE[6],
  FAMILLE_BLEU_VERT[0],
  FAMILLE_ROSE[7],
] as const;

export const TEINTE_AUTRES = NEUTRES.autres;

// Séries d'un histogramme : la série unique (ou principale) en rose de marque, une seconde série
// dans l'autre famille.
export const TEINTE_SERIE_PRINCIPALE = FAMILLE_ROSE[4];
export const TEINTE_SERIE_SECONDAIRE = FAMILLE_BLEU_VERT[1];

// Atténuation des éléments non sélectionnés (la sélection, elle, garde sa couleur pleine).
export const OPACITE_ATTENUEE = 0.25;

/**
 * Association stable catégorie -> teinte, partagée par tous les écrans : dans chaque étage P&L,
 * les catégories sont rangées par poids sur la période et reçoivent les teintes dans l'ordre. Une
 * catégorie garde donc sa couleur quand un filtre (mois, catégorie) change ce qui est affiché, et
 * d'un écran à l'autre tant qu'aucune autre catégorie affichée ne porte déjà cette teinte.
 */
export function teintesParCategorie(categories: PnlCategorie[]): Map<string, string> {
  const parEtage = new Map<EtagePnl, PnlCategorie[]>();
  for (const categorie of categories) {
    parEtage.set(categorie.etage, [...(parEtage.get(categorie.etage) ?? []), categorie]);
  }
  const teintes = new Map<string, string>();
  for (const groupe of parEtage.values()) {
    groupe
      .sort((a, b) => Math.abs(b.montant) - Math.abs(a.montant) || a.sourceCategoryName.localeCompare(b.sourceCategoryName, "fr"))
      .slice(0, TEINTES_CATEGORIES.length)
      .forEach((categorie, rang) => teintes.set(categorie.sourceCategoryId, TEINTES_CATEGORIES[rang]));
  }
  return teintes;
}

/**
 * Teinte de chaque part d'un camembert. La teinte attitrée d'une catégorie est respectée tant
 * qu'elle est libre dans ce graphique ; sinon la catégorie prend la première teinte libre. Deux
 * parts n'ont jamais la même couleur ; "Autres" est toujours gris.
 */
export function teintesDesParts(parts: PartStructure[], attitrees?: ReadonlyMap<string, string>): string[] {
  const prises = new Set<string>();
  const resultat: (string | null)[] = parts.map((part) => {
    if (part.cle === CLE_AUTRES) return TEINTE_AUTRES;
    const attitree = attitrees?.get(part.cle);
    if (attitree && !prises.has(attitree)) {
      prises.add(attitree);
      return attitree;
    }
    return null;
  });
  const libres = TEINTES_CATEGORIES.filter((teinte) => !prises.has(teinte));
  return resultat.map((teinte) => teinte ?? libres.shift() ?? TEINTE_AUTRES);
}

/**
 * Graduations "rondes" d'un axe de montants, zéro toujours inclus (un barreau part de zéro) :
 * pas de 1, 2 ou 5 × 10ⁿ, environ 4 intervalles. Renvoie au moins [0, pas].
 */
export function graduationsAxe(valeurs: number[], intervalles = 4): number[] {
  const min = Math.min(0, ...valeurs);
  const max = Math.max(0, ...valeurs);
  const etendue = max - min;
  if (etendue === 0) return [0, 1];
  const brut = etendue / intervalles;
  const puissance = 10 ** Math.floor(Math.log10(brut));
  const pas = [1, 2, 5, 10].map((m) => m * puissance).find((p) => p >= brut)!;
  const graduations: number[] = [];
  for (let k = Math.floor(min / pas); k <= Math.ceil(max / pas); k++) graduations.push(k * pas);
  return graduations;
}
