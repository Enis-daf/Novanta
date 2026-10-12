import { estDateValide, parseDateISO, toISODate } from "./dates";
import { formatKiloEuros, formatPourcentage } from "./format";
import { AjustementGestion } from "./pastAdjustments";
import { calculerDetail, MetriqueDetail, PartMappee } from "./pastDetail";
import { Periode } from "./pastTransactions";

/**
 * Cibles de performance du module "Passé" — trois références, pas un budget :
 *  - Marge brute cible et Marge contributive cible, en % du CA, définies PAR CATÉGORIE DE CA ;
 *  - Coûts de structure cibles, un montant mensuel en euros, global à l'organisation.
 * Fonctions pures : elles comparent le réalisé (calculé par lib/pastDetail.ts, comme les écrans)
 * à la cible en vigueur. Aucune formule du P&L n'est réécrite ici.
 *
 * Marges : personne ne saisit une cible globale. La cible globale d'une période se CALCULE, en
 * pondérant la cible de chaque catégorie de CA par le CA réellement réalisé dans cette catégorie :
 * « compte tenu du mix de CA réalisé, quelle marge aurais-je dû obtenir ? ». Un changement de mix
 * déplace donc la cible. On ne calcule pas pour autant une marge réelle par catégorie — les coûts
 * ne sont pas rattachés au CA.
 *
 * Les cibles sont DATÉES : une valeur s'applique à partir de sa date d'effet, jusqu'à la date
 * d'effet de la suivante. Changer une cible aujourd'hui ne réécrit donc pas la lecture du passé.
 */

export const TYPES_CIBLE = [
  { cle: "gross_margin_pct", libelle: "Marge brute cible", unite: "%" },
  { cle: "contribution_margin_pct", libelle: "Marge contributive cible", unite: "%" },
  { cle: "structure_cost_monthly", libelle: "Coûts de structure mensuels", unite: "€" },
] as const;

export type TypeCible = (typeof TYPES_CIBLE)[number]["cle"];

export function estTypeCible(valeur: unknown): valeur is TypeCible {
  return TYPES_CIBLE.some((t) => t.cle === valeur);
}

// Dimension d'une cible : l'identifiant stable de la catégorie de CA (sourceCategoryId) pour une
// cible de marge ; vide pour les coûts de structure, qui sont globaux.
export const DIMENSION_GLOBALE = "";

export function estCibleDeMarge(type: TypeCible): boolean {
  return type !== "structure_cost_monthly";
}

export interface Cible {
  id: string;
  type: TypeCible;
  dimension: string; // catégorie de CA, ou DIMENSION_GLOBALE
  validFrom: string; // YYYY-MM-DD, date d'effet incluse
  // Pourcentage (44 pour 44 %) pour les marges, euros par mois pour les coûts de structure.
  valeur: number;
}

/** Valeur saisie acceptable pour un type de cible : un pourcentage plausible, ou un montant positif. */
export function valeurCibleValide(type: TypeCible, valeur: number): boolean {
  if (!Number.isFinite(valeur)) return false;
  return type === "structure_cost_monthly" ? valeur >= 0 : valeur >= -100 && valeur <= 100;
}

/** Cibles d'un type et d'une dimension, de la plus ancienne à la plus récente date d'effet. */
export function historiqueDesCibles(cibles: Cible[], type: TypeCible, dimension: string = DIMENSION_GLOBALE): Cible[] {
  return cibles
    .filter((c) => c.type === type && c.dimension === dimension)
    .sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
}

/** Cible en vigueur à une date : la dernière dont la date d'effet est atteinte. null avant la première. */
export function cibleEnVigueur(cibles: Cible[], type: TypeCible, date: string, dimension: string = DIMENSION_GLOBALE): number | null {
  let valeur: number | null = null;
  for (const cible of historiqueDesCibles(cibles, type, dimension)) {
    if (cible.validFrom > date) break;
    valeur = cible.valeur;
  }
  return valeur;
}

export interface CiblePeriode {
  // Cible de la période : fraction (0,44) pour une marge, euros pour les coûts de structure.
  valeur: number;
  // Part de la période réellement couverte par une cible (1 = toute la période). En dessous de 1,
  // une partie de la période est antérieure à la première cible : rien n'y est inventé.
  couverture: number;
}

/** Revenu daté d'une catégorie de CA (null : revenu sans catégorie, un ajustement de gestion). */
export interface RevenuCible {
  date: string;
  montant: number;
  categorie: string | null;
}

/**
 * Cible de marge d'une période, en fraction du CA : la moyenne des cibles des catégories de CA,
 * PONDÉRÉE par leur CA réel — jamais une moyenne simple des pourcentages.
 *
 *   cible = Σ (CA réel × cible de sa catégorie, en vigueur à sa date) / Σ (CA réel couvert)
 *
 * Chaque revenu est rapproché de la cible de SA catégorie à SA date : une cible qui change en
 * cours de période s'applique à partir de sa date d'effet, pas rétroactivement. Un revenu dont la
 * catégorie n'a pas de cible ne reçoit ni 0 % ni une moyenne des autres : il sort du calcul, et la
 * couverture le dit. null quand aucun revenu n'est couvert.
 */
export function cibleDeMarge(cibles: Cible[], type: TypeCible, revenus: RevenuCible[]): CiblePeriode | null {
  // Historique par catégorie, préparé une fois : la période peut porter des milliers de revenus.
  const parCategorie = new Map<string, Cible[]>();
  for (const cible of cibles) {
    if (cible.type !== type || cible.dimension === DIMENSION_GLOBALE) continue;
    parCategorie.set(cible.dimension, [...(parCategorie.get(cible.dimension) ?? []), cible]);
  }
  let caCouvert = 0;
  let caTotal = 0;
  let margeCible = 0;
  for (const revenu of revenus) {
    caTotal += revenu.montant;
    const historique = revenu.categorie === null ? undefined : parCategorie.get(revenu.categorie);
    const cible = historique ? cibleEnVigueur(historique, type, revenu.date, revenu.categorie!) : null;
    if (cible === null) continue;
    caCouvert += revenu.montant;
    margeCible += revenu.montant * (cible / 100);
  }
  if (caCouvert <= 0) return null;
  return { valeur: margeCible / caCouvert, couverture: caTotal <= 0 ? 1 : Math.min(1, Math.max(0, caCouvert / caTotal)) };
}

/**
 * Cible de coûts de structure d'une période : la cible mensuelle en vigueur, jour par jour, au
 * prorata des jours de chaque mois. Trois mois entiers à 85 k€ donnent 255 k€ ; un changement de
 * cible en cours de période est pris à sa date. null quand aucun jour n'est couvert.
 */
export function cibleDeCoutsDeStructure(cibles: Cible[], periode: Periode): CiblePeriode | null {
  if (!estDateValide(periode.debut) || !estDateValide(periode.fin) || periode.debut > periode.fin) return null;
  let total = 0;
  let joursCouverts = 0;
  let jours = 0;
  const fin = parseDateISO(periode.fin);
  for (const jour = parseDateISO(periode.debut); jour <= fin; jour.setDate(jour.getDate() + 1)) {
    jours++;
    const mensuelle = cibleEnVigueur(cibles, "structure_cost_monthly", toISODate(jour));
    if (mensuelle === null) continue;
    joursCouverts++;
    total += mensuelle / new Date(jour.getFullYear(), jour.getMonth() + 1, 0).getDate();
  }
  return joursCouverts === 0 ? null : { valeur: total, couverture: joursCouverts / jours };
}

/**
 * Lecture d'un écart : favorable, défavorable, dans la cible (micro-écart sans signification), ou
 * « incomplet » quand la cible couvre trop peu du CA pour porter un verdict.
 */
export type StatutCible = "favorable" | "defavorable" | "neutre" | "incomplet";

// En dessous, la cible ne couvre pas assez de CA : l'écart reste montré, à titre indicatif, mais
// sans lecture favorable / défavorable.
export const COUVERTURE_MIN_VERDICT = 0.8;
// Au-dessus, la couverture est tenue pour complète (arrondis de pondération).
const COUVERTURE_COMPLETE = 0.999;

// Tolérances : en dessous, l'écart n'est ni bon ni mauvais — c'est du bruit.
const TOLERANCE_MARGE_POINTS = 0.002; // 0,2 point
const TOLERANCE_COUTS_RELATIVE = 0.01; // 1 % de la cible…
const TOLERANCE_COUTS_ABSOLUE = 100; // …et jamais moins de 100 €

export interface EcartMarge {
  realise: number; // fraction du CA
  cible: number; // fraction du CA
  ecartPoints: number; // réalisé − cible, en fraction (0,038 = 3,8 points)
  // Marge qui manque (négatif) ou dépasse (positif) par rapport à la cible, au CA réel observé.
  // null quand la couverture est incomplète : la marge réalisée porte sur tout le CA, la cible sur
  // une partie seulement — les multiplier donnerait un montant qui n'a pas de sens.
  ecartEuros: number | null;
  statut: StatutCible;
  couverture: number;
}

/** Marge réalisée face à sa cible. Au-dessus de la cible : favorable. */
export function ecartDeMarge(realise: number, ca: number, cible: CiblePeriode): EcartMarge {
  const ecartPoints = realise - cible.valeur;
  const complete = cible.couverture >= COUVERTURE_COMPLETE;
  return {
    realise,
    cible: cible.valeur,
    ecartPoints,
    ecartEuros: complete ? ca * ecartPoints : null,
    statut:
      cible.couverture < COUVERTURE_MIN_VERDICT
        ? "incomplet"
        : Math.abs(ecartPoints) <= TOLERANCE_MARGE_POINTS
          ? "neutre"
          : ecartPoints > 0
            ? "favorable"
            : "defavorable",
    couverture: cible.couverture,
  };
}

export interface EcartCouts {
  realise: number; // coûts de la période, en positif (94 000 pour 94 k€ dépensés)
  cible: number; // en positif
  // réalisé − cible : positif = coûts AU-DESSUS de la cible (défavorable).
  ecart: number;
  statut: StatutCible;
  couverture: number;
}

/**
 * Coûts de structure réalisés face à leur cible. `montantEtage` est le total signé de l'étage tel
 * que le P&L le porte (négatif pour des dépenses) ; l'écart, lui, se lit en coûts : « +9 k€ vs
 * cible » veut dire 9 k€ de coûts de plus que prévu. En dessous de la cible : favorable.
 */
export function ecartDeCouts(montantEtage: number, cible: CiblePeriode): EcartCouts {
  const realise = -montantEtage;
  const ecart = realise - cible.valeur;
  const tolerance = Math.max(TOLERANCE_COUTS_RELATIVE * Math.abs(cible.valeur), TOLERANCE_COUTS_ABSOLUE);
  return {
    realise,
    cible: cible.valeur,
    ecart,
    statut: Math.abs(ecart) <= tolerance ? "neutre" : ecart < 0 ? "favorable" : "defavorable",
    couverture: cible.couverture,
  };
}

/** Ce que les écrans affichent : null = aucune cible applicable (ou pas de CA), jamais un 0 inventé. */
export interface EcartsVsCibles {
  margeBrute: EcartMarge | null;
  margeContributive: EcartMarge | null;
  coutsStructure: EcartCouts | null;
  // Total signé de l'étage « Coûts de structure » sur le périmètre (ajustements compris).
  montantCoutsStructure: number;
}

const SANS_CATEGORIE = { categorie: null } as const;

/**
 * Réalisé face aux cibles, sur la période du module ou sur un de ses mois. SEULE fonction de
 * comparaison : l'onglet Général et les écrans de détail l'appellent tous, et le réalisé vient de
 * calculerDetail — les mêmes indicateurs, les mêmes ratios que ceux qu'ils affichent.
 *
 *  - `mois` (YYYY-MM) : restreint tout au mois — le CA qui pondère, les cibles en vigueur ce
 *    mois-là, le réalisé, et la cible de coûts de structure (un mois de cible).
 *  - Seul le CA des catégories actuellement rattachées à l'étage CA pondère la cible : une
 *    catégorie remappée ailleurs n'y compte plus, même si une cible lui reste enregistrée.
 */
export function ecartsVsCibles(
  cibles: Cible[],
  parts: PartMappee[],
  ajustements: AjustementGestion[],
  periode: Periode,
  mois: string | null = null
): EcartsVsCibles {
  const filtres = { ...SANS_CATEGORIE, mois };
  const kpi = (metrique: MetriqueDetail) => calculerDetail(parts, metrique, filtres, periode, ajustements).kpi;
  const duMois = (date: string) => mois === null || date.slice(0, 7) === mois;
  const revenus: RevenuCible[] = [
    ...parts.filter((p) => p.etage === "revenue" && duMois(p.transactionDate)).map((p) => ({ date: p.transactionDate, montant: p.montant, categorie: p.sourceCategoryId })),
    // Un ajustement de gestion du CA n'a pas de catégorie : il compte dans le CA, pas dans la cible.
    ...ajustements.filter((a) => a.etage === "revenue" && duMois(a.date)).map((a) => ({ date: a.date, montant: a.montant, categorie: null })),
  ];
  const ca = revenus.reduce((somme, revenu) => somme + revenu.montant, 0);

  const marge = (type: TypeCible, metrique: MetriqueDetail): EcartMarge | null => {
    const cible = cibleDeMarge(cibles, type, revenus);
    const ratio = kpi(metrique).ratio;
    return cible === null || ratio === null || ratio === undefined ? null : ecartDeMarge(ratio, ca, cible);
  };

  // Coûts de structure : ce qui sépare la Marge contributive de l'EBITDA.
  const montantCoutsStructure = kpi("ebitda").montant - kpi("marge_contributive").montant;
  const cibleCouts = cibleDeCoutsDeStructure(cibles, mois === null ? periode : periodeDuMois(mois, periode));
  return {
    margeBrute: marge("gross_margin_pct", "marge_brute"),
    margeContributive: marge("contribution_margin_pct", "marge_contributive"),
    coutsStructure: cibleCouts === null ? null : ecartDeCouts(montantCoutsStructure, cibleCouts),
    montantCoutsStructure,
  };
}

/** Bornes d'un mois, limitées à la période du module (un mois entamé reste entamé). */
function periodeDuMois(mois: string, periode: Periode): Periode {
  const annee = Number(mois.slice(0, 4));
  const numero = Number(mois.slice(5, 7));
  const debut = `${mois}-01`;
  const fin = `${mois}-${String(new Date(annee, numero, 0).getDate()).padStart(2, "0")}`;
  return { debut: debut < periode.debut ? periode.debut : debut, fin: fin > periode.fin ? periode.fin : fin };
}

// --- Libellés : factuels, jamais un verdict (« Cible 44,0 % · -3,8 pts · -27 k€ vs cible ») ---

const espaces = (texte: string) => texte.replace(/[\u202f\u00a0]/g, " ");
const signe = (valeur: number, texte: string) => (valeur > 0 ? `+${texte}` : texte);
const enK = (montant: number) => espaces(formatKiloEuros(montant, Math.abs(montant) < 10_000 ? 1 : 0));
const formatPoints = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Écart de marge en points : « -3,8 pts », « +2,0 pts ». */
export function libellePoints(fraction: number): string {
  const points = Math.round(fraction * 1000) / 10;
  return `${signe(points, espaces(formatPoints.format(points === 0 ? 0 : points)))} pt${Math.abs(points) >= 2 ? "s" : ""}`;
}

export interface LibellesCible {
  cible: string;
  ecart: string;
  // Précision à afficher quand la cible ne couvre qu'une partie de la période, sinon null.
  reserve: string | null;
}

export function libellesEcartMarge(ecart: EcartMarge): LibellesCible {
  const couvert = `${Math.round(ecart.couverture * 100)} % du CA`;
  const points = libellePoints(ecart.ecartPoints);
  return {
    cible: `Cible ${espaces(formatPourcentage(ecart.cible))}`,
    ecart:
      ecart.statut === "incomplet"
        ? `${points} (indicatif)`
        : ecart.ecartEuros === null
          ? `${points} vs cible`
          : `${points} · ${signe(ecart.ecartEuros, enK(ecart.ecartEuros))} vs cible`,
    reserve:
      ecart.statut === "incomplet"
        ? `Cible incomplète — ${couvert} couvert`
        : ecart.couverture < COUVERTURE_COMPLETE
          ? `Cible calculée sur ${couvert}`
          : null,
  };
}

export function libellesEcartCouts(ecart: EcartCouts): LibellesCible {
  return {
    cible: `Cible ${enK(ecart.cible)}`,
    ecart: `${signe(ecart.ecart, enK(ecart.ecart))} vs cible`,
    reserve: ecart.couverture < COUVERTURE_COMPLETE ? `Cible définie sur ${Math.round(ecart.couverture * 100)} % de la période` : null,
  };
}
