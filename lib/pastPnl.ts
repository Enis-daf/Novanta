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
 */

/** Montant d'une catégorie sur la période, dans son étage P&L courant. */
export interface PnlCategorie {
  sourceCategoryId: string;
  sourceCategoryName: string;
  etage: EtagePnl;
  montant: number;
}

export interface Pnl {
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
  mappings: ReadonlyMap<string, MappingCategorie>
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

  const ca = totaux.revenue;
  const margeBrute = ca + totaux.gross_margin;
  const margeContributive = margeBrute + totaux.contribution_margin;
  const ebitda = margeContributive + totaux.ebitda;

  return {
    ca,
    coutsDirects: totaux.gross_margin,
    margeBrute,
    coutsCommerciaux: totaux.contribution_margin,
    margeContributive,
    coutsStructure: totaux.ebitda,
    ebitda,
    extraPnl: totaux.extra_pnl,
    cashFlow: calculerCashFlow(ebitda, totaux.extra_pnl),
    ratios: {
      margeBrute: ratio(margeBrute, ca),
      margeContributive: ratio(margeContributive, ca),
      ebitda: ratio(ebitda, ca),
    },
    categories: [...parCategorie.values()],
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
export const MAX_PARTS_STRUCTURE = 6;

/**
 * Répartition par catégorie pour un camembert. `sens` fixe ce qu'une part représente : des
 * montants positifs (revenus) ou négatifs (coûts) ; la taille d'une part est la valeur absolue de
 * son montant, le montant lui-même reste signé. Au-delà de MAX_PARTS_STRUCTURE catégories, les
 * plus petites sont regroupées en une part "Autres" (les 5 plus grandes + Autres).
 */
export function structureParCategorie(
  categories: PnlCategorie[],
  etages: readonly EtagePnl[],
  sens: "revenus" | "couts"
): Structure {
  const concernees = categories.filter((c) => etages.includes(c.etage));
  const representables = concernees
    .filter((c) => (sens === "revenus" ? c.montant > 0 : c.montant < 0))
    .sort((a, b) => Math.abs(b.montant) - Math.abs(a.montant) || a.sourceCategoryName.localeCompare(b.sourceCategoryName, "fr"));
  const total = representables.reduce((somme, c) => somme + c.montant, 0);

  const principales = representables.length > MAX_PARTS_STRUCTURE ? representables.slice(0, MAX_PARTS_STRUCTURE - 1) : representables;
  const reste = representables.slice(principales.length);
  const parts: PartStructure[] = principales.map((c) => ({
    cle: c.sourceCategoryId,
    nom: c.sourceCategoryName,
    montant: c.montant,
    part: c.montant / total,
  }));
  if (reste.length > 0) {
    const montant = reste.reduce((somme, c) => somme + c.montant, 0);
    parts.push({ cle: CLE_AUTRES, nom: `Autres (${reste.length} catégories)`, montant, part: montant / total });
  }
  return { parts, total, nombreNonRepresentees: concernees.length - representables.length };
}
