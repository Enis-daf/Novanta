import { EtagePnl, ETAGES_PNL, estEtagePnl, identiteCategorie } from "./pastCategoryMapping";

/**
 * Étage P&L des dépenses du module "Futur". Fonctions pures.
 *
 * Même nomenclature que Passé (ETAGES_PNL, mêmes clés, mêmes libellés), sans « Encaissements » :
 * Futur ne classe que des dépenses. Une dépense porte UN étage :
 *   1. le choix manuel fait dans Futur, s'il existe ;
 *   2. sinon, l'étage issu de la correspondance P&L partagée avec Passé (factures Pennylane) ;
 *   3. sinon, « À classer ».
 *
 * L'étage automatique n'est jamais stocké : il se résout à la lecture, à partir des catégories
 * Pennylane de la facture et de la correspondance COURANTE (comme lib/pastCategoryMapping.ts::
 * resoudreEtagePnl). Une modification de la correspondance s'applique donc aux dépenses sans choix
 * manuel, jamais aux autres.
 *
 * Ce classement est une information : il ne change ni l'inclusion d'une dépense dans la
 * trésorerie prévisionnelle, ni son montant, ni ses dates. Il ne sert jamais à rapprocher ou
 * fusionner deux dépenses.
 */

export type EtageDepense = Exclude<EtagePnl, "revenue">;

export const ETAGES_DEPENSE: readonly { cle: EtageDepense; libelle: string }[] = ETAGES_PNL.filter(
  (e): e is (typeof ETAGES_PNL)[number] & { cle: EtageDepense } => e.cle !== "revenue"
);

export function estEtageDepense(valeur: unknown): valeur is EtageDepense {
  return estEtagePnl(valeur) && valeur !== "revenue";
}

export const LIBELLE_A_CLASSER = "À classer";
export const LIBELLE_PROVENANCE_CORRESPONDANCE = "Issu de la correspondance P&L";
export const LIBELLE_PROVENANCE_MANUELLE = "Défini dans Futur";
export const LIBELLE_REPRENDRE_AUTOMATIQUE = "Reprendre le classement automatique";
export const LIBELLE_AFFECTER_ETAGE = "Affecter un étage P&L";

/** Catégorie analytique d'une facture fournisseur, telle que lue chez Pennylane. */
export interface CategorieFacture {
  id: string | null;
  label: string;
  groupId: string | null;
  weight: number;
}

/** Correspondance lisible depuis Futur (fonction future_pnl_correspondance) : id -> étage. */
export interface CorrespondanceFutur {
  // Axe analytique de référence de Passé (past_settings), null s'il n'est pas configuré.
  axe: string | null;
  etages: ReadonlyMap<string, { axe: string | null; etage: EtagePnl }>;
}

export const CORRESPONDANCE_VIDE: CorrespondanceFutur = { axe: null, etages: new Map() };

export type ProvenanceClassement = "manuel" | "correspondance" | "a_classer";

export interface ClassementDepense {
  etage: EtageDepense | null;
  provenance: ProvenanceClassement;
}

/** Charge fixe, autre dépense ou facture : seul ce qui sert au classement. */
export interface DepenseClassable {
  etagePnlManuel?: EtageDepense | null;
  categoriesPennylane?: CategorieFacture[] | null;
}

/** Relit la réponse de future_pnl_correspondance ; toute valeur inattendue est ignorée. */
export function lireCorrespondance(brut: unknown): CorrespondanceFutur {
  if (!brut || typeof brut !== "object") return CORRESPONDANCE_VIDE;
  const { axe, correspondances } = brut as { axe?: unknown; correspondances?: unknown };
  const etages = new Map<string, { axe: string | null; etage: EtagePnl }>();
  if (Array.isArray(correspondances)) {
    for (const c of correspondances as { id?: unknown; axe?: unknown; etage?: unknown }[]) {
      if (typeof c?.id === "string" && estEtagePnl(c.etage)) {
        etages.set(c.id, { axe: typeof c.axe === "string" ? c.axe : null, etage: c.etage });
      }
    }
  }
  return { axe: typeof axe === "string" && axe !== "" ? axe : null, etages };
}

/**
 * Étage automatique d'une facture d'après ses catégories Pennylane et la correspondance partagée.
 *
 * Convention d'axe de Passé : quand un axe de référence est configuré, seules les catégories de
 * cet axe comptent. Sans axe configuré, toutes les catégories de la facture comptent.
 *
 * Plusieurs catégories : l'étage n'est repris que si TOUTES aboutissent au même étage de dépense.
 * Une catégorie non rattachée, rattachée à « Encaissements », ou deux étages différents : null
 * (« À classer ») — jamais un choix arbitraire, jamais la catégorie au plus fort poids.
 */
export function etageAutomatique(
  categories: CategorieFacture[] | null | undefined,
  correspondance: CorrespondanceFutur
): EtageDepense | null {
  if (!categories || categories.length === 0) return null;
  const retenues = correspondance.axe === null ? categories : categories.filter((c) => c.groupId === correspondance.axe);
  if (retenues.length === 0) return null;
  const etages = new Set<EtagePnl | null>(
    retenues.map((c) => correspondance.etages.get(identiteCategorie(c.id, c.label))?.etage ?? null)
  );
  if (etages.size !== 1) return null;
  const [etage] = etages;
  return estEtageDepense(etage) ? etage : null;
}

/** Choix manuel, sinon correspondance, sinon « À classer ». */
export function classerDepense(depense: DepenseClassable, correspondance: CorrespondanceFutur): ClassementDepense {
  if (depense.etagePnlManuel) return { etage: depense.etagePnlManuel, provenance: "manuel" };
  const auto = etageAutomatique(depense.categoriesPennylane, correspondance);
  return auto ? { etage: auto, provenance: "correspondance" } : { etage: null, provenance: "a_classer" };
}

// --- Présentation dans Futur ---
//
// Futur présente une nomenclature simplifiée, SANS toucher aux données : la TVA est montrée sous
// « Extra P&L », et « Virements internes & Financement » s'appelle « Financement ». L'étage stocké
// (choix manuel, correspondance de Passé) reste celui d'origine : une catégorie mappée TVA le reste,
// et le reporting HT de Passé continue de l'exclure. Seul ce bloc décide de cette présentation :
// sous-titres, filtres et sélecteurs le partagent.

/** Groupe affiché dans Futur : un étage de dépense, la TVA étant rattachée à « Extra P&L ». */
export type GroupeEtage = Exclude<EtageDepense, "vat">;

/** Groupes de Futur, dans l'ordre des sous-titres des tableaux (« À classer » vient après). */
export const GROUPES_ETAGE: readonly { cle: GroupeEtage; libelle: string }[] = [
  { cle: "gross_margin", libelle: "Coûts directs" },
  { cle: "contribution_margin", libelle: "Autres coûts variables" },
  { cle: "ebitda", libelle: "Coûts de structure" },
  { cle: "extra_pnl", libelle: "Extra P&L" },
  { cle: "financing", libelle: "Financement" },
];

export function groupeDeEtage(etage: EtageDepense): GroupeEtage {
  return etage === "vat" ? "extra_pnl" : etage;
}

export function estGroupeEtage(valeur: unknown): valeur is GroupeEtage {
  return GROUPES_ETAGE.some((g) => g.cle === valeur);
}

export function libelleGroupeEtage(groupe: GroupeEtage | null): string {
  return groupe === null ? LIBELLE_A_CLASSER : GROUPES_ETAGE.find((g) => g.cle === groupe)!.libelle;
}

/** Groupe affiché d'une dépense classée, null = « À classer ». */
export function groupeDeClassement(classement: ClassementDepense): GroupeEtage | null {
  return classement.etage === null ? null : groupeDeEtage(classement.etage);
}

/**
 * Infobulle discrète de la cellule « Étage P&L ». Une ligne classée TVA (affichée sous Extra P&L)
 * garde la trace de sa classification d'origine.
 */
export function infobulleClassement(classement: ClassementDepense): string {
  const origineTva = classement.etage === "vat" ? " (classée TVA)" : "";
  if (classement.provenance === "manuel") return LIBELLE_PROVENANCE_MANUELLE + origineTva;
  if (classement.provenance === "correspondance") return LIBELLE_PROVENANCE_CORRESPONDANCE + origineTva;
  return LIBELLE_A_CLASSER;
}

/** Filtre d'une liste de dépenses par groupe. N'agit que sur l'affichage, jamais sur la projection. */
export type FiltreEtage = "tous" | "a_classer" | GroupeEtage;

export function estFiltreEtage(valeur: unknown): valeur is FiltreEtage {
  return valeur === "tous" || valeur === "a_classer" || estGroupeEtage(valeur);
}

export function correspondAuFiltreEtage(classement: ClassementDepense, filtre: FiltreEtage): boolean {
  if (filtre === "tous") return true;
  return groupeDeClassement(classement) === (filtre === "a_classer" ? null : filtre);
}

/** Sous-titre d'un tableau de dépenses et ses lignes, dans l'ordre reçu (le tri existant). */
export interface GroupeLignes<T> {
  groupe: GroupeEtage | null;
  libelle: string;
  lignes: T[];
}

/**
 * Lignes d'un tableau regroupées sous leurs sous-titres : ordre fixe des groupes, « À classer » en
 * dernier, aucun groupe vide. Chaque ligne apparaît une fois ; l'ordre interne est celui reçu.
 */
export function grouperParEtage<T>(lignes: readonly T[], classer: (ligne: T) => ClassementDepense): GroupeLignes<T>[] {
  const parGroupe = new Map<GroupeEtage | null, T[]>();
  for (const ligne of lignes) {
    const groupe = groupeDeClassement(classer(ligne));
    const liste = parGroupe.get(groupe) ?? [];
    liste.push(ligne);
    parGroupe.set(groupe, liste);
  }
  return [...GROUPES_ETAGE.map((g) => g.cle), null]
    .filter((groupe) => parGroupe.has(groupe))
    .map((groupe) => ({ groupe, libelle: libelleGroupeEtage(groupe), lignes: parGroupe.get(groupe)! }));
}

/**
 * Lignes touchées par « Affecter un étage P&L » : les lignes cochées ET encore affichées. Une
 * ligne cochée puis masquée par un filtre ou une recherche n'est jamais modifiée à l'aveugle.
 */
export function idsAAffecter(selection: ReadonlySet<string>, idsAffiches: readonly string[]): string[] {
  return idsAffiches.filter((id) => selection.has(id));
}

/**
 * Réunion de deux réglages manuels (fusion de doublons, lib/doublonsFactures.ts) : un seul choix,
 * ou deux choix identiques, est repris ; deux choix différents forment un conflit à trancher par
 * l'utilisateur, comme deux dates prévues explicites — jamais l'un écrasé en silence.
 */
export function reunirEtagesManuels(
  a: EtageDepense | null | undefined,
  b: EtageDepense | null | undefined
): { etage: EtageDepense | null; conflit: null } | { etage: null; conflit: { a: EtageDepense; b: EtageDepense } } {
  if (a && b && a !== b) return { etage: null, conflit: { a, b } };
  return { etage: a ?? b ?? null, conflit: null };
}

/**
 * Factures dont les catégories Pennylane sont à (re)lire pendant une synchronisation : factures
 * Pennylane encore à payer, jamais lues, lues sans catégorie (le cabinet a pu les catégoriser
 * depuis) ou lues il y a plus de DELAI_RELECTURE_CATEGORIES_JOURS jours.
 */
export const DELAI_RELECTURE_CATEGORIES_JOURS = 7;

export function categoriesARelire(
  facture: { pennylaneId?: string | null; payee: boolean; categoriesPennylane?: CategorieFacture[] | null; categoriesLuesLe?: string | null },
  maintenant: Date
): boolean {
  if (!facture.pennylaneId || facture.payee) return false;
  if (!facture.categoriesPennylane || facture.categoriesPennylane.length === 0 || !facture.categoriesLuesLe) return true;
  const age = maintenant.getTime() - new Date(facture.categoriesLuesLe).getTime();
  return !(age >= 0 && age < DELAI_RELECTURE_CATEGORIES_JOURS * 24 * 3600 * 1000);
}
