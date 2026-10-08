import { estDateValide } from "./dates";
import type { PennylaneTransactionCategoryRaw, PennylaneTransactionRaw } from "./pennylaneClient";
import {
  AffectationAnalytique,
  GROUPE_EXCEL,
  GROUPE_INCONNU,
  normaliserNomCategorie,
  PastTransactionNormalisee,
} from "./pastTransactions";

/**
 * Normalisation par source vers le modèle interne du module "Passé". Fonctions pures, sans appel
 * réseau ni accès base : chaque source adapte SON format vers PastTransactionNormalisee, jamais
 * l'inverse. Ajouter une source = ajouter un adaptateur ici, sans toucher au tableau ni aux filtres.
 */

/**
 * Toutes les affectations analytiques d'une transaction Pennylane, sans en écarter aucune : le
 * choix d'un axe et d'une catégorie principale est fait à la lecture (lib/pastTransactions.ts),
 * jamais ici. Seules les catégories sans libellé exploitable sont ignorées.
 */
export function affectationsPennylane(
  categories: PennylaneTransactionCategoryRaw[] | null | undefined
): AffectationAnalytique[] {
  const affectations: AffectationAnalytique[] = [];
  for (const categorie of categories ?? []) {
    const nom = normaliserNomCategorie(categorie.label);
    if (nom === null) continue;
    const poids = categorie.weight === null || categorie.weight === undefined ? 1 : Number(categorie.weight);
    affectations.push({
      groupId: categorie.category_group?.id != null ? String(categorie.category_group.id) : GROUPE_INCONNU,
      categoryId: String(categorie.id),
      categoryName: nom,
      weight: Number.isFinite(poids) ? poids : 1,
    });
  }
  return affectations;
}

/**
 * Pennylane -> modèle interne. Les transactions archivées côté Pennylane, ou dont la date ou le
 * montant sont inexploitables, sont écartées. Convention de signe : celle déjà supposée par
 * lib/pennylaneTransactionAdapter.ts (négatif = sortie, positif = entrée). `amount` est exprimé en
 * euros par Pennylane (le montant en devise d'origine est dans currency_amount, non repris).
 */
export function depuisTransactionsPennylane(brutes: PennylaneTransactionRaw[]): PastTransactionNormalisee[] {
  const normalisees: PastTransactionNormalisee[] = [];
  for (const brute of brutes) {
    if (brute.archived_at) continue;
    const montant = Number(brute.amount);
    if (!estDateValide(brute.date) || !Number.isFinite(montant)) continue;
    normalisees.push({
      sourceType: "pennylane",
      sourceTransactionId: String(brute.id),
      importBatchId: null,
      sourceRowIndex: null,
      transactionDate: brute.date,
      label: (brute.label ?? "").trim(),
      amount: montant,
      currency: "EUR",
      affectations: affectationsPennylane(brute.categories),
      sourceCreatedAt: brute.created_at ?? null,
      sourceUpdatedAt: brute.updated_at ?? null,
    });
  }
  return normalisees;
}

/** Ligne d'un fichier Excel déjà lue et validée (date ISO, montant numérique signé). */
export interface LigneExcelPasse {
  date: string; // YYYY-MM-DD
  libelle: string;
  montant: number;
  categorieAnalytique?: string | null;
}

/**
 * Excel -> modèle interne. L'identité d'une ligne est sa position dans son lot d'import
 * (importBatchId + index), jamais date + montant + libellé : deux vraies transactions identiques
 * restent deux lignes. Une ligne Excel n'a ni identifiant de catégorie ni notion d'axe : sa
 * catégorie éventuelle devient une affectation unique dans l'axe GROUPE_EXCEL.
 */
export function depuisLignesExcel(lignes: LigneExcelPasse[], importBatchId: string): PastTransactionNormalisee[] {
  return lignes.map((ligne, index) => {
    const categorie = normaliserNomCategorie(ligne.categorieAnalytique);
    return {
    sourceType: "excel",
    sourceTransactionId: null,
    importBatchId,
    sourceRowIndex: index,
    transactionDate: ligne.date,
    label: ligne.libelle.trim(),
    amount: ligne.montant,
    currency: null,
    affectations: categorie
      ? [{ groupId: GROUPE_EXCEL, categoryId: null, categoryName: categorie, weight: 1 }]
      : [],
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    };
  });
}
