import { formatMontantComptable, MENTION_TTC } from "./format";
import { AjustementGestion } from "./pastAdjustments";
import { MappingCategorie, ventilerTransaction } from "./pastCategoryMapping";
import { calculerPnlEnBase, PnlEnBase } from "./pastHtEstime";
import { PastTransactionStockee } from "./pastTransactions";

/**
 * P&L cash estimé : présentation du reporting du module Passé, exclusivement en HT estimé — pur, sans
 * effet de bord. Aucun moteur de plus : tous les montants viennent de calculerPnlEnBase (lecture HT),
 * mêmes taux, mêmes ajustements, mêmes transactions.
 *
 * Revenus -> Coûts directs (+ variation de stock) -> Marge brute -> Autres coûts variables -> Marge
 * contributive -> Coûts de structure -> EBITDA -> Autres éléments (Extra P&L) -> Solde de gestion.
 *
 * Le Solde de gestion estimé est la dernière ligne : ni TVA payée ou remboursée, ni virements internes
 * et financement, ni variation de trésorerie. Ces flux restent lus en TTC à l'écran Cash flow et dans
 * l'Analyse d'écarts ; ils ne sont pas des charges économiques.
 *
 * Les flux sans affectation (fluxHorsPnl) ne sont ni convertis en HT ni intégrés à une marge : leur
 * affectation est inconnue. Ils sont chiffrés à part, avec leur signe, et les marges sont dites
 * incomplètes tant qu'il en reste.
 */

export const TITRE_PNL_CASH_ESTIME = "P&L cash estimé";
export const LIBELLE_REVENUS_HT_ESTIMES = "Revenus HT estimés";
export const LIBELLE_AUTRES_ELEMENTS = "Autres éléments (Extra P&L)";
export const LIBELLE_SOLDE_GESTION_ESTIME = "Solde de gestion estimé";
export const LIBELLE_NON_CATEGORISE = "Non catégorisé";
export const LIBELLE_NON_MAPPE = "Catégories à mapper";

// Reliquat de pondération négligeable : un arrondi de la source, pas un montant sans affectation.
const TOLERANCE_POIDS = 1e-6;

export interface CumulFlux {
  montant: number; // signé : jamais de valeur absolue
  encaissements: number;
  decaissements: number;
}

export interface CategorieNonMappee extends CumulFlux {
  sourceCategoryId: string;
  sourceCategoryName: string;
}

export interface FluxHorsPnl {
  // Aucune catégorie exploitable sur l'axe retenu, ou part de pondération attribuée à aucune catégorie.
  nonCategorise: CumulFlux & { nombreTransactions: number };
  // La catégorie existe dans la source, il lui manque un étage : une correction de paramétrage.
  nonMappe: CumulFlux & { categories: CategorieNonMappee[] };
  // Même chose, mois par mois, pour l'écran Cash flow filtré sur un mois.
  parMois: ReadonlyMap<string, { nonCategorise: number; nonMappe: number }>;
  incomplet: boolean;
}

function cumul(): CumulFlux {
  return { montant: 0, encaissements: 0, decaissements: 0 };
}

function ajouter(c: CumulFlux, montant: number) {
  c.montant += montant;
  if (montant >= 0) c.encaissements += montant;
  else c.decaissements += montant;
}

/**
 * Tout ce qu'une transaction porte sans arriver à un étage : la somme de ces flux et des étages
 * redonne exactement la somme des transactions (voir le test « aucun flux ne disparaît »).
 */
export function fluxHorsPnl(
  transactions: PastTransactionStockee[],
  axeId: string | null,
  mappings: ReadonlyMap<string, MappingCategorie>
): FluxHorsPnl {
  const nonCategorise = { ...cumul(), nombreTransactions: 0 };
  const nonMappe = cumul();
  const categories = new Map<string, CategorieNonMappee>();
  const parMois = new Map<string, { nonCategorise: number; nonMappe: number }>();
  const duMois = (date: string) => {
    const mois = date.slice(0, 7);
    const ligne = parMois.get(mois) ?? { nonCategorise: 0, nonMappe: 0 };
    parMois.set(mois, ligne);
    return ligne;
  };

  for (const transaction of transactions) {
    const parts = ventilerTransaction(transaction, axeId);
    const poids = parts.reduce((somme, part) => somme + part.weight, 0);
    if (poids < 1 - TOLERANCE_POIDS) {
      const reliquat = transaction.amount * (1 - poids);
      ajouter(nonCategorise, reliquat);
      nonCategorise.nombreTransactions += 1;
      duMois(transaction.transactionDate).nonCategorise += reliquat;
    }
    for (const part of parts) {
      if (mappings.get(part.sourceCategoryId)?.pnlStage) continue;
      ajouter(nonMappe, part.montant);
      duMois(transaction.transactionDate).nonMappe += part.montant;
      const categorie = categories.get(part.sourceCategoryId) ?? {
        ...cumul(),
        sourceCategoryId: part.sourceCategoryId,
        sourceCategoryName: mappings.get(part.sourceCategoryId)?.sourceCategoryName ?? part.sourceCategoryName,
      };
      ajouter(categorie, part.montant);
      categories.set(part.sourceCategoryId, categorie);
    }
  }

  return {
    nonCategorise,
    nonMappe: {
      ...nonMappe,
      categories: [...categories.values()].sort((a, b) => Math.abs(b.montant) - Math.abs(a.montant)),
    },
    parMois,
    incomplet: nonCategorise.nombreTransactions > 0 || categories.size > 0,
  };
}

/** « Encaissements 120 € · décaissements (80 €) » : le net seul pourrait masquer le volume en jeu. */
export function libelleBrut(flux: CumulFlux): string {
  return `Encaissements ${formatMontantComptable(flux.encaissements)} · décaissements ${formatMontantComptable(flux.decaissements)}`;
}

/** Avertissements de tête du rapport PDF : les mêmes flux que l'écran, avec leur signe. */
export function lignesAvertissementFlux(flux: FluxHorsPnl): string[] {
  const lignes: string[] = [];
  const { nonCategorise, nonMappe } = flux;
  if (nonCategorise.nombreTransactions > 0) {
    lignes.push(`${LIBELLE_NON_CATEGORISE} : ${formatMontantComptable(nonCategorise.montant)} ${MENTION_TTC} sur ${nonCategorise.nombreTransactions} transaction${nonCategorise.nombreTransactions > 1 ? "s" : ""} (${libelleBrut(nonCategorise).toLocaleLowerCase("fr")}), hors P&L.`);
  }
  if (nonMappe.categories.length > 0) {
    lignes.push(`${LIBELLE_NON_MAPPE} : ${formatMontantComptable(nonMappe.montant)} ${MENTION_TTC} sur ${nonMappe.categories.length} catégorie${nonMappe.categories.length > 1 ? "s" : ""} (${libelleBrut(nonMappe).toLocaleLowerCase("fr")}), hors P&L.`);
  }
  if (flux.incomplet) lignes.push("Marges incomplètes tant que ces flux ne sont pas affectés.");
  return lignes;
}

export interface LignesFinalesCashFlow {
  lignes: { libelle: string; montant: number }[];
  libelleTotal: string;
  total: number;
}

/**
 * Lignes finales de l'écran Cash flow : le résultat affiché, puis ce qui n'a pas d'affectation, avec
 * son signe. Sur un mois filtré, seuls les flux de ce mois. null quand rien n'est à signaler : l'écran
 * reste alors tel quel.
 */
export function lignesFinalesDuCashFlow(montantAffiche: number, flux: FluxHorsPnl, mois: string | null): LignesFinalesCashFlow | null {
  const portee = mois === null ? { nonCategorise: flux.nonCategorise.montant, nonMappe: flux.nonMappe.montant } : (flux.parMois.get(mois) ?? { nonCategorise: 0, nonMappe: 0 });
  const lignes = [
    { libelle: LIBELLE_NON_MAPPE, montant: portee.nonMappe },
    { libelle: LIBELLE_NON_CATEGORISE, montant: portee.nonCategorise },
  ].filter((ligne) => ligne.montant !== 0);
  if (lignes.length === 0) return null;
  return { lignes, libelleTotal: "Total des flux, sans affectation compris", total: lignes.reduce((total, ligne) => total + ligne.montant, montantAffiche) };
}

export interface PnlCashEstime extends PnlEnBase {
  base: "ht";
  // EBITDA + Autres éléments, ajustements de gestion de ces étages compris.
  soldeGestionEstime: number;
  flux: FluxHorsPnl;
}

export function calculerPnlCashEstime(
  transactions: PastTransactionStockee[],
  axeId: string | null,
  mappings: ReadonlyMap<string, MappingCategorie>,
  ajustements: AjustementGestion[]
): PnlCashEstime {
  const pnl = calculerPnlEnBase(transactions, axeId, mappings, ajustements, "ht");
  return {
    ...pnl,
    base: "ht",
    // En lecture HT, ce champ vaut déjà EBITDA HT + Extra P&L HT, sans TVA ni financement.
    soldeGestionEstime: pnl.cashFlowOperationnel,
    flux: fluxHorsPnl(transactions, axeId, mappings),
  };
}
