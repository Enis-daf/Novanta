import { AjustementGestion, ajustementsDeLaPeriode, regrouperAjustements, sommeAjustements } from "./pastAdjustments";
import { EtagePnl, MappingCategorie } from "./pastCategoryMapping";
import { PartMappee, partsMappees } from "./pastDetail";
import { calculerCashFlow } from "./pastPnl";
import { PastTransactionStockee, Periode } from "./pastTransactions";
import { cleLibelleComparable } from "./transactionLabel";

/**
 * Comparaison de deux périodes du module "Passé" : pourquoi le Cash flow s'améliore ou se dégrade.
 * Fonctions pures, sur les mêmes parts mappées et les mêmes ajustements que le reste du module —
 * rien n'est recalculé autrement ici.
 *
 * Convention : une CONTRIBUTION est un impact sur le Cash flow, égale à (montant B − montant A).
 * Les montants étant signés (charge négative, revenu positif), cette différence a directement le
 * bon sens économique : une charge qui augmente donne une contribution négative, une charge qui
 * diminue ou disparaît une contribution positive, un revenu qui augmente une contribution positive.
 */

/** Les cinq contributions de la waterfall, dans l'ordre du P&L. */
export const ETAGES_ECARTS: readonly { etage: EtagePnl; libelle: string }[] = [
  { etage: "revenue", libelle: "CA" },
  { etage: "gross_margin", libelle: "Coûts directs" },
  { etage: "contribution_margin", libelle: "Coûts commerciaux & opérationnels" },
  { etage: "ebitda", libelle: "Coûts de structure" },
  { etage: "extra_pnl", libelle: "Extra P&L" },
];

const ETAGES_EBITDA: readonly EtagePnl[] = ["revenue", "gross_margin", "contribution_margin", "ebitda"];

/** Tout ce qui entre dans le Cash flow d'une période : parts mappées et ajustements de gestion. */
export interface DonneesPeriode {
  periode: Periode;
  parts: PartMappee[];
  ajustements: AjustementGestion[];
}

export function donneesPeriode(
  transactions: PastTransactionStockee[],
  axeId: string | null,
  mappings: ReadonlyMap<string, MappingCategorie>,
  tousLesAjustements: AjustementGestion[],
  periode: Periode
): DonneesPeriode {
  return {
    periode,
    parts: partsMappees(transactions, axeId, mappings),
    ajustements: ajustementsDeLaPeriode(tousLesAjustements, periode),
  };
}

function totalEtage(donnees: DonneesPeriode, etages: readonly EtagePnl[]): number {
  const parts = donnees.parts.reduce((total, p) => (etages.includes(p.etage) ? total + p.montant : total), 0);
  return parts + sommeAjustements(donnees.ajustements, etages);
}

export interface ContributionEtage {
  etage: EtagePnl;
  libelle: string;
  montantA: number;
  montantB: number;
  contribution: number;
}

export interface Comparaison {
  cashFlowA: number;
  cashFlowB: number;
  ecart: number;
  // null quand le Cash flow de A est nul : un pourcentage n'aurait pas de sens.
  ecartRelatif: number | null;
  // Leur somme est exactement l'écart : la waterfall réconcilie toujours A et B.
  etages: ContributionEtage[];
  // L'EBITDA s'explique par les quatre premiers étages ; l'Extra P&L n'explique que ce qui vient
  // après. Les deux ne se mélangent pas : variationEbitda + variationExtraPnl = ecart.
  variationEbitda: number;
  variationExtraPnl: number;
}

export function comparerPeriodes(a: DonneesPeriode, b: DonneesPeriode): Comparaison {
  const etages = ETAGES_ECARTS.map(({ etage, libelle }) => {
    const montantA = totalEtage(a, [etage]);
    const montantB = totalEtage(b, [etage]);
    return { etage, libelle, montantA, montantB, contribution: montantB - montantA };
  });
  const cashFlow = (donnees: DonneesPeriode) => calculerCashFlow(totalEtage(donnees, ETAGES_EBITDA), totalEtage(donnees, ["extra_pnl"]));
  const cashFlowA = cashFlow(a);
  const cashFlowB = cashFlow(b);
  const ecart = cashFlowB - cashFlowA;
  const variationExtraPnl = etages.find((e) => e.etage === "extra_pnl")!.contribution;
  return {
    cashFlowA,
    cashFlowB,
    ecart,
    ecartRelatif: cashFlowA === 0 ? null : ecart / Math.abs(cashFlowA),
    etages,
    variationEbitda: ecart - variationExtraPnl,
    variationExtraPnl,
  };
}

function parContributionDecroissante<T extends { contribution: number; nom: string }>(lignes: T[]): T[] {
  return lignes.sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution) || x.nom.localeCompare(y.nom, "fr"));
}

/** Catégorie (ou ajustement de gestion) d'un étage, avec sa contribution à l'écart. */
export interface LigneCategorieEcart {
  cle: string;
  nom: string;
  // true : ajustement de gestion, pas une catégorie de transactions bancaires.
  horsBanque: boolean;
  montantA: number;
  montantB: number;
  contribution: number;
}

/**
 * Ce qui explique la contribution d'un étage : ses catégories, et ses ajustements de gestion sur
 * leurs propres lignes. Classées par |contribution| décroissante — ce qui pèse le plus d'abord,
 * jamais par montant brut. La somme des contributions est celle de l'étage.
 */
export function categoriesDeLEtage(a: DonneesPeriode, b: DonneesPeriode, etage: EtagePnl): LigneCategorieEcart[] {
  const lignes = new Map<string, LigneCategorieEcart>();
  const ligne = (cle: string, nom: string, horsBanque: boolean) => {
    if (!lignes.has(cle)) lignes.set(cle, { cle, nom, horsBanque, montantA: 0, montantB: 0, contribution: 0 });
    return lignes.get(cle)!;
  };
  for (const [donnees, cote] of [[a, "montantA"], [b, "montantB"]] as const) {
    for (const part of donnees.parts) {
      if (part.etage === etage) ligne(part.sourceCategoryId, part.sourceCategoryName, false)[cote] += part.montant;
    }
    for (const ajustement of regrouperAjustements(donnees.ajustements.filter((x) => x.etage === etage))) {
      ligne(`ajustement:${ajustement.cle}`, ajustement.label, true)[cote] += ajustement.montant;
    }
  }
  return parContributionDecroissante([...lignes.values()].map((l) => ({ ...l, contribution: l.montantB - l.montantA })));
}

export type StatutEcart =
  // Présent en B seulement.
  | "nouveau"
  // Présent en A seulement.
  | "absent"
  // Présent des deux côtés, montant différent.
  | "change"
  // Présent des deux côtés, même montant à l'euro près : masqué par défaut.
  | "stable";

// Seuil volontairement absolu et minuscule : un seuil relatif masquerait des écarts matériels sur
// les gros montants (1 % d'un million = 10 000 €). Mieux vaut montrer une ligne de trop que cacher
// un contributeur significatif.
const TOLERANCE_STABLE = 1;

/** Groupe de transactions au libellé comparable, dans une catégorie, sur les deux périodes. */
export interface GroupeLibelle {
  cle: string;
  // Libellé d'origine le plus représentatif du groupe (celui de sa plus grosse ligne) : toujours
  // un vrai libellé source, jamais la forme normalisée.
  libelle: string;
  nombreLibelles: number;
  sourceCategoryId: string;
  categorie: string;
  montantA: number;
  montantB: number;
  contribution: number;
  nombreA: number;
  nombreB: number;
  statut: StatutEcart;
}

export type PartComparee = PartMappee & { cote: "A" | "B" };

function cleGroupe(part: PartMappee): string {
  const cle = cleLibelleComparable(part.label);
  // Libellé vide après normalisation : la ligne n'est rapprochée d'aucune autre.
  return `${part.sourceCategoryId}|${cle === "" ? `seule:${part.transactionId}` : cle}`;
}

function partsComparees(a: DonneesPeriode, b: DonneesPeriode, etage: EtagePnl, categorie: string | null): PartComparee[] {
  const garder = (p: PartMappee) => p.etage === etage && (categorie === null || p.sourceCategoryId === categorie);
  return [
    ...a.parts.filter(garder).map((p) => ({ ...p, cote: "A" as const })),
    ...b.parts.filter(garder).map((p) => ({ ...p, cote: "B" as const })),
  ];
}

/**
 * Ce qui change entre A et B dans un étage (ou une de ses catégories), par groupe de libellés
 * comparables. Les libellés ne sont rapprochés qu'à l'intérieur d'une même catégorie. Classés par
 * |contribution| décroissante.
 */
export function groupesDeLibelles(a: DonneesPeriode, b: DonneesPeriode, etage: EtagePnl, categorie: string | null = null): GroupeLibelle[] {
  const groupes = new Map<string, { parts: PartComparee[] }>();
  for (const part of partsComparees(a, b, etage, categorie)) {
    const cle = cleGroupe(part);
    if (!groupes.has(cle)) groupes.set(cle, { parts: [] });
    groupes.get(cle)!.parts.push(part);
  }
  const resultat = [...groupes.entries()].map(([cle, { parts }]) => {
    const cote = (c: "A" | "B") => parts.filter((p) => p.cote === c);
    const montantA = cote("A").reduce((s, p) => s + p.montant, 0);
    const montantB = cote("B").reduce((s, p) => s + p.montant, 0);
    const contribution = montantB - montantA;
    const representative = [...parts].sort((x, y) => Math.abs(y.montant) - Math.abs(x.montant) || x.label.localeCompare(y.label))[0];
    let statut: StatutEcart;
    if (cote("A").length === 0) statut = "nouveau";
    else if (cote("B").length === 0) statut = "absent";
    else {
      statut = Math.abs(contribution) <= TOLERANCE_STABLE ? "stable" : "change";
    }
    return {
      cle,
      nom: representative.label,
      libelle: representative.label,
      nombreLibelles: new Set(parts.map((p) => p.label)).size,
      sourceCategoryId: representative.sourceCategoryId,
      categorie: representative.sourceCategoryName,
      montantA,
      montantB,
      contribution,
      nombreA: cote("A").length,
      nombreB: cote("B").length,
      statut,
    };
  });
  return parContributionDecroissante(resultat).map(({ nom: _nom, ...groupe }) => groupe);
}

/** Transactions d'origine d'un groupe, des deux périodes, chacune marquée A ou B. */
export function transactionsDuGroupe(a: DonneesPeriode, b: DonneesPeriode, etage: EtagePnl, cle: string): PartComparee[] {
  return partsComparees(a, b, etage, null).filter((part) => cleGroupe(part) === cle);
}
