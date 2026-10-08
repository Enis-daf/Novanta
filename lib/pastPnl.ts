import { AjustementGestion, LigneAjustement, regrouperAjustements, sommeAjustements } from "./pastAdjustments";
import { EtagePnl, MappingCategorie, ventilerTransaction } from "./pastCategoryMapping";
import { PastTransactionStockee } from "./pastTransactions";

/**
 * P&L synthétique du module "Passé". Fonctions pures, calculées à la lecture à partir des
 * transactions synchronisées et du mapping COURANT : rien n'est stocké ni figé, donc modifier un
 * mapping recalcule immédiatement tout l'historique.
 *
 * Convention de signe : celle des transactions (encaissement positif, décaissement négatif),
 * jamais inversée. Le P&L se construit par additions successives. Les montants des transactions
 * ventilées sont répartis selon leurs pondérations (ventilerTransaction).
 *
 * Les ajustements de gestion (lib/pastAdjustments.ts) s'ajoutent à l'étage auquel ils sont
 * rattachés AVANT le calcul des soldes : une variation de stock en gross_margin modifie la marge
 * brute, donc la marge contributive, l'EBITDA et le Cash flow.
 */

/** Montant d'une catégorie sur la période, dans son étage P&L courant. */
export interface PnlCategorie {
  sourceCategoryId: string;
  sourceCategoryName: string;
  etage: EtagePnl;
  montant: number;
}

export interface Pnl {
  // Les cinq lignes d'étage ci-dessous (ca, coutsDirects, coutsCommerciaux, coutsStructure,
  // extraPnl) sont les sommes des TRANSACTIONS de l'étage. Les ajustements de gestion sont portés
  // à part (ajustements) pour rester des lignes distinctes ; les soldes et le Cash flow, eux, les
  // incluent.
  ca: number;
  coutsDirects: number;
  margeBrute: number;
  coutsCommerciaux: number;
  margeContributive: number;
  coutsStructure: number;
  ebitda: number;
  extraPnl: number;
  cashFlow: number;
  // Rapportés au CA ; null quand le CA est nul (ratio sans signification).
  ratios: { margeBrute: number | null; margeContributive: number | null; ebitda: number | null };
  categories: PnlCategorie[];
  // Ajustements de gestion de la période, par étage, une ligne par nature d'ajustement.
  ajustements: Record<EtagePnl, LigneAjustement[]>;
  // Catégories présentes sur la période mais sans étage : exclues de tous les calculs ci-dessus,
  // jamais affectées arbitrairement.
  nonMappees: { nombreCategories: number; montant: number };
}

/**
 * Cash flow : indicateur métier à part entière, dérivé à la lecture — ce n'est ni un étage de
 * mapping ni un alias de l'Extra P&L. Formule V1 : EBITDA + Extra P&L, en montants signés
 * (positif = génération nette de trésorerie, négatif = consommation nette). Isolée ici pour
 * pouvoir évoluer sans toucher au mapping analytique.
 */
export function calculerCashFlow(ebitda: number, extraPnl: number): number {
  return ebitda + extraPnl;
}

function ratio(valeur: number, ca: number): number | null {
  return ca === 0 ? null : valeur / ca;
}

export function calculerPnl(
  transactions: PastTransactionStockee[],
  axeId: string | null,
  mappings: ReadonlyMap<string, MappingCategorie>,
  ajustements: AjustementGestion[] = []
): Pnl {
  const totaux: Record<EtagePnl, number> = {
    revenue: 0,
    gross_margin: 0,
    contribution_margin: 0,
    ebitda: 0,
    extra_pnl: 0,
  };
  const parCategorie = new Map<string, PnlCategorie>();
  const nonMappees = new Map<string, number>();

  for (const transaction of transactions) {
    for (const part of ventilerTransaction(transaction, axeId)) {
      const etage = mappings.get(part.sourceCategoryId)?.pnlStage ?? null;
      if (etage === null) {
        nonMappees.set(part.sourceCategoryId, (nonMappees.get(part.sourceCategoryId) ?? 0) + part.montant);
        continue;
      }
      totaux[etage] += part.montant;
      const cumul = parCategorie.get(part.sourceCategoryId) ?? {
        sourceCategoryId: part.sourceCategoryId,
        sourceCategoryName: mappings.get(part.sourceCategoryId)?.sourceCategoryName ?? part.sourceCategoryName,
        etage,
        montant: 0,
      };
      cumul.montant += part.montant;
      parCategorie.set(part.sourceCategoryId, cumul);
    }
  }

  const ajustes = (etage: EtagePnl) => totaux[etage] + sommeAjustements(ajustements, [etage]);
  const lignesAjustements = regrouperAjustements(ajustements);

  // Base des ratios : le CA y compris ses éventuels ajustements.
  const caAjuste = ajustes("revenue");
  const margeBrute = caAjuste + ajustes("gross_margin");
  const margeContributive = margeBrute + ajustes("contribution_margin");
  const ebitda = margeContributive + ajustes("ebitda");

  return {
    ca: totaux.revenue,
    coutsDirects: totaux.gross_margin,
    margeBrute,
    coutsCommerciaux: totaux.contribution_margin,
    margeContributive,
    coutsStructure: totaux.ebitda,
    ebitda,
    extraPnl: totaux.extra_pnl,
    cashFlow: calculerCashFlow(ebitda, ajustes("extra_pnl")),
    ratios: {
      margeBrute: ratio(margeBrute, caAjuste),
      margeContributive: ratio(margeContributive, caAjuste),
      ebitda: ratio(ebitda, caAjuste),
    },
    categories: [...parCategorie.values()],
    ajustements: {
      revenue: lignesAjustements.filter((l) => l.etage === "revenue"),
      gross_margin: lignesAjustements.filter((l) => l.etage === "gross_margin"),
      contribution_margin: lignesAjustements.filter((l) => l.etage === "contribution_margin"),
      ebitda: lignesAjustements.filter((l) => l.etage === "ebitda"),
      extra_pnl: lignesAjustements.filter((l) => l.etage === "extra_pnl"),
    },
    nonMappees: {
      nombreCategories: nonMappees.size,
      montant: [...nonMappees.values()].reduce((somme, montant) => somme + montant, 0),
    },
  };
}

export const ETAGES_REVENUS: readonly EtagePnl[] = ["revenue"];
// L'Extra P&L n'est pas un coût d'exploitation : il reste hors de la structure des coûts.
export const ETAGES_COUTS: readonly EtagePnl[] = ["gross_margin", "contribution_margin", "ebitda"];

export interface PartStructure {
  cle: string;
  nom: string;
  montant: number; // montant réel signé (somme des montants regroupés pour "Autres")
  part: number; // fraction du total représenté, entre 0 et 1
}

export interface Structure {
  parts: PartStructure[];
  total: number; // somme signée des montants représentés
  // Catégories des étages concernés qui ne peuvent pas être représentées par une part : montant nul
  // ou de signe contraire (un revenu net négatif, un "coût" net positif).
  nombreNonRepresentees: number;
}

export const CLE_AUTRES = "autres";
// Par défaut, 5 catégories distinctes par camembert puis "Autres" (6 parts au plus). Un écran aux
// catégories naturellement plus éclatées peut en demander davantage (voir lib/pastDetail.ts), dans
// la limite du nombre de teintes distinctes disponibles (lib/dataviz.ts).
export const MAX_CATEGORIES_STRUCTURE = 5;

export type SensStructure = "revenus" | "couts";

export interface OptionsStructure {
  maxCategories?: number;
  // Catégorie sélectionnée : elle garde toujours sa propre part, même petite — une autre petite
  // catégorie rejoint "Autres" à sa place si la limite l'exige.
  epingle?: string | null;
}

/**
 * Répartition par catégorie pour un camembert. `sens` fixe ce qu'une part représente : des
 * montants positifs (revenus) ou négatifs (coûts) ; la taille d'une part est la valeur absolue de
 * son montant, le montant lui-même reste signé. Au-delà de `maxCategories`, les plus petites sont
 * regroupées en une part "Autres (n catégories)".
 */
export function structureParCategorie(
  categories: PnlCategorie[],
  etages: readonly EtagePnl[],
  sens: SensStructure,
  { maxCategories = MAX_CATEGORIES_STRUCTURE, epingle = null }: OptionsStructure = {}
): Structure {
  const concernees = categories.filter((c) => etages.includes(c.etage));
  const representables = concernees
    .filter((c) => (sens === "revenus" ? c.montant > 0 : c.montant < 0))
    .sort((a, b) => Math.abs(b.montant) - Math.abs(a.montant) || a.sourceCategoryName.localeCompare(b.sourceCategoryName, "fr"));
  const total = representables.reduce((somme, c) => somme + c.montant, 0);

  let principales = representables.slice(0, maxCategories);
  const epinglee = epingle ? representables.find((c) => c.sourceCategoryId === epingle) : undefined;
  if (epinglee && !principales.includes(epinglee)) {
    principales = [...principales.slice(0, maxCategories - 1), epinglee];
  }
  const reste = representables.filter((c) => !principales.includes(c));
  const parts: PartStructure[] = principales.map((c) => ({
    cle: c.sourceCategoryId,
    nom: c.sourceCategoryName,
    montant: c.montant,
    part: c.montant / total,
  }));
  if (reste.length > 0) {
    const montant = reste.reduce((somme, c) => somme + c.montant, 0);
    parts.push({
      cle: CLE_AUTRES,
      nom: reste.length > 1 ? `Autres (${reste.length} catégories)` : "Autres (1 catégorie)",
      montant,
      part: montant / total,
    });
  }
  return { parts, total, nombreNonRepresentees: concernees.length - representables.length };
}
