import { finDeMois, moisDe, StockFinDeMois, variationsDeStock } from "./pastAdjustments";
import { libelleMois } from "./pastDetail";
import { Periode } from "./pastTransactions";

/**
 * Données de gestion à compléter du module "Passé" : ce que l'utilisateur doit renseigner lui-même
 * dans Novanta pour qu'un indicateur se lise correctement. Fonctions pures.
 *
 * Chaque NATURE de donnée est une source qui produit des DonneeDeGestionACompleter ; les stocks
 * sont la première. Rien n'est recalculé ici : l'état d'un mois se lit sur variationsDeStock
 * (lib/pastAdjustments.ts), la même série que celle qui alimente la marge brute.
 */

export interface DonneeDeGestionACompleter {
  type: string;
  libelle: string; // ligne principale, courte
  detail: string; // conséquence métier, en info-bulle
  onglet: "stocks"; // où l'utilisateur complète la donnée
}

export type EtatStockDuMois =
  // Stock renseigné, variation calculée depuis le mois précédent — ou point de départ de la série.
  | "complet"
  // Stock renseigné, mais variation calculée par-dessus un mois manquant : périodisation incertaine.
  | "incertain"
  // Aucun stock renseigné pour ce mois, alors que la série a déjà commencé.
  | "manquant";

export interface EtatDesStocks {
  // Mois de la période dont la variation de stock est attendue (voir etatDesStocks), dans l'ordre.
  mois: { mois: string; etat: EtatStockDuMois }[];
  manquants: string[];
  incertains: string[];
}

function moisSuivant(mois: string): string {
  const annee = Number(mois.slice(0, 4));
  const numero = Number(mois.slice(5, 7));
  return numero === 12 ? `${annee + 1}-01` : `${annee}-${String(numero + 1).padStart(2, "0")}`;
}

/** Mois de la période dont la fin est passée : ceux dont le stock de fin de mois peut être connu. */
export function moisTerminesDeLaPeriode(periode: Periode, aujourdhui: string): string[] {
  const mois: string[] = [];
  if (periode.debut > periode.fin) return mois;
  const dernier = moisDe(periode.fin);
  for (let courant = moisDe(periode.debut); courant <= dernier; courant = moisSuivant(courant)) {
    const fin = finDeMois(courant);
    if (fin >= periode.debut && fin <= periode.fin && fin < aujourdhui) mois.push(courant);
  }
  return mois;
}

/**
 * État des stocks sur la période. Un mois est attendu si sa fin :
 *  - tombe dans la période — la variation de stock est datée de la fin de son mois, c'est donc la
 *    condition pour qu'elle entre dans la marge brute de la période ;
 *  - est passée — un stock de fin de mois ne peut pas être connu avant ;
 *  - n'est pas antérieure au premier stock renseigné — ce premier mois est le point de départ de
 *    la série, aucune hypothèse n'est faite sur ce qui le précède.
 *
 * Sans aucun stock renseigné, aucun mois n'est attendu ici : il n'y a pas de série. Ce cas est
 * signalé à part (voir stocksACompleter), sauf si l'organisation s'est déclarée sans stock.
 */
export function etatDesStocks(stocks: StockFinDeMois[], periode: Periode, aujourdhui: string): EtatDesStocks {
  const etat: EtatDesStocks = { mois: [], manquants: [], incertains: [] };
  if (stocks.length === 0) return etat;

  const renseignes = new Set(stocks.map((s) => s.mois));
  const premier = [...renseignes].sort()[0];
  const variations = variationsDeStock(stocks);

  for (const mois of moisTerminesDeLaPeriode(periode, aujourdhui)) {
    if (mois < premier) continue;
    const etatDuMois: EtatStockDuMois = !renseignes.has(mois) ? "manquant" : variations.get(mois)?.discontinue ? "incertain" : "complet";
    etat.mois.push({ mois, etat: etatDuMois });
    if (etatDuMois === "manquant") etat.manquants.push(mois);
    if (etatDuMois === "incertain") etat.incertains.push(mois);
  }
  return etat;
}

const CONSEQUENCE_STOCKS = "La marge brute peut être incomplète tant que les stocks ne sont pas renseignés.";

function enumerer(mois: string[]): string {
  const noms = mois.map((m) => libelleMois(m).toLowerCase());
  return noms.length <= 3 ? noms.join(", ") : `${noms.slice(0, 3).join(", ")} et ${noms.length - 3} autre${noms.length - 3 > 1 ? "s" : ""}`;
}

const AUCUN_STOCK = "Si la société n'a pas de stock, indiquez-le dans l'onglet Stocks.";

/**
 * Le signal « stocks » : absent si tout est complet, « non renseigné » ou « incomplets » sinon.
 *
 * Aucun stock jamais saisi : rien ne distingue une organisation sans stock d'une organisation qui
 * a oublié de le saisir. Le signal est donc donné par défaut, et `sansStock` — la déclaration de
 * l'organisation — le retire. Dès qu'un stock est saisi, cette déclaration ne compte plus.
 */
function stocksACompleter(stocks: StockFinDeMois[], sansStock: boolean, periode: Periode, aujourdhui: string): DonneeDeGestionACompleter | null {
  if (stocks.length === 0) {
    if (sansStock || moisTerminesDeLaPeriode(periode, aujourdhui).length === 0) return null;
    return { type: "inventory", libelle: "Stocks non renseignés", detail: `${CONSEQUENCE_STOCKS} ${AUCUN_STOCK}`, onglet: "stocks" };
  }
  const { mois, manquants, incertains } = etatDesStocks(stocks, periode, aujourdhui);
  if (manquants.length === 0 && incertains.length === 0) return null;

  const details = [CONSEQUENCE_STOCKS];
  if (manquants.length > 0) details.push(`Stock manquant : ${enumerer(manquants)}.`);
  if (incertains.length > 0) details.push(`Périodisation incertaine : ${enumerer(incertains)}.`);

  // « Non renseigné » seulement si aucun mois attendu de la période n'a de stock ; dès qu'une
  // partie est saisie, ou que le calcul est possible mais incertain, ce sont des stocks incomplets.
  const aucunRenseigne = manquants.length === mois.length;
  const libelle = !aucunRenseigne
    ? "Stocks incomplets"
    : manquants.length === 1
      ? `Stock non renseigné pour ${libelleMois(manquants[0]).toLowerCase()}`
      : "Stocks non renseignés";
  return { type: "inventory", libelle, detail: details.join(" "), onglet: "stocks" };
}

export interface SourcesDonneesDeGestion {
  stocks: StockFinDeMois[];
  // L'organisation a déclaré ne pas avoir de stock (past_settings.no_inventory).
  sansStock: boolean;
  periode: Periode;
  aujourdhui: string; // YYYY-MM-DD
}

/** Toutes les données de gestion à compléter pour la période affichée ([] = rien à signaler). */
export function donneesDeGestionACompleter({ stocks, sansStock, periode, aujourdhui }: SourcesDonneesDeGestion): DonneeDeGestionACompleter[] {
  const signaux = [stocksACompleter(stocks, sansStock, periode, aujourdhui)];
  return signaux.filter((s): s is DonneeDeGestionACompleter => s !== null);
}
