import { formatDateCourte } from "./dates";
import { AjustementGestion } from "./pastAdjustments";
import { moisGlissants } from "./pastBfr";
import { DelaisCohorte, delaisDuMois } from "./pastBfrDelais";
import { evolutionBfr, LectureBfr, lectureBfrDuMois, PointBfr, SourcesBfr } from "./pastBfrLecture";
import { MappingCategorie } from "./pastCategoryMapping";
import { dateEnLettres, PlanEcarts, PlanRapport } from "./pastPdfPeriodes";
import { categoriesDeLEtage, Comparaison, comparerPeriodes, donneesPeriode, LigneCategorieEcart } from "./pastVariance";
import {
  calculerDetail,
  FiltresDetail,
  libelleMois,
  METRIQUES_DETAIL,
  MetriqueDetail,
  PartMappee,
  trierTransactions,
  VueDetail,
} from "./pastDetail";
import { MENTION_HT_ESTIME, MENTION_TTC } from "./format";
import type { BaseMontants, IndicateurEconomique, PnlEnBase } from "./pastHtEstime";
import { Pnl } from "./pastPnl";
import { PastTransactionStockee, Periode } from "./pastTransactions";

/**
 * Contenu de l'export PDF du module "Passé" — fonctions pures, sans dessin ni navigateur : ce qui
 * figure sur chaque page est décidé ici, à partir des mêmes calculs que les écrans (calculerPnl,
 * calculerDetail). Le dessin lui-même est dans lib/pastPdfDocument.tsx.
 *
 * Une page par onglet de résultats, dans l'ordre des onglets : Général, Encaissements, Marge brute,
 * Marge contributive, EBITDA, Cash flow, BFR, Analyse d'écarts. Stocks, Objectifs et
 * Correspondance P&L sont des écrans de saisie et de configuration : ils n'ont pas de page.
 * Chaque page porte SA période (lib/pastPdfPeriodes.ts) : celle du rapport pour le P&L, une fin de
 * mois pour le BFR, deux périodes pour l'Analyse d'écarts.
 */

export const MAX_TRANSACTIONS_PDF = 20;

export const DISCLAIMER_PASSE = "Tous les chiffres sont bien des transactions et non des chiffres comptables. Ils sont TTC.";
// Lecture HT estimé (lib/pastHtEstime.ts) : remplace le rappel TTC à l'écran.
export const DISCLAIMER_HT_ESTIME =
  "Les montants HT sont des estimations calculées à partir des taux de TVA renseignés dans Novanta. Ils ne constituent pas des données comptables.";
export const PRECISION_HT_ESTIME = "La trésorerie reste en TTC ; les ajustements de gestion (variation de stock…) sont repris tels que saisis.";
// Pied de page du PDF en lecture HT estimé : une seule ligne, la même idée que l'écran.
export const DISCLAIMER_PDF_HT_ESTIME = `Montants HT estimés à partir des taux de TVA renseignés dans Novanta, non comptables. Trésorerie en ${MENTION_TTC}.`;

/** Mention d'un montant selon la lecture : « TTC » ou « HT estimé ». */
export function mentionDeLaBase(base: BaseMontants): string {
  return base === "ht" ? MENTION_HT_ESTIME : MENTION_TTC;
}

/** Pied de page du PDF selon la lecture exportée. */
export function disclaimerPdf(base: BaseMontants): string {
  return base === "ht" ? DISCLAIMER_PDF_HT_ESTIME : DISCLAIMER_PASSE;
}

const ORDRE_DETAILS: readonly MetriqueDetail[] = ["ca", "marge_brute", "marge_contributive", "ebitda", "cash_flow"];

const SANS_FILTRE: FiltresDetail = { categorie: null, mois: null };

/** Période affichée en tête d'une page : la période ne se devine pas d'une page à l'autre. */
export interface EntetePeriode {
  titre: string; // « Période analysée », « Situation », « Périodes comparées »
  valeur: string; // « Septembre 2026 », « Au 30 septembre 2026 », « Septembre 2026 vs août 2026 »
  detail: string | null; // dates exactes, ou précision (« dernier mois complet disponible »)
}

// BFR : toujours HT, sur factures Pennylane et stocks saisis — jamais une version TTC.
export const DISCLAIMER_PDF_BFR = "BFR exclusivement HT : factures Pennylane (montants HT) et stocks HT de fin de mois saisis dans Novanta.";

export interface PageGeneralPdf {
  type: "general";
  titre: string;
  entete: EntetePeriode;
  pnl: Pnl;
  // Lecture des indicateurs principaux ; la trésorerie reste toujours TTC.
  base: BaseMontants;
  // Lecture HT : indicateurs dont la TVA n'est pas renseignée sur tous les montants — « Incomplet ».
  incomplets: IndicateurEconomique[];
  avertissements: string[];
}

export interface PageDetailPdf {
  type: "detail";
  titre: string;
  entete: EntetePeriode;
  metrique: MetriqueDetail;
  // Filtres locaux appliqués à la page, et leur libellé à afficher ([] = aucun filtre).
  filtres: FiltresDetail;
  libellesFiltres: string[];
  vue: VueDetail;
  // Les MAX_TRANSACTIONS_PDF plus importantes en valeur absolue, parmi nombreTransactions.
  transactions: PartMappee[];
  nombreTransactions: number;
  // Lecture de la page : celle de l'export, sauf le Cash flow, toujours TTC.
  base: BaseMontants;
  // Lecture HT : TVA non renseignée sur une partie des montants de l'indicateur.
  estimationIncomplete: boolean;
}

export interface PageBfrPdf {
  type: "bfr";
  titre: string;
  entete: EntetePeriode;
  // null : aucune fin de mois utilisable (`indisponible` dit pourquoi) — rien n'est fabriqué.
  mois: string | null;
  indisponible: string | null;
  lecture: LectureBfr | null;
  // Cohortes du mois et du mois civil précédent (pour l'évolution), comme les cartouches de l'onglet.
  delais: { client: DelaisCohorte; fournisseur: DelaisCohorte; clientPrecedent: DelaisCohorte; fournisseurPrecedent: DelaisCohorte } | null;
  evolution: PointBfr[];
}

/** Mouvement explicatif : une catégorie (ou un ajustement) et son étage, avec son impact sur l'écart. */
export interface MouvementEcart extends LigneCategorieEcart {
  libelleEtage: string;
}

export interface PageEcartsPdf {
  type: "ecarts";
  titre: string;
  entete: EntetePeriode;
  plan: PlanEcarts;
  // null : comparaison indisponible (`indisponible` dit pourquoi) — jamais remplacée par une autre période.
  comparaison: Comparaison | null;
  indisponible: string | null;
  mouvements: MouvementEcart[];
}

export type PagePdf = PageGeneralPdf | PageDetailPdf | PageBfrPdf | PageEcartsPdf;

export interface SourceExportPdf {
  // P&L et parts dans la lecture exportée (lib/pastHtEstime.ts). TTC si `base` est absente.
  pnl: Pnl | PnlEnBase;
  parts: PartMappee[];
  base?: BaseMontants;
  // Parts TTC, pour le Cash flow : des flux bancaires réels, jamais convertis. Par défaut `parts`.
  partsTtc?: PartMappee[];
  periode: Periode;
  ajustements: AjustementGestion[];
  avertissements: string[];
  // Onglet affiché au moment de l'export et ses filtres locaux. Seul cet onglet a un état de
  // filtre connu de l'application : les autres pages sont exportées sans filtre local.
  ongletOuvert: string;
  filtresOngletOuvert: FiltresDetail;
  // Période affichée en tête des pages ; par défaut, les dates de `periode`.
  entete?: EntetePeriode;
}

/** Libellés du filtre local d'une page : la catégorie, puis le mois. Vide sans filtre. */
export function libellesDesFiltres(vue: VueDetail, filtres: FiltresDetail): string[] {
  const libelles: string[] = [];
  if (filtres.categorie !== null) libelles.push(vue.kpi.categorie ?? "Catégorie sélectionnée");
  if (filtres.mois !== null) libelles.push(libelleMois(filtres.mois));
  return libelles;
}

/**
 * Pages du PDF. Les transactions d'une page de détail sont triées par valeur absolue décroissante
 * sur TOUTES celles qui correspondent à la période et aux filtres de la page, puis limitées : ce
 * sont bien les plus importantes, pas un extrait de ce que l'écran avait déroulé.
 */
export function pagesExportPdf(source: SourceExportPdf): PagePdf[] {
  const base = source.base ?? "ttc";
  const couvertures = "couvertures" in source.pnl ? source.pnl.couvertures : null;
  const incomplets = couvertures ? (Object.keys(couvertures) as IndicateurEconomique[]).filter((cle) => !couvertures[cle].complete) : [];
  const entete = source.entete ?? { titre: "Période analysée", valeur: `${formatDateCourte(source.periode.debut)} — ${formatDateCourte(source.periode.fin)}`, detail: null };
  const pages: PagePdf[] = [{ type: "general", titre: "Général", entete, pnl: source.pnl, base, incomplets, avertissements: source.avertissements }];
  for (const metrique of ORDRE_DETAILS) {
    const filtres = metrique === source.ongletOuvert ? source.filtresOngletOuvert : SANS_FILTRE;
    const tresorerie = metrique === "cash_flow";
    const basePage: BaseMontants = tresorerie ? "ttc" : base;
    const vue = calculerDetail(tresorerie ? (source.partsTtc ?? source.parts) : source.parts, metrique, filtres, source.periode, source.ajustements);
    pages.push({
      type: "detail",
      titre: METRIQUES_DETAIL[metrique].libelle,
      entete,
      metrique,
      filtres,
      libellesFiltres: libellesDesFiltres(vue, filtres),
      vue,
      transactions: trierTransactions(vue.transactions, "montant").slice(0, MAX_TRANSACTIONS_PDF),
      nombreTransactions: vue.transactions.length,
      base: basePage,
      estimationIncomplete: basePage === "ht" && vue.couvertureKpi !== null && !vue.couvertureKpi.complete,
    });
  }
  return pages;
}

const bornes = (p: Periode) => `${formatDateCourte(p.debut)} — ${formatDateCourte(p.fin)}`;

/** En-tête des pages P&L : la période du rapport, « à date » si elle n'est pas terminée. */
export function entetePnl(plan: PlanRapport, aujourdhui: string): EntetePeriode {
  return plan.enCours
    ? { titre: "Période analysée", valeur: `${plan.libelle}, à date`, detail: `${formatDateCourte(plan.periode.debut)} — ${formatDateCourte(aujourdhui)}` }
    : { titre: "Période analysée", valeur: plan.libelle, detail: bornes(plan.periode) };
}

/**
 * Page BFR : la situation de la fin de mois retenue par le plan — mêmes calculs que l'onglet BFR
 * (lib/pastBfrLecture.ts), mêmes délais que ses cartouches, même évolution sur 12 mois.
 */
export function pageBfrPdf(plan: PlanRapport, sources: SourcesBfr, aujourdhui: string): PageBfrPdf {
  if (plan.bfr === null) {
    return {
      type: "bfr",
      titre: "BFR",
      entete: { titre: "Situation", valeur: "Non disponible", detail: null },
      mois: null,
      indisponible: `BFR non disponible : ${plan.libelleBfr}. Le BFR est une photographie de fin de mois, jamais un agrégat de la période.`,
      lecture: null,
      delais: null,
      evolution: [],
    };
  }
  const { mois, date, dernierMoisComplet } = plan.bfr;
  const lecture = lectureBfrDuMois(sources, mois);
  return {
    type: "bfr",
    titre: "BFR",
    entete: { titre: "Situation", valeur: `Au ${dateEnLettres(date)}`, detail: dernierMoisComplet ? "Dernier mois complet disponible" : null },
    mois,
    indisponible: null,
    lecture,
    delais: {
      client: delaisDuMois(sources.factures, "client", mois, aujourdhui),
      fournisseur: delaisDuMois(sources.factures, "fournisseur", mois, aujourdhui),
      clientPrecedent: delaisDuMois(sources.factures, "client", moisGlissants(mois, 2)[0], aujourdhui),
      fournisseurPrecedent: delaisDuMois(sources.factures, "fournisseur", moisGlissants(mois, 2)[0], aujourdhui),
    },
    evolution: evolutionBfr(sources, mois, aujourdhui),
  };
}

export const MAX_MOUVEMENTS_PDF = 10;

export interface SourceEcartsPdf {
  plan: PlanEcarts;
  // Transactions chargées sur les périodes A et B du plan, jamais sur les sélecteurs de l'écran.
  transactionsA: PastTransactionStockee[];
  transactionsB: PastTransactionStockee[];
  axeId: string | null;
  mappings: ReadonlyMap<string, MappingCategorie>;
  // Tous les ajustements de gestion : chaque période en prend sa part.
  ajustements: AjustementGestion[];
  financementCompris: boolean;
}

/**
 * Page Analyse d'écarts : le calcul de l'écran (lib/pastVariance.ts) sur les périodes du plan.
 * Durées égales par construction (mois contre mois, exercice contre exercice, portion contre même
 * portion) : aucune normalisation. Une période sans aucune transaction rend la comparaison
 * indisponible — elle n'est jamais remplacée par une autre.
 */
export function pageEcartsPdf(source: SourceEcartsPdf): PageEcartsPdf {
  const { plan } = source;
  const entete: EntetePeriode = { titre: "Périodes comparées", valeur: plan.libelle, detail: `${bornes(plan.b)} vs ${bornes(plan.a)}` };
  const vide = source.transactionsA.length === 0 ? plan.a : source.transactionsB.length === 0 ? plan.b : null;
  if (vide !== null) {
    return {
      type: "ecarts",
      titre: "Analyse d'écarts",
      entete,
      plan,
      comparaison: null,
      indisponible: `Comparaison indisponible : aucune transaction synchronisée du ${bornes(vide).replace(" — ", " au ")}.`,
      mouvements: [],
    };
  }
  const a = donneesPeriode(source.transactionsA, source.axeId, source.mappings, source.ajustements, plan.a);
  const b = donneesPeriode(source.transactionsB, source.axeId, source.mappings, source.ajustements, plan.b);
  const comparaison = comparerPeriodes(a, b, { financementCompris: source.financementCompris });
  const mouvements = comparaison.etages
    .flatMap((e) => categoriesDeLEtage(a, b, e.etage).map((ligne) => ({ ...ligne, libelleEtage: e.libelle })))
    .filter((m) => m.variation.sens !== "stable")
    .sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution) || x.nom.localeCompare(y.nom, "fr"))
    .slice(0, MAX_MOUVEMENTS_PDF);
  return { type: "ecarts", titre: "Analyse d'écarts", entete, plan, comparaison, indisponible: null, mouvements };
}

/** "Novanta_Reporting_Maju_2025-10-01_2026-09-30.pdf" — nom d'organisation réduit à des caractères sûrs. */
export function nomFichierPdf(organisation: string, periode: Periode): string {
  const nom = organisation
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `Novanta_Reporting_${nom || "Organisation"}_${periode.debut}_${periode.fin}.pdf`;
}

/**
 * Texte dessinable avec la police embarquée : les espaces insécables (fines ou non) que produit le
 * formatage français n'y existent pas toutes, et une flèche non plus.
 */
export function textePdf(texte: string): string {
  return texte.replace(/[   ]/g, " ").replace(/→/g, "—").replace(/\s*\n\s*/g, " ");
}
