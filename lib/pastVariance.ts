import { AjustementGestion, ajustementsDeLaPeriode, regrouperAjustements, sommeAjustements } from "./pastAdjustments";
import { ETAGES_PNL, EtagePnl, MappingCategorie } from "./pastCategoryMapping";
import { PartMappee, partsMappees } from "./pastDetail";
import { calculerCashFlow } from "./pastPnl";
import { PastTransactionStockee, Periode } from "./pastTransactions";
import { aliasFlowKey, buildCanonicalFlowIdentity, FlowIdentity, groupComparableTransactions, MatchMethod, resoudreAlias } from "./flowMatching";

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

/** Les cinq contributions de la waterfall, dans l'ordre du P&L, sous les libellés communs du module. */
export const ETAGES_ECARTS: readonly { etage: EtagePnl; libelle: string }[] = ETAGES_PNL.map((e) => ({ etage: e.cle, libelle: e.libelle }));

const ETAGES_EBITDA: readonly EtagePnl[] = ["revenue", "gross_margin", "contribution_margin", "ebitda"];

/** Tout ce qui entre dans le Cash flow d'une période : parts mappées et ajustements de gestion. */
export interface DonneesPeriode {
  periode: Periode;
  parts: PartMappee[];
  ajustements: AjustementGestion[];
  // Mise à l'échelle des AGRÉGATS de la période quand elle est comparée à une période plus courte
  // (lib/fiscalPeriods.ts, normaliserDurees) ; 1 = montants réels. Il s'applique au Cash flow, aux
  // étages, aux catégories et aux groupes de libellés — une moyenne de référence, pas un
  // historique. Les parts elles-mêmes gardent toujours leur montant réel : une transaction n'est
  // jamais normalisée.
  coefficient: number;
}

export function donneesPeriode(
  transactions: PastTransactionStockee[],
  axeId: string | null,
  mappings: ReadonlyMap<string, MappingCategorie>,
  tousLesAjustements: AjustementGestion[],
  periode: Periode,
  coefficient = 1
): DonneesPeriode {
  return {
    periode,
    coefficient,
    parts: partsMappees(transactions, axeId, mappings),
    ajustements: ajustementsDeLaPeriode(tousLesAjustements, periode),
  };
}

function totalEtage(donnees: DonneesPeriode, etages: readonly EtagePnl[]): number {
  const parts = donnees.parts.reduce((total, p) => (etages.includes(p.etage) ? total + p.montant : total), 0);
  return (parts + sommeAjustements(donnees.ajustements, etages)) * donnees.coefficient;
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
      if (part.etage === etage) {
        ligne(part.sourceCategoryId, part.sourceCategoryName, false)[cote] += part.montant * donnees.coefficient;
      }
    }
    for (const ajustement of regrouperAjustements(donnees.ajustements.filter((x) => x.etage === etage))) {
      ligne(`ajustement:${ajustement.cle}`, ajustement.label, true)[cote] += ajustement.montant * donnees.coefficient;
    }
  }
  return parContributionDecroissante([...lignes.values()].map((l) => ({ ...l, contribution: l.montantB - l.montantA })));
}

// Les périodes A et B se choisissent dans n'importe quel ordre : un flux présent d'un seul côté
// n'est ni « nouveau » ni « absent », il a simplement un montant d'un côté et rien de l'autre.
export type StatutEcart =
  | "change"
  // Même montant à l'euro près des deux côtés : masqué par défaut.
  | "stable";

// Seuil volontairement absolu et minuscule : un seuil relatif masquerait des écarts matériels sur
// les gros montants (1 % d'un million = 10 000 €). Mieux vaut montrer une ligne de trop que cacher
// un contributeur significatif.
const TOLERANCE_STABLE = 1;

/**
 * Flux comparable : toutes les transactions d'un même flux (même mandat de prélèvement, ou même
 * libellé normalisé) dans une catégorie, agrégées sur chacune des deux périodes. C'est le niveau
 * principal de l'analyse ; les transactions individuelles n'apparaissent qu'au clic.
 */
export interface GroupeLibelle {
  cle: string;
  // Nom affiché : l'alias de l'organisation s'il existe, sinon le titre détecté.
  libelle: string;
  // Titre lisible tiré de la partie stable du flux (« Facebook Ads »), pas un libellé bancaire.
  libelleDetecte: string;
  alias: string | null;
  // Identités propres des libellés du groupe (lib/flowMatching.ts::aliasFlowKey), chacune avec un
  // libellé bancaire d'exemple : ce sont les clés sous lesquelles un alias s'enregistre. Vide pour
  // un flux sans identité, qui ne peut donc pas être renommé.
  clesAlias: { cle: string; exemple: string }[];
  // Groupe manuel de l'organisation auquel cette ligne correspond (lib/flowGroups.ts), sinon null.
  groupeManuel: { id: string; nom: string } | null;
  nombreLibelles: number;
  sourceCategoryId: string;
  categorie: string;
  montantA: number;
  montantB: number;
  contribution: number;
  nombreA: number;
  nombreB: number;
  statut: StatutEcart;
  // Pourquoi ces transactions sont réunies (pour comprendre un regroupement, pas pour l'analyse).
  matchMethod: MatchMethod;
  confidenceScore: number;
}

export type PartComparee = PartMappee & { cote: "A" | "B" };

/**
 * Identité de flux de chaque libellé, CATÉGORIE PAR CATÉGORIE : deux libellés identiques dans deux
 * catégories différentes ne sont jamais rapprochés, et les voisinages (lib/flowMatching.ts) ne se
 * calculent qu'entre libellés d'une même catégorie, sur les deux périodes réunies.
 */
function identitesDesFlux(parts: PartMappee[]): Map<string, Map<string, FlowIdentity>> {
  const libellesParCategorie = new Map<string, Set<string>>();
  for (const part of parts) {
    if (!libellesParCategorie.has(part.sourceCategoryId)) libellesParCategorie.set(part.sourceCategoryId, new Set());
    libellesParCategorie.get(part.sourceCategoryId)!.add(part.label);
  }
  return new Map([...libellesParCategorie].map(([categorie, libelles]) => [categorie, groupComparableTransactions(libelles)]));
}

/** Regroupements manuels de l'organisation : identité propre d'un flux -> groupe (lib/flowGroups.ts). */
export type GroupesManuels = ReadonlyMap<string, { id: string; nom: string }>;

const AUCUN_GROUPE_MANUEL: GroupesManuels = new Map();
const PREFIXE_MANUEL = "manuel:";

// Le regroupement manuel a priorité sur le rapprochement automatique, et réunit ses flux quelle
// que soit leur catégorie : c'est une décision explicite de l'utilisateur. Sinon, identité du
// moteur à l'intérieur de la catégorie ; un flux sans identité (libellé vide après normalisation)
// reste seul.
function cleGroupe(part: PartMappee, identites: Map<string, Map<string, FlowIdentity>>, manuels: GroupesManuels): string {
  if (manuels.size > 0) {
    const propre = aliasFlowKey(part.label);
    const manuel = propre === null ? undefined : manuels.get(propre);
    if (manuel) return `${PREFIXE_MANUEL}${manuel.id}`;
  }
  const identite = identites.get(part.sourceCategoryId)?.get(part.label)?.canonicalFlowIdentity ?? null;
  return `${part.sourceCategoryId}|${identite ?? `seule:${part.transactionId}`}`;
}

function partsComparees(a: DonneesPeriode, b: DonneesPeriode, etage: EtagePnl, categorie: string | null): PartComparee[] {
  const garder = (p: PartMappee) => p.etage === etage && (categorie === null || p.sourceCategoryId === categorie);
  return [
    ...a.parts.filter(garder).map((p) => ({ ...p, cote: "A" as const })),
    ...b.parts.filter(garder).map((p) => ({ ...p, cote: "B" as const })),
  ];
}

/**
 * Ce qui change entre A et B dans un étage (ou une de ses catégories), par flux comparable.
 * Pipeline : clé de flux de chaque transaction -> regroupement -> agrégation par période -> écart
 * -> tri par |écart agrégé| décroissant. Les lignes de l'écran sont construites à partir de ce
 * résultat, jamais directement à partir des transactions.
 */
export function groupesDeLibelles(
  a: DonneesPeriode,
  b: DonneesPeriode,
  etage: EtagePnl,
  categorie: string | null = null,
  // Alias de l'organisation (identité propre -> nom). Ils ne changent QUE le nom affiché : ni les
  // groupes, ni leurs montants, ni leur ordre.
  alias: ReadonlyMap<string, string> = new Map(),
  // Regroupements manuels : ils réunissent des lignes que le moteur laisse séparées, sans toucher
  // aux autres ni au moteur.
  manuels: GroupesManuels = AUCUN_GROUPE_MANUEL
): GroupeLibelle[] {
  // Les identités se calculent sur tout l'étage, AVANT le filtre catégorie : la clé d'un flux ne
  // dépend ainsi pas du filtre affiché (elle reste valable d'un clic à l'autre).
  const identites = identitesDesFlux(partsComparees(a, b, etage, null));
  const groupes = new Map<string, { parts: PartComparee[] }>();
  for (const part of partsComparees(a, b, etage, categorie)) {
    const cle = cleGroupe(part, identites, manuels);
    if (!groupes.has(cle)) groupes.set(cle, { parts: [] });
    groupes.get(cle)!.parts.push(part);
  }
  const resultat = [...groupes.entries()].map(([cle, { parts }]) => {
    const cote = (c: "A" | "B") => parts.filter((p) => p.cote === c);
    const montantA = cote("A").reduce((s, p) => s + p.montant, 0) * a.coefficient;
    const montantB = cote("B").reduce((s, p) => s + p.montant, 0) * b.coefficient;
    const contribution = montantB - montantA;
    const representative = [...parts].sort((x, y) => Math.abs(y.montant) - Math.abs(x.montant) || x.label.localeCompare(y.label))[0];
    const identite = identites.get(representative.sourceCategoryId)!.get(representative.label)!;
    const titre = identite.title;
    // La moins sûre des méthodes qui ont réuni ces transactions : c'est elle qu'il faut regarder.
    const pire = parts
      .map((p) => identites.get(p.sourceCategoryId)!.get(p.label)!)
      .reduce((plusFaible, x) => (x.confidenceScore < plusFaible.confidenceScore ? x : plusFaible), identite);
    const exemples = new Map<string, string>();
    for (const libelle of [...new Set(parts.map((p) => p.label))].sort()) {
      const propre = aliasFlowKey(libelle);
      if (propre !== null && !exemples.has(propre)) exemples.set(propre, libelle);
    }
    // Dans un groupe manuel, c'est le nom du groupe qui s'affiche ; les alias individuels de ses
    // flux sont conservés mais ne jouent plus tant qu'ils en font partie.
    const groupeManuel = cle.startsWith(PREFIXE_MANUEL) ? (manuels.get([...exemples.keys()][0]) ?? null) : null;
    const nomAlias = groupeManuel ? null : resoudreAlias([...exemples.keys()], identite.canonicalFlowIdentity, alias);
    const categoriesDuGroupe = new Set(parts.map((p) => p.sourceCategoryId));
    return {
      cle,
      // Le départage à contribution égale se fait sur le titre détecté : renommer ne déplace rien.
      nom: titre,
      libelle: groupeManuel?.nom ?? nomAlias ?? titre,
      libelleDetecte: titre,
      alias: nomAlias,
      clesAlias: [...exemples].map(([cleAlias, exemple]) => ({ cle: cleAlias, exemple })),
      groupeManuel,
      nombreLibelles: new Set(parts.map((p) => p.label)).size,
      sourceCategoryId: representative.sourceCategoryId,
      categorie: categoriesDuGroupe.size > 1 ? "Plusieurs catégories" : representative.sourceCategoryName,
      montantA,
      montantB,
      contribution,
      nombreA: cote("A").length,
      nombreB: cote("B").length,
      statut: (Math.abs(contribution) <= TOLERANCE_STABLE ? "stable" : "change") as StatutEcart,
      matchMethod: pire.matchMethod,
      confidenceScore: groupeManuel ? 1 : pire.confidenceScore,
    };
  });
  return parContributionDecroissante(resultat).map(({ nom: _nom, ...groupe }) => groupe);
}

/**
 * Transactions d'origine d'un groupe, des deux périodes, chacune marquée A ou B — toujours à leur
 * montant réel, même quand la comparaison est normalisée.
 */
export function transactionsDuGroupe(
  a: DonneesPeriode,
  b: DonneesPeriode,
  etage: EtagePnl,
  cle: string,
  manuels: GroupesManuels = AUCUN_GROUPE_MANUEL
): PartComparee[] {
  const parts = partsComparees(a, b, etage, null);
  const identites = identitesDesFlux(parts);
  return parts.filter((part) => cleGroupe(part, identites, manuels) === cle);
}

/** Flux qu'on peut proposer à la fusion : ceux des deux périodes comparées, tous étages confondus. */
export interface FluxConnu {
  cle: string; // identifiant stable de la proposition (groupe manuel, ou identités propres réunies)
  libelle: string;
  categorie: string;
  membres: { cle: string; nomDetecte: string; exemple: string }[];
  groupeManuel: { id: string; nom: string } | null;
}

/**
 * Tous les flux identifiables des deux périodes, une entrée par flux : un même flux présent dans
 * plusieurs étages ou catégories n'est proposé qu'une fois, un groupe manuel aussi. Triés par nom.
 */
export function fluxConnus(
  a: DonneesPeriode,
  b: DonneesPeriode,
  alias: ReadonlyMap<string, string> = new Map(),
  manuels: GroupesManuels = AUCUN_GROUPE_MANUEL
): FluxConnu[] {
  const connus = new Map<string, FluxConnu>();
  for (const { etage } of ETAGES_ECARTS) {
    for (const groupe of groupesDeLibelles(a, b, etage, null, alias, manuels)) {
      if (groupe.clesAlias.length === 0) continue;
      const cle = groupe.groupeManuel ? `${PREFIXE_MANUEL}${groupe.groupeManuel.id}` : groupe.clesAlias.map((c) => c.cle).sort().join("|");
      const membres = groupe.clesAlias.map((c) => ({ cle: c.cle, nomDetecte: buildCanonicalFlowIdentity(c.exemple).title, exemple: c.exemple }));
      const existant = connus.get(cle);
      if (!existant) {
        connus.set(cle, { cle, libelle: groupe.libelle, categorie: groupe.categorie, membres, groupeManuel: groupe.groupeManuel });
      } else {
        for (const membre of membres) if (!existant.membres.some((m) => m.cle === membre.cle)) existant.membres.push(membre);
      }
    }
  }
  return [...connus.values()].sort((x, y) => x.libelle.localeCompare(y.libelle, "fr") || x.cle.localeCompare(y.cle));
}
