import { estDateValide, parseDateISO } from "./dates";
import { EtagePnl, MappingCategorie, ventilerTransaction } from "./pastCategoryMapping";
import { calculerCashFlow, PnlCategorie, SensStructure, Structure, structureParCategorie } from "./pastPnl";
import { PastTransactionStockee, Periode } from "./pastTransactions";

/**
 * Écrans détaillés du module "Passé" (CA, Marge brute, Marge contributive, EBITDA, Cash flow) :
 * un seul modèle de calcul, configuré par indicateur. Fonctions pures, sur les données déjà
 * synchronisées — aucun appel externe lors de l'exploration.
 *
 * Tout part des PARTS : une transaction ventilée donne une part par catégorie de l'axe retenu,
 * au montant pondéré. KPI, camembert, histogramme et liste de transactions lisent les mêmes parts
 * avec les mêmes filtres (catégorie, mois), d'où un cross-filtering cohérent par construction.
 */

/** Part d'une transaction rattachée à une catégorie mappée (donc à un étage P&L). */
export interface PartMappee {
  transactionId: string;
  transactionDate: string; // YYYY-MM-DD
  mois: string; // YYYY-MM
  label: string;
  montant: number; // montant attribué à la catégorie (montant source × pondération)
  montantSource: number; // montant bancaire total de la transaction, conservé pour information
  weight: number;
  sourceCategoryId: string;
  sourceCategoryName: string;
  etage: EtagePnl;
}

/**
 * Parts mappées des transactions de la période. Les transactions non catégorisées et les
 * catégories sans étage n'en produisent aucune : elles n'apparaissent dans aucun écran de détail.
 */
export function partsMappees(
  transactions: PastTransactionStockee[],
  axeId: string | null,
  mappings: ReadonlyMap<string, MappingCategorie>
): PartMappee[] {
  const parts: PartMappee[] = [];
  for (const transaction of transactions) {
    for (const part of ventilerTransaction(transaction, axeId)) {
      const mapping = mappings.get(part.sourceCategoryId);
      if (!mapping?.pnlStage) continue;
      parts.push({
        transactionId: transaction.id,
        transactionDate: transaction.transactionDate,
        mois: transaction.transactionDate.slice(0, 7),
        label: transaction.label,
        montant: part.montant,
        montantSource: transaction.amount,
        weight: part.weight,
        sourceCategoryId: part.sourceCategoryId,
        sourceCategoryName: mapping.sourceCategoryName,
        etage: mapping.pnlStage,
      });
    }
  }
  return parts;
}

export type MetriqueDetail = "ca" | "marge_brute" | "marge_contributive" | "ebitda" | "cash_flow";

interface ConfigMetrique {
  libelle: string;
  // Étages additionnés pour l'indicateur (soldes cumulés du P&L, montants signés).
  etagesKpi: readonly EtagePnl[];
  // Étage exploré par l'écran : ses transactions sont listées, ses catégories détaillées.
  etagesDetail: readonly EtagePnl[];
  libelleDetail: string;
  // Camembert par catégorie de l'étage exploré, et filtre catégorie associé. null : l'écran n'en a
  // pas (Cash flow — voir ci-dessous).
  camembert: { sens: SensStructure; maxCategories: number } | null;
  // Rapport au CA affiché sous l'indicateur (jamais pour le CA lui-même ni pour le Cash flow).
  ratioSurCa: boolean;
}

/**
 * Un indicateur = un solde cumulé + l'étage qu'il ajoute au précédent. Marge brute = CA + Coûts
 * directs : l'écran en détaille les Coûts directs.
 *
 * Cash flow est volontairement à part : c'est un indicateur dérivé (EBITDA + Extra P&L, formule
 * de lib/pastPnl.ts, inchangée) et l'Extra P&L mêle encaissements et décaissements — un camembert
 * n'y a pas de sens. L'écran montre à la place la décomposition mensuelle EBITDA / Extra P&L, sans
 * filtre catégorie ; ses transactions sont celles de l'Extra P&L, sa composante propre.
 */
export const METRIQUES_DETAIL: Record<MetriqueDetail, ConfigMetrique> = {
  ca: {
    libelle: "CA",
    etagesKpi: ["revenue"],
    etagesDetail: ["revenue"],
    libelleDetail: "CA",
    camembert: { sens: "revenus", maxCategories: 5 },
    ratioSurCa: false,
  },
  marge_brute: {
    libelle: "Marge brute",
    etagesKpi: ["revenue", "gross_margin"],
    etagesDetail: ["gross_margin"],
    libelleDetail: "Coûts directs",
    camembert: { sens: "couts", maxCategories: 5 },
    ratioSurCa: true,
  },
  marge_contributive: {
    libelle: "Marge contributive",
    etagesKpi: ["revenue", "gross_margin", "contribution_margin"],
    etagesDetail: ["contribution_margin"],
    libelleDetail: "Coûts commerciaux",
    camembert: { sens: "couts", maxCategories: 5 },
    ratioSurCa: true,
  },
  // Les coûts de structure sont naturellement plus éclatés : 7 catégories, puis "Autres".
  ebitda: {
    libelle: "EBITDA",
    etagesKpi: ["revenue", "gross_margin", "contribution_margin", "ebitda"],
    etagesDetail: ["ebitda"],
    libelleDetail: "Coûts de structure",
    camembert: { sens: "couts", maxCategories: 7 },
    ratioSurCa: true,
  },
  cash_flow: {
    libelle: "Cash flow",
    etagesKpi: ["revenue", "gross_margin", "contribution_margin", "ebitda", "extra_pnl"],
    etagesDetail: ["extra_pnl"],
    libelleDetail: "Extra P&L",
    camembert: null,
    ratioSurCa: false,
  },
};

const ETAGES_EBITDA: readonly EtagePnl[] = ["revenue", "gross_margin", "contribution_margin", "ebitda"];

export function estMetriqueDetail(valeur: string): valeur is MetriqueDetail {
  return valeur in METRIQUES_DETAIL;
}

/** Tous les mois (YYYY-MM) couverts par la période, y compris ceux sans transaction. */
export function moisDeLaPeriode(periode: Periode): string[] {
  if (!estDateValide(periode.debut) || !estDateValide(periode.fin) || periode.debut > periode.fin) return [];
  const mois: string[] = [];
  const curseur = parseDateISO(periode.debut);
  curseur.setDate(1);
  const fin = periode.fin.slice(0, 7);
  for (;;) {
    const cle = `${curseur.getFullYear()}-${String(curseur.getMonth() + 1).padStart(2, "0")}`;
    if (cle > fin) break;
    mois.push(cle);
    curseur.setMonth(curseur.getMonth() + 1);
  }
  return mois;
}

/** Filtres locaux d'un écran de détail ; ils s'ajoutent à la période globale du module. */
export interface FiltresDetail {
  categorie: string | null; // sourceCategoryId
  mois: string | null; // YYYY-MM
}

export interface PointEvolution {
  mois: string;
  montant: number; // montant réel signé du mois
  valeur: number; // hauteur du barreau : le montant, ou sa valeur absolue (voir evolutionAbsolue)
}

export interface VueDetail {
  kpi: {
    libelle: string;
    // Renseigné quand une catégorie est sélectionnée : l'indicateur porte alors sur elle seule.
    categorie: string | null;
    montant: number; // toujours le montant financier signé réel
    // undefined = pas de ratio pour cet indicateur ; null = ratio indéfini (CA nul).
    ratio: number | null | undefined;
  };
  // null : écran sans camembert (Cash flow).
  structure: Structure | null;
  evolution: PointEvolution[];
  // true quand une catégorie est sélectionnée : les barreaux montrent la valeur absolue de ses
  // montants mensuels, pour comparer l'évolution d'un poste de coût sans tout faire descendre sous
  // zéro. Pure convention de visualisation : `montant` garde le signe réel.
  evolutionAbsolue: boolean;
  // Cash flow uniquement : ses deux composantes, mois par mois (montants signés).
  decomposition: { mois: string; ebitda: number; extraPnl: number; cashFlow: number }[] | null;
  transactions: PartMappee[];
}

function somme(parts: PartMappee[]): number {
  return parts.reduce((total, part) => total + part.montant, 0);
}

/**
 * Vue d'un écran de détail pour un état de filtres donné — seule source de vérité de tous les
 * blocs de l'écran :
 *  - KPI : filtré par mois ET catégorie. Sans catégorie, c'est le solde cumulé de l'indicateur ;
 *    avec une catégorie, c'est le montant de cette catégorie (rapporté au CA du même périmètre),
 *    égal à la somme des transactions listées ;
 *  - camembert : catégories de l'étage exploré, filtré par mois seulement — il reste entier pour
 *    montrer la catégorie sélectionnée parmi les autres ;
 *  - histogramme : tous les mois de la période, filtré par catégorie seulement — il reste entier
 *    pour montrer le mois sélectionné parmi les autres ;
 *  - transactions : parts de l'étage exploré, filtrées par mois ET catégorie, date décroissante.
 * Un écran sans camembert n'a pas de filtre catégorie : une catégorie éventuellement transmise est
 * ignorée.
 */
export function calculerDetail(
  parts: PartMappee[],
  metrique: MetriqueDetail,
  filtres: FiltresDetail,
  periode: Periode
): VueDetail {
  const config = METRIQUES_DETAIL[metrique];
  const categorie = config.camembert ? filtres.categorie : null;
  const duMois = (p: PartMappee) => filtres.mois === null || p.mois === filtres.mois;
  const deLaCategorie = (p: PartMappee) => categorie === null || p.sourceCategoryId === categorie;
  const duKpi = (p: PartMappee) => (categorie === null ? config.etagesKpi.includes(p.etage) : p.sourceCategoryId === categorie);
  const duDetail = (p: PartMappee) => config.etagesDetail.includes(p.etage);

  const montantKpi = somme(parts.filter((p) => duKpi(p) && duMois(p)));
  const ca = somme(parts.filter((p) => p.etage === "revenue" && duMois(p)));
  const avecRatio = categorie !== null || config.ratioSurCa;
  const categorieSelectionnee =
    categorie === null ? null : (parts.find((p) => p.sourceCategoryId === categorie)?.sourceCategoryName ?? null);

  let structure: Structure | null = null;
  if (config.camembert) {
    const parCategorie = new Map<string, PnlCategorie>();
    for (const part of parts) {
      if (!duDetail(part) || !duMois(part)) continue;
      const cumul = parCategorie.get(part.sourceCategoryId) ?? {
        sourceCategoryId: part.sourceCategoryId,
        sourceCategoryName: part.sourceCategoryName,
        etage: part.etage,
        montant: 0,
      };
      cumul.montant += part.montant;
      parCategorie.set(part.sourceCategoryId, cumul);
    }
    structure = structureParCategorie([...parCategorie.values()], config.etagesDetail, config.camembert.sens, {
      maxCategories: config.camembert.maxCategories,
      epingle: categorie,
    });
  }

  const tousLesMois = moisDeLaPeriode(periode);
  const parMois = new Map<string, number>();
  for (const part of parts) {
    if (!duKpi(part)) continue;
    parMois.set(part.mois, (parMois.get(part.mois) ?? 0) + part.montant);
  }
  const evolutionAbsolue = categorie !== null;

  let decomposition: VueDetail["decomposition"] = null;
  if (metrique === "cash_flow") {
    const ebitdaParMois = new Map<string, number>();
    const extraParMois = new Map<string, number>();
    for (const part of parts) {
      const cible = part.etage === "extra_pnl" ? extraParMois : ETAGES_EBITDA.includes(part.etage) ? ebitdaParMois : null;
      cible?.set(part.mois, (cible.get(part.mois) ?? 0) + part.montant);
    }
    decomposition = tousLesMois.map((mois) => {
      const ebitda = ebitdaParMois.get(mois) ?? 0;
      const extraPnl = extraParMois.get(mois) ?? 0;
      return { mois, ebitda, extraPnl, cashFlow: calculerCashFlow(ebitda, extraPnl) };
    });
  }

  return {
    kpi: {
      libelle: config.libelle,
      categorie: categorieSelectionnee,
      montant: montantKpi,
      ratio: avecRatio ? (ca === 0 ? null : montantKpi / ca) : undefined,
    },
    structure,
    evolution: tousLesMois.map((mois) => {
      const montant = parMois.get(mois) ?? 0;
      return { mois, montant, valeur: evolutionAbsolue ? Math.abs(montant) : montant };
    }),
    evolutionAbsolue,
    decomposition,
    transactions: parts
      .filter((p) => duDetail(p) && duMois(p) && deLaCategorie(p))
      .sort((a, b) => (a.transactionDate < b.transactionDate ? 1 : a.transactionDate > b.transactionDate ? -1 : 0)),
  };
}

const NOMS_MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const NOMS_MOIS_COURTS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/** "2026-09" -> "Septembre 2026". */
export function libelleMois(mois: string): string {
  const nom = NOMS_MOIS[Number(mois.slice(5, 7)) - 1] ?? mois;
  return `${nom.charAt(0).toUpperCase()}${nom.slice(1)} ${mois.slice(0, 4)}`;
}

/** "2026-09" -> "sept." ; avec l'année abrégée ("sept. 26") quand la période couvre plusieurs années. */
export function libelleMoisCourt(mois: string, avecAnnee: boolean): string {
  const nom = NOMS_MOIS_COURTS[Number(mois.slice(5, 7)) - 1] ?? mois;
  return avecAnnee ? `${nom} ${mois.slice(2, 4)}` : nom;
}
