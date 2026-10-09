import {
  normaliserNomCategorie,
  PastTransaction,
  PastTransactionNormalisee,
  PastTransactionStockee,
} from "./pastTransactions";

/**
 * Structure analytique V1 du module "Passé" : catégorie source -> étage P&L fixe. Fonctions pures.
 *
 * L'étage n'est jamais stocké sur une transaction : il se résout à la lecture, par la catégorie de
 * la transaction et le mapping COURANT de l'organisation (resoudreEtagePnl). Modifier un mapping
 * reclasse donc tout l'historique sans réécrire la moindre transaction.
 */

// Les libellés nomment ce que l'étage CONTIENT (les coûts qui mènent à la marge), pas le solde
// qu'il produit : la clé gross_margin porte les "Coûts directs", dont on déduit la marge brute.
// Les 5 étages, fixes en V1 : ni création, ni suppression, ni renommage par l'utilisateur. Les clés
// sont stables (stockées en base, voir la contrainte de past_category_mappings.pnl_stage).
export const ETAGES_PNL = [
  { cle: "revenue", libelle: "CA" },
  { cle: "gross_margin", libelle: "Coûts directs" },
  { cle: "contribution_margin", libelle: "Autres coûts variables" },
  { cle: "ebitda", libelle: "Coûts de structure" },
  { cle: "extra_pnl", libelle: "Extra P&L" },
] as const;

export type EtagePnl = (typeof ETAGES_PNL)[number]["cle"];

export function estEtagePnl(valeur: unknown): valeur is EtagePnl {
  return ETAGES_PNL.some((e) => e.cle === valeur);
}

export function libelleEtagePnl(etage: EtagePnl): string {
  return ETAGES_PNL.find((e) => e.cle === etage)!.libelle;
}

/** Ligne de past_category_mappings. pnlStage null = catégorie connue, pas encore rattachée. */
export interface MappingCategorie {
  sourceCategoryId: string;
  sourceCategoryName: string;
  sourceGroupId: string | null;
  pnlStage: EtagePnl | null;
}

/** Catégorie rencontrée par une synchronisation, à faire connaître à la table de mapping. */
export interface CategorieSource {
  sourceCategoryId: string;
  sourceCategoryName: string;
  sourceGroupId: string;
}

/**
 * Identité d'une catégorie source : son identifiant stable quand la source en fournit un
 * (Pennylane) ; à défaut seulement, une clé dérivée de son nom (ligne de fichier Excel).
 */
export function identiteCategorie(categoryId: string | null, categoryName: string): string {
  return categoryId ?? `nom:${categoryName.toLocaleLowerCase("fr")}`;
}

/** Catégories distinctes portées par des transactions normalisées (tous axes confondus). */
export function categoriesDesTransactions(transactions: PastTransactionNormalisee[]): CategorieSource[] {
  const parIdentite = new Map<string, CategorieSource>();
  for (const t of transactions) {
    for (const a of t.affectations) {
      const sourceCategoryId = identiteCategorie(a.categoryId, a.categoryName);
      parIdentite.set(sourceCategoryId, {
        sourceCategoryId,
        sourceCategoryName: a.categoryName,
        sourceGroupId: a.groupId,
      });
    }
  }
  return [...parIdentite.values()];
}

/** Part d'une transaction revenant à une catégorie de l'axe retenu. */
export interface PartCategorie {
  sourceCategoryId: string;
  sourceCategoryName: string;
  weight: number;
  montant: number; // montant de la transaction × pondération
}

/**
 * Ventilation d'une transaction entre les catégories de l'axe retenu, selon leur pondération :
 * -1 000 € à 70 % Marketing / 30 % Logistique -> -700 € et -300 €. C'est LA règle de répartition
 * des montants pour le reporting ; la "catégorie principale" (lib/pastTransactions.ts) n'est
 * qu'une commodité d'affichage du tableau des transactions, jamais une base de calcul.
 *
 * Les pondérations sont reprises telles que fournies par la source, sans être ramenées à 100 % :
 * si leur somme est inférieure à 1, le reliquat n'est attribué à aucune catégorie.
 */
export function ventilerTransaction(transaction: PastTransactionStockee, axeId: string | null): PartCategorie[] {
  if (axeId === null) return [];
  return transaction.affectations
    .filter((a) => a.groupId === axeId && normaliserNomCategorie(a.categoryName) !== null)
    .map((a) => ({
      sourceCategoryId: identiteCategorie(a.categoryId, a.categoryName),
      sourceCategoryName: a.categoryName,
      weight: a.weight,
      montant: transaction.amount * a.weight,
    }));
}

/** Classement d'une catégorie (ou de la catégorie affichée d'une transaction) dans le P&L. */
export type ClassementPnl =
  // Aucune catégorie source exploitable : rien à mapper, la transaction n'est affectée à aucun étage.
  | { statut: "non_categorisee" }
  // Catégorie connue mais pas (encore) rattachée à un étage : jamais affectée arbitrairement.
  | { statut: "non_mappee"; sourceCategoryId: string }
  | { statut: "mappee"; sourceCategoryId: string; etage: EtagePnl };

/**
 * Catégorie -> mapping courant -> étage P&L. Seul le mapping courant fait foi (jamais
 * l'historique des modifications). Pour répartir un MONTANT entre étages, partir de
 * ventilerTransaction (une part par catégorie), pas de la catégorie affichée d'une transaction.
 */
export function resoudreEtagePnl(
  transaction: Pick<PastTransaction, "analyticCategoryId" | "analyticCategoryName">,
  mappings: ReadonlyMap<string, MappingCategorie>
): ClassementPnl {
  if (!transaction.analyticCategoryName) return { statut: "non_categorisee" };
  const sourceCategoryId = identiteCategorie(transaction.analyticCategoryId, transaction.analyticCategoryName);
  const etage = mappings.get(sourceCategoryId)?.pnlStage ?? null;
  return etage ? { statut: "mappee", sourceCategoryId, etage } : { statut: "non_mappee", sourceCategoryId };
}

export function indexerMappings(mappings: MappingCategorie[]): Map<string, MappingCategorie> {
  return new Map(mappings.map((m) => [m.sourceCategoryId, m]));
}

/** Ligne du tableau de correspondance : un mapping et son activité sur la période affichée. */
export interface LigneMapping extends MappingCategorie {
  nombreTransactions: number;
  montantTotal: number;
}

/**
 * Lignes du tableau de correspondance : TOUTES les catégories connues de l'axe retenu, y compris
 * celles sans transaction sur la période (0 transaction, 0 €) — un mapping ne disparaît pas parce
 * que sa catégorie n'a pas servi ce mois-ci. Le montant est ventilé selon les pondérations
 * (ventilerTransaction) ; le nombre compte les transactions portant la catégorie, même en partie.
 * Tri : à mapper d'abord, puis par nom.
 */
export function lignesMapping(
  mappings: MappingCategorie[],
  axeId: string | null,
  transactionsPeriode: PastTransactionStockee[]
): LigneMapping[] {
  const activite = new Map<string, { nombre: number; montant: number }>();
  for (const t of transactionsPeriode) {
    for (const part of ventilerTransaction(t, axeId)) {
      const cumul = activite.get(part.sourceCategoryId) ?? { nombre: 0, montant: 0 };
      cumul.nombre += 1;
      cumul.montant += part.montant;
      activite.set(part.sourceCategoryId, cumul);
    }
  }
  return mappings
    .filter((m) => axeId !== null && m.sourceGroupId === axeId)
    .map((m) => ({
      ...m,
      nombreTransactions: activite.get(m.sourceCategoryId)?.nombre ?? 0,
      montantTotal: activite.get(m.sourceCategoryId)?.montant ?? 0,
    }))
    .sort(
      (a, b) =>
        Number(a.pnlStage !== null) - Number(b.pnlStage !== null) ||
        a.sourceCategoryName.localeCompare(b.sourceCategoryName, "fr", { sensitivity: "base" })
    );
}

export type FiltreMapping = "toutes" | "mappees" | "a_mapper" | EtagePnl;

export function filtrerLignesMapping<T extends MappingCategorie>(lignes: T[], filtre: FiltreMapping): T[] {
  if (filtre === "toutes") return lignes;
  if (filtre === "mappees") return lignes.filter((l) => l.pnlStage !== null);
  if (filtre === "a_mapper") return lignes.filter((l) => l.pnlStage === null);
  return lignes.filter((l) => l.pnlStage === filtre);
}

export function compterAMapper(lignes: MappingCategorie[]): number {
  return lignes.filter((l) => l.pnlStage === null).length;
}
