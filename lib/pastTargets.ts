import { estDateValide, parseDateISO, toISODate } from "./dates";
import { formatKiloEuros, formatPourcentage, MENTION_TTC } from "./format";
import { AjustementGestion } from "./pastAdjustments";
import type { EtagePnl } from "./pastCategoryMapping";
import { couvertureTva } from "./pastCouvertureTva";
import { calculerDetail, MetriqueDetail, PartMappee } from "./pastDetail";
import type { BaseMontants } from "./pastHtEstime";
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
 *
 * Lecture TTC ou HT estimé : tout se calcule dans la base active, à partir de parts déjà
 * exprimées dans cette base (lib/pastHtEstime.ts). Un pourcentage de marge vaut dans les deux
 * lectures ; seule sa pondération suit les encaissements de la base. Un objectif de coûts de
 * structure est un MONTANT : il porte sa propre base (HT ou TTC) et n'est jamais converti. Il ne
 * se compare qu'à des coûts de la même base.
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
  // Note libre de l'utilisateur sur CETTE version de l'objectif (l'hypothèse derrière le chiffre).
  // Propre à la version datée : jamais partagée avec la catégorie, ni recopiée sur une nouvelle
  // version. Absente ou null : pas de commentaire.
  commentaire?: string | null;
  // Base du montant d'un objectif de coûts de structure. Absente ou null : objectif historique,
  // posé sur des montants TTC — il est lu comme TTC, jamais converti. Sans objet pour une marge.
  base?: BaseMontants | null;
}

/** Base d'un objectif de coûts de structure : celle enregistrée, TTC pour un objectif historique. */
export function baseDeLaCible(cible: Cible): BaseMontants {
  return cible.base ?? "ttc";
}

// Base d'un nouvel objectif de coûts de structure, tant que l'utilisateur n'en choisit pas une autre.
export const BASE_PAR_DEFAUT_OBJECTIF: BaseMontants = "ht";

const MENTION_DE_LA_BASE: Record<BaseMontants, string> = { ht: "HT", ttc: MENTION_TTC };

/** « Objectif défini en TTC » : objectif de coûts de structure posé dans l'autre base. */
export function libelleObjectifDefiniEn(base: BaseMontants): string {
  return `Objectif défini en ${MENTION_DE_LA_BASE[base]}`;
}

/** Unité d'un objectif de coûts de structure : « € HT / mois ». */
export function uniteCoutsDeStructure(base: BaseMontants): string {
  return `€ ${MENTION_DE_LA_BASE[base]} / mois`;
}

export const LONGUEUR_MAX_COMMENTAIRE = 2000;

/** Commentaire saisi, nettoyé : espaces de bord retirés, vide = pas de commentaire. */
export function normaliserCommentaire(saisie: string): string | null {
  const texte = saisie.trim().slice(0, LONGUEUR_MAX_COMMENTAIRE);
  return texte === "" ? null : texte;
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

/**
 * Enregistrer une cible : l'utilisateur n'a pas à savoir s'il crée ou s'il modifie. Ces fonctions
 * décident, et disent quelles écritures faire (`operations`), que l'appelant applique telles
 * quelles. Règle : une cible est identifiée par son type, sa dimension (la catégorie de CA) et sa
 * date d'effet — il n'y en a jamais deux pour la même clé.
 *
 *  - même clé, même date d'effet  -> la cible existante est MISE À JOUR ;
 *  - nouvelle date d'effet        -> une nouvelle version s'AJOUTE à l'historique ;
 *  - cible corrigée dont la date est déplacée sur une date déjà prise -> conflit signalé : rien
 *    n'est écrasé sans une confirmation explicite (remplacerCible).
 */
export type OperationCible =
  | { type: "insert"; cible: Cible }
  // `base` : seulement quand la base d'un objectif de coûts de structure change.
  | { type: "update"; id: string; valeur: number; validFrom: string; base?: BaseMontants }
  | { type: "comment"; id: string; commentaire: string | null }
  | { type: "delete"; id: string };

export const MESSAGE_CONFLIT_CIBLE = "Une cible existe déjà à cette date.";

/** Autre cible du même type et de la même dimension déjà posée à cette date d'effet, sinon null. */
export function cibleEnConflit(cibles: Cible[], type: TypeCible, dimension: string, validFrom: string, saufId: string | null = null): Cible | null {
  return cibles.find((c) => c.type === type && c.dimension === dimension && c.validFrom === validFrom && c.id !== saufId) ?? null;
}

export interface ResultatCible {
  cibles: Cible[];
  operations: OperationCible[];
}

/**
 * Pose une cible à une date d'effet (mode création). S'il en existe déjà une pour la même clé à
 * cette date, c'est elle qui est mise à jour — pas d'erreur, pas de doublon ; sinon une nouvelle
 * version est ajoutée, sous `nouvelId` en attendant l'identifiant de la base.
 */
export function poserCible(
  cibles: Cible[],
  cle: { type: TypeCible; dimension: string; validFrom: string },
  valeur: number,
  nouvelId: string,
  base: BaseMontants = BASE_PAR_DEFAUT_OBJECTIF
): ResultatCible {
  // Base : celle choisie pour un objectif de coûts de structure, aucune pour une marge.
  const baseCible = estCibleDeMarge(cle.type) ? null : base;
  const existante = cibleEnConflit(cibles, cle.type, cle.dimension, cle.validFrom);
  if (existante) {
    const changeDeBase = baseCible !== null && baseDeLaCible(existante) !== baseCible;
    return {
      cibles: cibles.map((c) => (c.id === existante.id ? { ...c, valeur, ...(changeDeBase ? { base: baseCible } : {}) } : c)),
      operations:
        existante.valeur === valeur && !changeDeBase
          ? []
          : [{ type: "update", id: existante.id, valeur, validFrom: existante.validFrom, ...(changeDeBase ? { base: baseCible } : {}) }],
    };
  }
  // Une nouvelle version part sans commentaire : les hypothèses de la précédente ne lui sont pas
  // prêtées.
  const cible: Cible = { id: nouvelId, ...cle, valeur, commentaire: null, ...(baseCible !== null ? { base: baseCible } : {}) };
  return { cibles: [...cibles, cible], operations: [{ type: "insert", cible }] };
}

/**
 * Commentaire d'UNE version d'objectif : seule cette ligne change, et seulement son commentaire —
 * ni sa valeur ni sa date d'effet, et aucune version n'est créée. Les autres versions gardent le
 * leur. Inversement, corriger la valeur ou la date d'une cible ne touche pas à son commentaire.
 */
export function commenterCible(cibles: Cible[], id: string, saisie: string): ResultatCible {
  const cible = cibles.find((c) => c.id === id);
  const commentaire = normaliserCommentaire(saisie);
  if (!cible || (cible.commentaire ?? null) === commentaire) return { cibles, operations: [] };
  return {
    cibles: cibles.map((c) => (c.id === id ? { ...c, commentaire } : c)),
    operations: [{ type: "comment", id, commentaire }],
  };
}

/**
 * Correction d'une cible existante, désignée par son identifiant (mode édition) : seule cette
 * ligne change, son type et sa dimension ne se modifient pas, aucune ligne n'est créée.
 * `conflit` : la date d'effet demandée est déjà celle d'une AUTRE cible de la même clé — rien
 * n'est fait, à l'appelant de demander confirmation puis d'appeler remplacerCible.
 */
export function corrigerCible(
  cibles: Cible[],
  id: string,
  correction: { valeur: number; validFrom: string }
): (ResultatCible & { conflit: null }) | { cibles: null; operations: null; conflit: Cible } {
  const cible = cibles.find((c) => c.id === id);
  if (!cible) return { cibles, operations: [], conflit: null };
  const conflit = cibleEnConflit(cibles, cible.type, cible.dimension, correction.validFrom, id);
  if (conflit) return { cibles: null, operations: null, conflit };
  if (cible.valeur === correction.valeur && cible.validFrom === correction.validFrom) return { cibles, operations: [], conflit: null };
  return {
    cibles: cibles.map((c) => (c.id === id ? { ...c, ...correction } : c)),
    operations: [{ type: "update", id, ...correction }],
    conflit: null,
  };
}

/**
 * Remplacement confirmé : la cible corrigée prend la place de celle qui occupe déjà la date
 * demandée. La cible en place reçoit la nouvelle valeur, et la ligne corrigée disparaît — une seule
 * cible à cette date, jamais deux. Sans conflit, c'est une simple correction. Un montant de coûts
 * de structure garde la base dans laquelle il a été saisi : la cible en place la reçoit avec lui.
 */
export function remplacerCible(cibles: Cible[], id: string, correction: { valeur: number; validFrom: string }): ResultatCible {
  const resultat = corrigerCible(cibles, id, correction);
  if (resultat.conflit === null) return { cibles: resultat.cibles, operations: resultat.operations };
  const enPlace = resultat.conflit;
  const corrigee = cibles.find((c) => c.id === id)!;
  const changeDeBase = !estCibleDeMarge(corrigee.type) && baseDeLaCible(corrigee) !== baseDeLaCible(enPlace);
  const base = changeDeBase ? { base: baseDeLaCible(corrigee) } : {};
  return {
    cibles: cibles.filter((c) => c.id !== id).map((c) => (c.id === enPlace.id ? { ...c, valeur: correction.valeur, ...base } : c)),
    operations: [
      { type: "update", id: enPlace.id, valeur: correction.valeur, validFrom: enPlace.validFrom, ...base },
      { type: "delete", id },
    ],
  };
}

/** Version en vigueur à une date : la dernière dont la date d'effet est atteinte. null avant la première. */
export function versionEnVigueur(cibles: Cible[], type: TypeCible, date: string, dimension: string = DIMENSION_GLOBALE): Cible | null {
  let version: Cible | null = null;
  for (const cible of historiqueDesCibles(cibles, type, dimension)) {
    if (cible.validFrom > date) break;
    version = cible;
  }
  return version;
}

/** Cible en vigueur à une date : la dernière dont la date d'effet est atteinte. null avant la première. */
export function cibleEnVigueur(cibles: Cible[], type: TypeCible, date: string, dimension: string = DIMENSION_GLOBALE): number | null {
  return versionEnVigueur(cibles, type, date, dimension)?.valeur ?? null;
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

/** Chaque jour de la période et l'objectif de coûts de structure en vigueur ce jour-là. */
function versionsDeStructureParJour(cibles: Cible[], periode: Periode): { jour: Date; version: Cible | null }[] | null {
  if (!estDateValide(periode.debut) || !estDateValide(periode.fin) || periode.debut > periode.fin) return null;
  const jours: { jour: Date; version: Cible | null }[] = [];
  const fin = parseDateISO(periode.fin);
  for (const jour = parseDateISO(periode.debut); jour <= fin; jour.setDate(jour.getDate() + 1)) {
    jours.push({ jour: new Date(jour), version: versionEnVigueur(cibles, "structure_cost_monthly", toISODate(jour)) });
  }
  return jours;
}

/**
 * Cible de coûts de structure d'une période, dans la base demandée : la cible mensuelle en
 * vigueur, jour par jour, au prorata des jours de chaque mois. Trois mois entiers à 85 k€ donnent
 * 255 k€ ; un changement de cible en cours de période est pris à sa date. Un jour dont l'objectif
 * est posé dans l'autre base n'est pas couvert : rien n'est converti. null quand aucun jour n'est
 * couvert.
 */
export function cibleDeCoutsDeStructure(cibles: Cible[], periode: Periode, base: BaseMontants = "ttc"): CiblePeriode | null {
  const jours = versionsDeStructureParJour(cibles, periode);
  if (jours === null) return null;
  let total = 0;
  let joursCouverts = 0;
  for (const { jour, version } of jours) {
    if (version === null || baseDeLaCible(version) !== base) continue;
    joursCouverts++;
    total += version.valeur / new Date(jour.getFullYear(), jour.getMonth() + 1, 0).getDate();
  }
  return joursCouverts === 0 ? null : { valeur: total, couverture: joursCouverts / jours.length };
}

/**
 * Base d'un objectif de coûts de structure en vigueur sur la période et DIFFÉRENTE de la base
 * demandée, sinon null. Non null : l'objectif ne se compare pas dans cette lecture.
 */
export function baseDivergenteDesCoutsDeStructure(cibles: Cible[], periode: Periode, base: BaseMontants): BaseMontants | null {
  for (const { version } of versionsDeStructureParJour(cibles, periode) ?? []) {
    if (version !== null && baseDeLaCible(version) !== base) return baseDeLaCible(version);
  }
  return null;
}

/**
 * Lecture d'un écart : favorable, défavorable, dans la cible (micro-écart sans signification), ou
 * « incomplet » quand la cible couvre trop peu du CA pour porter un verdict.
 */
export type StatutCible = "favorable" | "defavorable" | "neutre" | "incomplet";

// En dessous, la cible ne couvre pas assez de CA : aucune lecture favorable / défavorable, et pas
// d'écart en euros pour une marge (il reste indicatif pour l'EBITDA).
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
  // Marge qui manque (négatif) ou dépasse (positif) par rapport à la cible, au CA réel observé :
  // marge réelle − CA réel × cible pondérée. null sous COUVERTURE_MIN_VERDICT : la cible porte sur
  // trop peu du CA pour être appliquée à tout le CA — même seuil que le verdict.
  ecartEuros: number | null;
  statut: StatutCible;
  couverture: number;
}

/** Marge réalisée face à sa cible. Au-dessus de la cible : favorable. */
export function ecartDeMarge(realise: number, ca: number, cible: CiblePeriode): EcartMarge {
  const ecartPoints = realise - cible.valeur;
  const suffisante = cible.couverture >= COUVERTURE_MIN_VERDICT;
  return {
    realise,
    cible: cible.valeur,
    ecartPoints,
    ecartEuros: suffisante ? ca * ecartPoints : null,
    statut:
      !suffisante
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

export interface EcartEbitda {
  realise: number; // EBITDA de la période, signé
  cible: number; // EBITDA attendu, signé
  ecart: number; // réalisé − cible : positif = au-dessus de la cible (favorable)
  statut: StatutCible;
  // Part du CA couverte par la cible de Marge contributive, et part de la période couverte par la
  // cible de coûts de structure : en dessous de 1, la cible d'EBITDA est partielle et le dit.
  couvertureCa: number;
  couverturePeriode: number;
}

/**
 * EBITDA cible : il ne se saisit pas, il se DÉDUIT des objectifs configurés —
 *
 *   EBITDA cible = CA réel × Marge contributive cible (pondérée) − Coûts de structure cibles
 *
 * « Avec le CA réalisé, la marge contributive attendue et la structure prévue, quel EBITDA
 * aurait-on dû obtenir ? ». Les deux briques suivent leurs dates d'effet (cibleDeMarge,
 * cibleDeCoutsDeStructure) ; cette fonction ne fait que les assembler. Au-dessus de la cible :
 * favorable. Si l'une des deux couvertures est incomplète, la cible reste montrée mais sans
 * verdict : elle est partielle.
 */
export function ecartDEbitda(ebitdaRealise: number, ca: number, cibleMargeContributive: CiblePeriode, cibleCoutsStructure: CiblePeriode): EcartEbitda {
  const cible = ca * cibleMargeContributive.valeur - cibleCoutsStructure.valeur;
  const ecart = ebitdaRealise - cible;
  const complete = cibleMargeContributive.couverture >= COUVERTURE_COMPLETE && cibleCoutsStructure.couverture >= COUVERTURE_COMPLETE;
  const tolerance = Math.max(TOLERANCE_COUTS_RELATIVE * Math.abs(cible), TOLERANCE_COUTS_ABSOLUE);
  return {
    realise: ebitdaRealise,
    cible,
    ecart,
    statut: !complete ? "incomplet" : Math.abs(ecart) <= tolerance ? "neutre" : ecart > 0 ? "favorable" : "defavorable",
    couvertureCa: cibleMargeContributive.couverture,
    couverturePeriode: cibleCoutsStructure.couverture,
  };
}

export type IndicateurCible = "margeBrute" | "margeContributive" | "ebitda" | "coutsStructure";

// Lecture HT estimé : la TVA n'est pas renseignée sur une partie des montants de l'indicateur. Le
// réalisé n'est pas fiable : aucun écart n'est calculé. Distinct de la couverture des OBJECTIFS
// (« Cible calculée sur 80 % des encaissements »), qui dit sur quoi porte la cible.
export const LIBELLE_ECART_TVA_INCOMPLETE = "Écart indisponible : TVA non renseignée sur une partie des montants";
export const LIBELLE_EBITDA_INDISPONIBLE = "Objectif EBITDA indisponible";

/** Ce que les écrans affichent : null = aucune cible applicable (ou pas de CA), jamais un 0 inventé. */
export interface EcartsVsCibles {
  // Base dans laquelle réalisé, cibles monétaires et écarts sont exprimés.
  base: BaseMontants;
  // Pourquoi un objectif qui existe n'est pas comparé dans cette base (TVA non renseignée, objectif
  // posé dans l'autre base) ; null quand rien ne l'empêche. L'écart correspondant est alors null.
  indisponibles: Record<IndicateurCible, string | null>;
  margeBrute: EcartMarge | null;
  margeContributive: EcartMarge | null;
  // Cible d'EBITDA dérivée (voir ecartDEbitda). null tant que l'une de ses deux briques manque ;
  // `ebitdaIncomplet` distingue alors « une seule des deux est définie » de « aucune ».
  ebitda: EcartEbitda | null;
  ebitdaIncomplet: boolean;
  // Brique sous-jacente de l'EBITDA cible, utile au diagnostic — pas la cible de l'EBITDA.
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
  mois: string | null = null,
  base: BaseMontants = "ttc"
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

  // Lecture HT : la TVA doit être renseignée sur TOUS les montants du périmètre de l'indicateur
  // (sur le mois filtré le cas échéant). Sinon, réalisé et pondération mêlent HT et TTC.
  const partsDuPerimetre = parts.filter((p) => duMois(p.transactionDate));
  const tvaComplete = (etages: readonly EtagePnl[]) =>
    base === "ttc" || couvertureTva(partsDuPerimetre.filter((p) => etages.includes(p.etage))).complete;
  const tvaMargeBrute = tvaComplete(["revenue", "gross_margin"]);
  const tvaMargeContributive = tvaComplete(["revenue", "gross_margin", "contribution_margin"]);
  const tvaEbitda = tvaComplete(["revenue", "gross_margin", "contribution_margin", "ebitda"]);
  const tvaCoutsStructure = tvaComplete(["ebitda"]);

  const cibleDe = (type: TypeCible) => cibleDeMarge(cibles, type, revenus);
  const marge = (cible: CiblePeriode | null, metrique: MetriqueDetail, tva: boolean): EcartMarge | null => {
    const ratio = kpi(metrique).ratio;
    return cible === null || !tva || ratio === null || ratio === undefined ? null : ecartDeMarge(ratio, ca, cible);
  };
  const cibleBrute = cibleDe("gross_margin_pct");
  const cibleContributive = cibleDe("contribution_margin_pct");

  // Coûts de structure : ce qui sépare la Marge contributive de l'EBITDA. Leur objectif ne vaut que
  // dans sa propre base : posé en TTC, il ne se compare pas à des coûts HT, et inversement.
  const ebitda = kpi("ebitda").montant;
  const montantCoutsStructure = ebitda - kpi("marge_contributive").montant;
  const periodeCouts = mois === null ? periode : periodeDuMois(mois, periode);
  const baseDivergente = baseDivergenteDesCoutsDeStructure(cibles, periodeCouts, base);
  const cibleCouts = baseDivergente === null ? cibleDeCoutsDeStructure(cibles, periodeCouts, base) : null;
  const deuxBriques = cibleContributive !== null && cibleCouts !== null;

  // Motifs : un objectif existe, mais ne se compare pas dans cette lecture.
  const motifMarge = (cible: CiblePeriode | null, tva: boolean) => (cible !== null && !tva ? LIBELLE_ECART_TVA_INCOMPLETE : null);
  const motifCouts =
    baseDivergente !== null ? libelleObjectifDefiniEn(baseDivergente) : cibleCouts !== null && !tvaCoutsStructure ? LIBELLE_ECART_TVA_INCOMPLETE : null;
  const motifEbitda =
    baseDivergente !== null
      ? `${LIBELLE_EBITDA_INDISPONIBLE} : coûts de structure cibles définis en ${MENTION_DE_LA_BASE[baseDivergente]}`
      : deuxBriques && !tvaEbitda
        ? `${LIBELLE_EBITDA_INDISPONIBLE} : TVA non renseignée sur une partie des montants`
        : null;
  return {
    base,
    margeBrute: marge(cibleBrute, "marge_brute", tvaMargeBrute),
    margeContributive: marge(cibleContributive, "marge_contributive", tvaMargeContributive),
    // EBITDA cible = cible contributive × encaissements de la base − coûts de structure cibles de
    // la même base. Une composante absente, incompatible ou non fiable : pas de cible.
    ebitda: deuxBriques && tvaEbitda ? ecartDEbitda(ebitda, ca, cibleContributive, cibleCouts) : null,
    ebitdaIncomplet: !deuxBriques && baseDivergente === null && (cibleContributive !== null || cibleCouts !== null),
    coutsStructure: cibleCouts === null || !tvaCoutsStructure ? null : ecartDeCouts(montantCoutsStructure, cibleCouts),
    montantCoutsStructure,
    indisponibles: {
      margeBrute: motifMarge(cibleBrute, tvaMargeBrute),
      margeContributive: motifMarge(cibleContributive, tvaMargeContributive),
      ebitda: motifEbitda,
      coutsStructure: motifCouts,
    },
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

// --- Libellés : factuels, jamais un verdict (« Cible 44,0 % · -27 k€ vs cible ») ---

const espaces = (texte: string) => texte.replace(/[\u202f\u00a0]/g, " ");
// « + » devant un écart positif — sauf s'il s'arrondit à zéro : « 0 k€ », jamais « +0 k€ ».
const signe = (valeur: number, texte: string) => (valeur > 0 && !/^0(,0+)?(\s|$)/.test(texte) ? `+${texte}` : texte.replace(/^-(0(,0+)?(\s|$))/, "$1"));
/** Montant en k€, une décimale au plus : « 130 k€ », « 125,5 k€ ». Le format de tous les objectifs. */
export const enK = (montant: number) => espaces(formatKiloEuros(montant, 1));
const formatPoints = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Écart de marge en points : « -3,8 pts », « +2,0 pts ». */
export function libellePoints(fraction: number): string {
  const points = Math.round(fraction * 1000) / 10;
  return `${signe(points, espaces(formatPoints.format(points === 0 ? 0 : points)))} pt${Math.abs(points) >= 2 ? "s" : ""}`;
}

// Jamais « 100 % » pour une couverture incomplète : 99,6 % se lit « 99 % ».
const pourcentageCouvert = (couverture: number) => `${Math.floor(couverture * 100 + 1e-9)} %`;

export interface LibellesCible {
  cible: string;
  ecart: string;
  // Précision sur ce que la cible couvre (part du CA, part de la période), sinon null. Courte :
  // elle se lit en infobulle à côté de la cible, jamais en ligne permanente.
  reserve: string | null;
}

/**
 * Marge : l'écart principal est le montant (« -322 k€ vs cible »). L'écart en points reste dans le
 * modèle (ecartPoints, libellePoints) sans être affiché ici. Sans écart en euros — couverture
 * insuffisante — seule la cible est donnée, et l'infobulle dit sur quelle part du CA elle porte.
 */
export function libellesEcartMarge(ecart: EcartMarge): LibellesCible {
  return {
    cible: `Cible ${espaces(formatPourcentage(ecart.cible))}`,
    ecart: ecart.ecartEuros === null ? "cible incomplète" : `${signe(ecart.ecartEuros, enK(ecart.ecartEuros))} vs cible`,
    reserve: ecart.couverture < COUVERTURE_COMPLETE ? `Cible calculée sur ${pourcentageCouvert(ecart.couverture)} des encaissements` : null,
  };
}

export function libellesEcartCouts(ecart: EcartCouts): LibellesCible {
  return {
    cible: `Cible ${enK(ecart.cible)}`,
    ecart: `${signe(ecart.ecart, enK(ecart.ecart))} vs cible`,
    reserve: ecart.couverture < COUVERTURE_COMPLETE ? `Cible définie sur ${Math.round(ecart.couverture * 100)} % de la période` : null,
  };
}

export const LIBELLE_EBITDA_INCOMPLET = "Objectif EBITDA incomplet";

export function libellesEcartEbitda(ecart: EcartEbitda): LibellesCible {
  const reserves = [
    ...(ecart.couvertureCa < COUVERTURE_COMPLETE ? [`Cible EBITDA calculée sur ${Math.round(ecart.couvertureCa * 100)} % des encaissements`] : []),
    ...(ecart.couverturePeriode < COUVERTURE_COMPLETE ? [`Cible de coûts de structure définie sur ${Math.round(ecart.couverturePeriode * 100)} % de la période`] : []),
  ];
  const montant = signe(ecart.ecart, enK(ecart.ecart));
  return {
    cible: `Cible ${enK(ecart.cible)}`,
    ecart: ecart.statut === "incomplet" ? `${montant} (indicatif)` : `${montant} vs cible`,
    reserve: reserves.length > 0 ? reserves.join(" · ") : null,
  };
}
