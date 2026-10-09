import { AjustementGestion } from "./pastAdjustments";
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
import { Pnl } from "./pastPnl";
import { Periode } from "./pastTransactions";

/**
 * Contenu de l'export PDF du module "Passé" — fonctions pures, sans dessin ni navigateur : ce qui
 * figure sur chaque page est décidé ici, à partir des mêmes calculs que les écrans (calculerPnl,
 * calculerDetail). Le dessin lui-même est dans lib/pastPdfDocument.tsx.
 *
 * Une page par onglet de résultats, dans l'ordre des onglets. Stocks et Correspondance P&L sont
 * des écrans de saisie et de configuration : ils n'ont pas de page.
 */

export const MAX_TRANSACTIONS_PDF = 15;

export const DISCLAIMER_PASSE = "Tous les chiffres sont bien des transactions et non des chiffres comptables. Ils sont TTC.";

const ORDRE_DETAILS: readonly MetriqueDetail[] = ["ca", "marge_brute", "marge_contributive", "ebitda", "cash_flow"];

const SANS_FILTRE: FiltresDetail = { categorie: null, mois: null };

export interface PageGeneralPdf {
  type: "general";
  titre: string;
  pnl: Pnl;
  avertissements: string[];
}

export interface PageDetailPdf {
  type: "detail";
  titre: string;
  metrique: MetriqueDetail;
  // Filtres locaux appliqués à la page, et leur libellé à afficher ([] = aucun filtre).
  filtres: FiltresDetail;
  libellesFiltres: string[];
  vue: VueDetail;
  // Les MAX_TRANSACTIONS_PDF plus importantes en valeur absolue, parmi nombreTransactions.
  transactions: PartMappee[];
  nombreTransactions: number;
}

export type PagePdf = PageGeneralPdf | PageDetailPdf;

export interface SourceExportPdf {
  pnl: Pnl;
  parts: PartMappee[];
  periode: Periode;
  ajustements: AjustementGestion[];
  avertissements: string[];
  // Onglet affiché au moment de l'export et ses filtres locaux. Seul cet onglet a un état de
  // filtre connu de l'application : les autres pages sont exportées sans filtre local.
  ongletOuvert: string;
  filtresOngletOuvert: FiltresDetail;
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
  const pages: PagePdf[] = [{ type: "general", titre: "Général", pnl: source.pnl, avertissements: source.avertissements }];
  for (const metrique of ORDRE_DETAILS) {
    const filtres = metrique === source.ongletOuvert ? source.filtresOngletOuvert : SANS_FILTRE;
    const vue = calculerDetail(source.parts, metrique, filtres, source.periode, source.ajustements);
    pages.push({
      type: "detail",
      titre: METRIQUES_DETAIL[metrique].libelle,
      metrique,
      filtres,
      libellesFiltres: libellesDesFiltres(vue, filtres),
      vue,
      transactions: trierTransactions(vue.transactions, "montant").slice(0, MAX_TRANSACTIONS_PDF),
      nombreTransactions: vue.transactions.length,
    });
  }
  return pages;
}

/** "Novanta_Passe_Maju_2025-10-01_2026-09-30.pdf" — nom d'organisation réduit à des caractères sûrs. */
export function nomFichierPdf(organisation: string, periode: Periode): string {
  const nom = organisation
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `Novanta_Passe_${nom || "Organisation"}_${periode.debut}_${periode.fin}.pdf`;
}

/**
 * Texte dessinable avec la police embarquée : les espaces insécables (fines ou non) que produit le
 * formatage français n'y existent pas toutes, et une flèche non plus.
 */
export function textePdf(texte: string): string {
  return texte.replace(/[   ]/g, " ").replace(/→/g, "—").replace(/\s*\n\s*/g, " ");
}
