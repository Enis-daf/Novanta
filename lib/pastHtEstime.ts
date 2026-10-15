/**
 * Lecture « HT estimé » du module Passé — pur, sans effet de bord.
 *
 * Les transactions restent TTC : c'est leur seule réalité. La lecture HT est une PROJECTION, à
 * partir d'un taux de TVA fixe posé par l'utilisateur sur chaque catégorie (past_category_mappings.
 * vat_rate) : montant HT estimé = montant TTC / (1 + taux / 100). Ce n'est pas une comptabilité.
 *
 * Règles, par nature de donnée :
 *  - part de transaction d'un étage ÉCONOMIQUE (Encaissements, Coûts directs, Autres coûts variables,
 *    Coûts de structure) : convertie au taux de SA catégorie, sur son montant attribué, AVANT toute
 *    agrégation. Taux non défini : la part n'est pas convertie et elle est signalée (tvaManquante) ;
 *    elle n'est jamais assimilée à 0 % ;
 *  - part d'un étage de TRÉSORERIE (Extra P&L, Virements internes & Financement) : jamais convertie.
 *    Le Cash flow opérationnel et la Variation de trésorerie sont des flux bancaires réels : ils
 *    restent TTC et sont toujours calculés sur leur propre base TTC, jamais à partir d'un EBITDA HT ;
 *  - ajustement de gestion (variation de stock, et tout autre ajustement saisi) : jamais converti.
 *    Ce sont des valeurs de gestion saisies dans Novanta, pas des flux soumis à TVA : un stock se
 *    valorise hors taxe, et le diviser par 1,2 le convertirait à tort. Il est repris tel quel dans
 *    les deux lectures, et l'avertissement HT le dit.
 *
 * Les soldes (marges, EBITDA) ne sont jamais convertis eux-mêmes : ils sont recalculés à partir de
 * leurs composantes converties.
 */
import { calculerPnl, Pnl, PnlCategorie } from "./pastPnl";
import { AjustementGestion, sommeAjustements } from "./pastAdjustments";
import { EtagePnl, MappingCategorie } from "./pastCategoryMapping";
import { PartMappee, partsMappees } from "./pastDetail";
import { CouvertureTva, couvertureTva } from "./pastCouvertureTva";

export { couvertureTva, libelleCouverture } from "./pastCouvertureTva";
export type { CategorieSansTva, CouvertureTva } from "./pastCouvertureTva";
import { PastTransactionStockee } from "./pastTransactions";
import { MENTION_TTC } from "./format";

// Textes de la lecture HT estimé : la trésorerie reste sur la base TTC.
export const LIBELLE_FRONTIERE_TRESORERIE = `Trésorerie : flux bancaires réels, toujours en ${MENTION_TTC}`;
export const LIBELLE_ECARTS_EN_TTC = `L'analyse d'écarts porte sur le Cash flow : des flux bancaires réels, toujours en ${MENTION_TTC}.`;
export const LIBELLE_TVA_SANS_OBJET = `Flux de trésorerie : toujours lu en ${MENTION_TTC}`;

export type BaseMontants = "ttc" | "ht";

// Lecture du module Passé à l'ouverture, tant que l'utilisateur n'en a pas choisi une autre.
export const BASE_PAR_DEFAUT: BaseMontants = "ht";

/** Clé du stockage local de la lecture choisie, propre à chaque organisation (comme la période). */
export function cleStockageBase(organizationId: string): string {
  return `past_reporting_basis_${organizationId}`;
}

/** Lecture enregistrée : un choix explicite (« ttc » ou « ht ») est repris, sinon HT estimé. */
export function baseEnregistree(valeur: string | null): BaseMontants {
  return valeur === "ttc" || valeur === "ht" ? valeur : BASE_PAR_DEFAUT;
}

/** Taux proposés dans la correspondance P&L ; « Autre » permet tout taux valide. */
export const TAUX_TVA_PROPOSES = [0, 2.1, 5.5, 10, 20] as const;

/** Taux enregistrable : un pourcentage fini, de 0 (valeur valide) à moins de 100. */
export function estTauxTvaValide(taux: unknown): taux is number {
  return typeof taux === "number" && Number.isFinite(taux) && taux >= 0 && taux < 100;
}

/** Montant HT estimé d'un montant TTC signé : le signe est conservé. */
export function montantHtEstime(montantTtc: number, tauxTva: number): number {
  return montantTtc / (1 + tauxTva / 100);
}

/** Étages dont la lecture HT a un sens : ceux du P&L d'exploitation, jusqu'à l'EBITDA. */
export const ETAGES_ECONOMIQUES: readonly EtagePnl[] = ["revenue", "gross_margin", "contribution_margin", "ebitda"];

export function estEtageEconomique(etage: EtagePnl): boolean {
  return ETAGES_ECONOMIQUES.includes(etage);
}

/** Taux de TVA de chaque catégorie (null = non défini), d'après les correspondances. */
export function tauxParCategorie(mappings: ReadonlyMap<string, MappingCategorie> | MappingCategorie[]): ReadonlyMap<string, number | null> {
  const liste = Array.isArray(mappings) ? mappings : [...mappings.values()];
  return new Map(liste.map((m) => [m.sourceCategoryId, estTauxTvaValide(m.vatRate) ? m.vatRate : null]));
}

/**
 * Parts exprimées dans la base demandée. TTC : les parts telles quelles (même tableau). HT : une
 * copie, parts économiques converties au taux de leur catégorie ; montantTtc garde toujours le
 * montant d'origine. Une part n'est jamais convertie deux fois : seules des parts TTC entrent ici.
 */
export function partsEnBase(parts: PartMappee[], taux: ReadonlyMap<string, number | null>, base: BaseMontants): PartMappee[] {
  if (base === "ttc") return parts;
  return parts.map((part) => {
    if (part.montantTtc !== undefined) throw new Error("Part déjà convertie : une seule conversion par part.");
    if (!estEtageEconomique(part.etage)) return { ...part, montantTtc: part.montant };
    const tauxCategorie = taux.get(part.sourceCategoryId) ?? null;
    if (tauxCategorie === null) return { ...part, montantTtc: part.montant, tvaManquante: true };
    return { ...part, montant: montantHtEstime(part.montant, tauxCategorie), montantTtc: part.montant };
  });
}

export type IndicateurEconomique = "ca" | "margeBrute" | "margeContributive" | "ebitda";

/** Étages dont les montants composent chaque indicateur économique. */
export const ETAGES_DE_L_INDICATEUR: Record<IndicateurEconomique, readonly EtagePnl[]> = {
  ca: ["revenue"],
  margeBrute: ["revenue", "gross_margin"],
  margeContributive: ["revenue", "gross_margin", "contribution_margin"],
  ebitda: ["revenue", "gross_margin", "contribution_margin", "ebitda"],
};

export interface PnlEnBase extends Pnl {
  base: BaseMontants;
  // Couverture de la TVA par indicateur économique ; null en lecture TTC.
  couvertures: Record<IndicateurEconomique, CouvertureTva> | null;
}

/**
 * P&L dans la base demandée. TTC : exactement calculerPnl. HT estimé :
 *  - Encaissements, coûts et leurs catégories : sommes des parts converties ;
 *  - Marge brute, Marge contributive, EBITDA : recalculés à partir de ces composantes (ajustements
 *    de gestion compris, non convertis) ;
 *  - ratios : HT sur HT ;
 *  - Extra P&L, Financement, Cash flow opérationnel, Variation de trésorerie : ceux du P&L TTC,
 *    à l'identique.
 */
export function calculerPnlEnBase(
  transactions: PastTransactionStockee[],
  axeId: string | null,
  mappings: ReadonlyMap<string, MappingCategorie>,
  ajustements: AjustementGestion[],
  base: BaseMontants
): PnlEnBase {
  const pnlTtc = calculerPnl(transactions, axeId, mappings, ajustements);
  if (base === "ttc") return { ...pnlTtc, base, couvertures: null };

  const parts = partsEnBase(partsMappees(transactions, axeId, mappings), tauxParCategorie(mappings), "ht");
  const totalEtage = (etage: EtagePnl) => parts.reduce((total, p) => (p.etage === etage ? total + p.montant : total), 0);
  const ajuste = (etage: EtagePnl) => totalEtage(etage) + sommeAjustements(ajustements, [etage]);

  const caAjuste = ajuste("revenue");
  const margeBrute = caAjuste + ajuste("gross_margin");
  const margeContributive = margeBrute + ajuste("contribution_margin");
  const ebitda = margeContributive + ajuste("ebitda");
  const ratio = (valeur: number) => (caAjuste === 0 ? null : valeur / caAjuste);

  const parCategorie = new Map<string, PnlCategorie>();
  for (const part of parts) {
    const cumul = parCategorie.get(part.sourceCategoryId) ?? {
      sourceCategoryId: part.sourceCategoryId,
      sourceCategoryName: part.sourceCategoryName,
      etage: part.etage,
      montant: 0,
    };
    cumul.montant += part.montant;
    parCategorie.set(part.sourceCategoryId, cumul);
  }

  const couvertureDe = (indicateur: IndicateurEconomique) => couvertureTva(parts.filter((p) => ETAGES_DE_L_INDICATEUR[indicateur].includes(p.etage)));

  return {
    ...pnlTtc,
    base,
    ca: totalEtage("revenue"),
    coutsDirects: totalEtage("gross_margin"),
    margeBrute,
    coutsCommerciaux: totalEtage("contribution_margin"),
    margeContributive,
    coutsStructure: totalEtage("ebitda"),
    ebitda,
    // Trésorerie : TTC, toujours. Jamais EBITDA HT + flux TTC.
    extraPnl: pnlTtc.extraPnl,
    financements: pnlTtc.financements,
    cashFlowOperationnel: pnlTtc.cashFlowOperationnel,
    variationTresorerie: pnlTtc.variationTresorerie,
    ratios: { margeBrute: ratio(margeBrute), margeContributive: ratio(margeContributive), ebitda: ratio(ebitda) },
    categories: [...parCategorie.values()],
    couvertures: {
      ca: couvertureDe("ca"),
      margeBrute: couvertureDe("margeBrute"),
      margeContributive: couvertureDe("margeContributive"),
      ebitda: couvertureDe("ebitda"),
    },
  };
}
