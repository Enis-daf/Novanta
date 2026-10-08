import { parseDateISO, toISODate } from "./dates";
import { EtagePnl } from "./pastCategoryMapping";
import { Periode } from "./pastTransactions";

/**
 * Ajustements de gestion du module "Passé" : écritures analytiques NON bancaires, rattachées à un
 * étage P&L. Ils entrent réellement dans les calculs (KPI, P&L, agrégations mensuelles) mais ne
 * sont jamais des transactions : pas de catégorie source, pas de camembert, pas de contrôle de
 * signe. Fonctions pures.
 *
 * Le moteur est générique : il ne connaît qu'un type, un étage, un montant, une date et un
 * libellé. Chaque NATURE d'ajustement est une source qui produit des AjustementGestion ; la
 * variation de stock est la première (ajustementsDepuisStocks), et la seule fonction de ce fichier
 * qui sache ce qu'est un stock.
 */

export interface AjustementGestion {
  id: string;
  date: string; // YYYY-MM-DD
  label: string;
  montant: number; // signé ; s'ajoute tel quel à l'étage
  etage: EtagePnl;
  type: string; // adjustment_type
  // Précision à porter à la connaissance de l'utilisateur partout où l'ajustement est montré
  // (réserve sur son calcul, contexte de saisie...). Jamais bloquante : le montant compte tel quel.
  notes: string | null;
}

export function moisDe(dateISO: string): string {
  return dateISO.slice(0, 7);
}

/** Dernier jour d'un mois "YYYY-MM". */
export function finDeMois(mois: string): string {
  const debut = parseDateISO(`${mois}-01`);
  return toISODate(new Date(debut.getFullYear(), debut.getMonth() + 1, 0));
}

export function ajustementsDeLaPeriode(ajustements: AjustementGestion[], periode: Periode): AjustementGestion[] {
  return ajustements.filter((a) => a.date >= periode.debut && a.date <= periode.fin);
}

/** Ajustements de même nature (type, libellé, étage) additionnés : une ligne de P&L ou de bloc. */
export interface LigneAjustement {
  cle: string;
  label: string;
  type: string;
  etage: EtagePnl;
  montant: number;
  notes: string[]; // notes distinctes des ajustements regroupés
}

/** Lignes d'ajustements, de la plus significative (en valeur absolue) à la moins significative. */
export function regrouperAjustements(ajustements: AjustementGestion[]): LigneAjustement[] {
  const lignes = new Map<string, LigneAjustement>();
  for (const a of ajustements) {
    const cle = `${a.etage}|${a.type}|${a.label}`;
    const ligne = lignes.get(cle) ?? { cle, label: a.label, type: a.type, etage: a.etage, montant: 0, notes: [] };
    ligne.montant += a.montant;
    if (a.notes && !ligne.notes.includes(a.notes)) ligne.notes.push(a.notes);
    lignes.set(cle, ligne);
  }
  return [...lignes.values()].sort((a, b) => Math.abs(b.montant) - Math.abs(a.montant) || a.label.localeCompare(b.label, "fr"));
}

export function sommeAjustements(ajustements: AjustementGestion[], etages: readonly EtagePnl[]): number {
  return ajustements.reduce((total, a) => (etages.includes(a.etage) ? total + a.montant : total), 0);
}

// --- Source "variation de stock" ---

export interface StockFinDeMois {
  mois: string; // YYYY-MM
  valeur: number;
}

export const TYPE_VARIATION_STOCK = "inventory_variation";
const LIBELLE_VARIATION_STOCK = "Variation de stock";
const ETAGE_VARIATION_STOCK: EtagePnl = "gross_margin";

export interface VariationStock {
  montant: number;
  moisPrecedent: string; // dernier mois renseigné avant celui-ci
  // true si ce n'est pas le mois immédiatement précédent : il manque au moins un mois entre les
  // deux valeurs, donc on ne sait pas sur lequel l'écart s'est réellement produit.
  discontinue: boolean;
}

function moisSuivant(mois: string): string {
  const debut = parseDateISO(`${mois}-01`);
  return toISODate(new Date(debut.getFullYear(), debut.getMonth() + 1, 1)).slice(0, 7);
}

function nomMois(mois: string): string {
  return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(parseDateISO(`${mois}-01`));
}

/**
 * Variation de stock de chaque mois renseigné : stock de fin du mois − dernière valeur de stock
 * connue antérieure. Le premier mois renseigné est le point de départ : il n'a pas de variation
 * (aucune hypothèse sur ce qui précède).
 *
 * S'il manque un ou plusieurs mois entre deux valeurs, la variation est calculée quand même — le
 * P&L garde sa continuité, et la somme des variations reste égale à (dernier stock − premier
 * stock) — mais elle est marquée `discontinue` : sa périodisation est incertaine.
 *
 * Toujours recalculée à partir de la série entière : modifier un stock change la variation de son
 * mois et celle du mois renseigné suivant ; en supprimer un fait du suivant le nouveau point de
 * départ s'il était le premier.
 */
export function variationsDeStock(stocks: StockFinDeMois[]): Map<string, VariationStock> {
  const serie = [...stocks].sort((a, b) => (a.mois < b.mois ? -1 : a.mois > b.mois ? 1 : 0));
  const variations = new Map<string, VariationStock>();
  for (let i = 1; i < serie.length; i++) {
    const precedent = serie[i - 1];
    variations.set(serie[i].mois, {
      montant: serie[i].valeur - precedent.valeur,
      moisPrecedent: precedent.mois,
      discontinue: moisSuivant(precedent.mois) !== serie[i].mois,
    });
  }
  return variations;
}

/** Réserve affichée pour une variation calculée par-dessus un ou plusieurs mois manquants. */
export function notePeriodisationIncertaine(variation: VariationStock): string | null {
  return variation.discontinue
    ? `Périodisation incertaine : variation calculée depuis la dernière valeur connue (${nomMois(variation.moisPrecedent)}), mois intermédiaire manquant.`
    : null;
}

/** Les variations de stock, exposées comme ajustements de gestion datés de la fin de leur mois. */
export function ajustementsDepuisStocks(stocks: StockFinDeMois[]): AjustementGestion[] {
  return [...variationsDeStock(stocks)].map(([mois, variation]) => ({
    id: `${TYPE_VARIATION_STOCK}:${mois}`,
    date: finDeMois(mois),
    label: LIBELLE_VARIATION_STOCK,
    montant: variation.montant,
    etage: ETAGE_VARIATION_STOCK,
    type: TYPE_VARIATION_STOCK,
    notes: notePeriodisationIncertaine(variation),
  }));
}
