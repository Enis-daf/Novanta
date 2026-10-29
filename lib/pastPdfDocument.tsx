import type { jsPDF } from "jspdf";
import { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import PasseBfrEvolutionChart, { COULEUR_BFR, COULEUR_DELAIS, TIRETS_FOURNISSEURS } from "@/components/PasseBfrEvolutionChart";
import PasseCategoriesChart from "@/components/PasseCategoriesChart";
import PasseEvolutionChart from "@/components/PasseEvolutionChart";
import PasseStructureChart from "@/components/PasseStructureChart";
import PasseWaterfallChart from "@/components/PasseWaterfallChart";
import { formatDateCourte } from "./dates";
import { NEUTRES, teintesDesParts } from "./dataviz";
import { formatKiloEuros, formatMontant, formatMontantComptable, formatPourcentage, MENTION_TTC } from "./format";
import { LigneAjustement } from "./pastAdjustments";
import { libelleEtagePnl, LIBELLE_ENCAISSEMENTS } from "./pastCategoryMapping";
import { METRIQUES_DETAIL } from "./pastDetail";
import { IndicateurEconomique, LIBELLE_VOIR_TTC } from "./pastHtEstime";
import { LIBELLES_STATUT_BFR, moisGlissants } from "./pastBfr";
import { comparerAvecPrecedente, DelaisCohorte, libelleEcartEcheance, libelleTrancheDansPhrase, libelleVariationJours, SEUIL_REPRESENTATIF } from "./pastBfrDelais";
import {
  DISCLAIMER_PDF_BFR,
  disclaimerPdf,
  EntetePeriode,
  mentionDeLaBase,
  PageBfrPdf,
  PageDetailPdf,
  PageEcartsPdf,
  PageGeneralPdf,
  PagePdf,
  textePdf,
} from "./pastPdfModel";
import { ETAGES_COUTS, ETAGES_REVENUS, Structure, structureParCategorie, LIBELLE_CASH_FLOW_OPERATIONNEL, LIBELLE_VARIATION_TRESORERIE } from "./pastPnl";
import { libelleMois } from "./pastDetail";
import { libelleVariation } from "./pastVariance";

/**
 * Dessin du PDF du module "Passé" (A4 paysage, une page par onglet de reporting). Chaque page est composée à
 * des coordonnées fixes : rien ne s'écoule d'une page à l'autre, donc rien ne peut être coupé.
 * Les graphiques sont ceux de l'écran — les mêmes composants, rendus hors écran puis convertis en
 * tracés vectoriels — et le texte est écrit dans la police du produit.
 *
 * Module chargé à la demande (voir PasseTransactions) : jsPDF n'alourdit pas le module Passé tant
 * qu'on n'exporte pas.
 */

const PAGE = { largeur: 841.89, hauteur: 595.28, marge: 34 };
const HAUT_CONTENU = 102;
const BAS_CONTENU = PAGE.hauteur - 54;
const DROITE = PAGE.largeur - PAGE.marge;
const ROSE = "#F02894";
const POLICE = "Lexend";

interface Zone {
  x: number;
  y: number;
  l: number;
  h: number;
}

interface Style {
  taille: number;
  gras?: boolean;
  couleur?: string;
  // Aligné à droite sur x.
  aDroite?: boolean;
  // Capitales espacées, comme les titres de blocs du produit.
  capitales?: boolean;
  // Coupé par « … » au-delà de cette largeur.
  largeurMax?: number;
}

const ESPACEMENT_CAPITALES = 0.9;

function largeurTexte(doc: jsPDF, texte: string, espacement: number): number {
  return doc.getTextWidth(texte) + espacement * Math.max(0, texte.length - 1);
}

/** Écrit une ligne de texte ; renvoie sa largeur. */
function ecrire(doc: jsPDF, texte: string, x: number, y: number, style: Style): number {
  doc.setFont(POLICE, style.gras ? "bold" : "normal");
  doc.setFontSize(style.taille);
  doc.setTextColor(style.couleur ?? NEUTRES.encre);
  const espacement = style.capitales ? ESPACEMENT_CAPITALES : 0;
  let ligne = textePdf(style.capitales ? texte.toUpperCase() : texte);
  if (style.largeurMax !== undefined && largeurTexte(doc, ligne, espacement) > style.largeurMax) {
    while (ligne.length > 1 && largeurTexte(doc, `${ligne}…`, espacement) > style.largeurMax) ligne = ligne.slice(0, -1);
    ligne = `${ligne.trimEnd()}…`;
  }
  const largeur = largeurTexte(doc, ligne, espacement);
  doc.text(ligne, style.aDroite ? x - largeur : x, y, { charSpace: espacement });
  return largeur;
}

/** « TTC » ou « HT estimé » en suffixe secondaire, juste après un texte déjà écrit qui se termine en `x`. */
function ecrireMentionTTC(doc: jsPDF, x: number, y: number, taille: number, mention: string = MENTION_TTC) {
  ecrire(doc, mention, x + taille * 0.45, y, { taille, couleur: NEUTRES.secondaire });
}

function trait(doc: jsPDF, x1: number, y: number, x2: number, couleur: string = NEUTRES.bordure, epaisseur = 0.6) {
  doc.setDrawColor(couleur);
  doc.setLineWidth(epaisseur);
  doc.line(x1, y, x2, y);
}

/** Texte sur plusieurs lignes dans une largeur donnée ; renvoie l'ordonnée sous la dernière ligne. */
function paragraphe(doc: jsPDF, texte: string, x: number, y: number, largeur: number, style: Omit<Style, "aDroite" | "largeurMax" | "capitales">): number {
  doc.setFont(POLICE, style.gras ? "bold" : "normal");
  doc.setFontSize(style.taille);
  const lignes = doc.splitTextToSize(textePdf(texte), largeur) as string[];
  const interligne = style.taille * 1.35;
  lignes.forEach((ligne, i) => ecrire(doc, ligne, x, y + i * interligne, style));
  return y + lignes.length * interligne;
}

function titreBloc(doc: jsPDF, texte: string, x: number, y: number, largeurMax?: number): number {
  return ecrire(doc, texte, x, y, { taille: 7.5, gras: true, capitales: true, largeurMax });
}

// --- Graphiques : les composants de l'écran, rendus hors écran ---

const attendre = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rend un composant graphique hors écran, à la largeur voulue, et renvoie une copie de son SVG
 * prête pour le PDF. null si le composant n'a tracé aucun graphique (état vide).
 */
async function capturerSvg(element: ReactElement, largeur: number): Promise<SVGSVGElement | null> {
  const hote = document.createElement("div");
  hote.setAttribute("aria-hidden", "true");
  hote.style.cssText = `position:fixed;left:-20000px;top:0;width:${largeur}px;pointer-events:none;`;
  document.body.appendChild(hote);
  const racine = createRoot(hote);
  try {
    racine.render(element);
    // Le graphique se trace une fois son conteneur mesuré : on attend le SVG plutôt qu'un délai fixe.
    let svg: SVGSVGElement | null = null;
    for (let essai = 0; essai < 40 && !svg; essai++) {
      await attendre(50);
      svg = hote.querySelector<SVGSVGElement>("svg.recharts-surface");
      if (!svg && essai >= 4 && hote.querySelector(".passe-structure__vide")) return null;
    }
    if (!svg) return null;
    await attendre(50);
    const copie = svg.cloneNode(true) as SVGSVGElement;
    copie.removeAttribute("style");
    copie.removeAttribute("class");
    copie.setAttribute("font-family", POLICE);
    copie.querySelectorAll("title, desc, .recharts-tooltip-cursor").forEach((noeud) => noeud.remove());
    const textes = document.createTreeWalker(copie, NodeFilter.SHOW_TEXT);
    while (textes.nextNode()) textes.currentNode.nodeValue = textePdf(textes.currentNode.nodeValue ?? "");
    return copie;
  } finally {
    racine.unmount();
    hote.remove();
  }
}

/** Place un SVG dans une zone, à la plus grande taille qui y tient ; renvoie le rectangle occupé. */
async function dessinerSvg(doc: jsPDF, svg: SVGSVGElement, zone: Zone, centrer = false): Promise<Zone> {
  const largeurSvg = Number.parseFloat(svg.getAttribute("width") ?? "") || zone.l;
  const hauteurSvg = Number.parseFloat(svg.getAttribute("height") ?? "") || zone.h;
  const echelle = Math.min(zone.l / largeurSvg, zone.h / hauteurSvg);
  const occupe = { x: zone.x + (centrer ? (zone.l - largeurSvg * echelle) / 2 : 0), y: zone.y, l: largeurSvg * echelle, h: hauteurSvg * echelle };
  await doc.svg(svg, { x: occupe.x, y: occupe.y, width: occupe.l, height: occupe.h });
  return occupe;
}

const rien = () => {};

// --- Cadre commun à toutes les pages ---

function cadre(doc: jsPDF, organisation: string, titre: string, entete: EntetePeriode, filtres: string[], numero: number, total: number, mention: string) {
  doc.setFillColor(NEUTRES.fond);
  doc.rect(0, 0, PAGE.largeur, PAGE.hauteur, "F");

  ecrire(doc, organisation, PAGE.marge, 44, { taille: 7.5, gras: true, capitales: true, couleur: NEUTRES.secondaire, largeurMax: 380 });
  ecrire(doc, titre, PAGE.marge, 70, { taille: 23, gras: true });
  // Le rose reste un accent : un seul filet par page.
  doc.setFillColor(ROSE);
  doc.rect(PAGE.marge, 78, 30, 2.4, "F");

  // Chaque page dit SA période : celle du rapport, une fin de mois (BFR) ou deux périodes (écarts).
  ecrire(doc, entete.titre, DROITE, 44, { taille: 7.5, gras: true, capitales: true, couleur: NEUTRES.secondaire, aDroite: true });
  ecrire(doc, entete.valeur, DROITE, 59, { taille: 11.5, gras: true, aDroite: true, largeurMax: 420 });
  if (entete.detail) ecrire(doc, entete.detail, DROITE, 72, { taille: 7.5, couleur: NEUTRES.secondaire, aDroite: true, largeurMax: 420 });
  else if (filtres.length > 0) {
    const largeur = ecrire(doc, filtres.join(" · "), DROITE, 76, { taille: 9, gras: true, aDroite: true, largeurMax: 330 });
    ecrire(doc, "Filtre", DROITE - largeur - 8, 76, { taille: 7.5, gras: true, capitales: true, couleur: ROSE, aDroite: true });
  }
  trait(doc, PAGE.marge, 88, DROITE);

  trait(doc, PAGE.marge, PAGE.hauteur - 42, DROITE);
  ecrire(doc, mention, PAGE.marge, PAGE.hauteur - 28, { taille: 7.5, couleur: NEUTRES.secondaire, largeurMax: DROITE - PAGE.marge - 110 });
  ecrire(doc, `Novanta · Passé · ${numero} / ${total}`, DROITE, PAGE.hauteur - 28, { taille: 7.5, couleur: NEUTRES.secondaire, aDroite: true });
}

// --- Bloc « structure » : camembert, total au centre, légende ---

async function blocStructure(
  doc: jsPDF,
  zone: Zone,
  titre: string,
  structure: Structure,
  messageVide: string,
  teintes: ReadonlyMap<string, string>,
  selection: string | null,
  cote: number
) {
  titreBloc(doc, titre, zone.x, zone.y + 7, zone.l);
  const haut = zone.y + 18;
  if (structure.parts.length === 0) {
    ecrire(doc, messageVide, zone.x, haut + 12, { taille: 8.5, couleur: NEUTRES.secondaire, largeurMax: zone.l });
    return;
  }
  const svg = await capturerSvg(
    <PasseStructureChart titre={titre} structure={structure} messageVide={messageVide} selection={selection} teintes={teintes} />,
    420
  );
  if (svg) {
    const anneau = await dessinerSvg(doc, svg, { x: zone.x, y: haut, l: cote, h: cote });
    const total = textePdf(formatKiloEuros(structure.total));
    doc.setFont(POLICE, "bold");
    doc.setFontSize(9);
    ecrire(doc, total, anneau.x + anneau.l / 2 + doc.getTextWidth(total) / 2, anneau.y + anneau.h / 2 + 3, { taille: 9, gras: true, aDroite: true });
  }

  const couleurs = teintesDesParts(structure.parts, teintes);
  const xLegende = zone.x + cote + 16;
  const droite = zone.x + zone.l;
  const pas = Math.min(15, (cote - 6) / structure.parts.length);
  let y = haut + Math.max(10, (cote - pas * structure.parts.length) / 2 + 8);
  structure.parts.forEach((part, index) => {
    const attenuee = selection !== null && part.cle !== selection;
    const encre = attenuee ? NEUTRES.autres : NEUTRES.encre;
    doc.setFillColor(couleurs[index]);
    doc.setGState(doc.GState({ opacity: attenuee ? 0.25 : 1 }));
    doc.roundedRect(xLegende, y - 6, 6.5, 6.5, 1.5, 1.5, "F");
    doc.setGState(doc.GState({ opacity: 1 }));
    ecrire(doc, part.nom, xLegende + 12, y, { taille: 8, couleur: encre, largeurMax: droite - xLegende - 12 - 104 });
    ecrire(doc, formatKiloEuros(part.montant), droite - 44, y, { taille: 8, gras: true, couleur: encre, aDroite: true });
    ecrire(doc, formatPourcentage(part.part), droite, y, { taille: 8, couleur: attenuee ? NEUTRES.autres : NEUTRES.secondaire, aDroite: true });
    y += pas;
  });

  if (structure.nombreNonRepresentees > 0) {
    const note =
      structure.nombreNonRepresentees > 1
        ? `${structure.nombreNonRepresentees} catégories au montant nul ou de signe inhabituel ne sont pas représentées ; elles restent comptées dans les montants.`
        : "1 catégorie au montant nul ou de signe inhabituel n'est pas représentée ; elle reste comptée dans les montants.";
    ecrire(doc, note, zone.x, haut + cote + 11, { taille: 6.5, couleur: NEUTRES.secondaire, largeurMax: zone.l });
  }
}

// --- Page Général ---

type LignePnl =
  // `tresorerie` : flux bancaires réels, toujours TTC. `indicateur` : indicateur économique, lu dans
  // la base de l'export (« Incomplet » si sa TVA n'est pas renseignée partout).
  // `vide` : cellule de montant laissée vide ; `texte` : texte secondaire à la place du montant
  // (lecture HT, au-delà du Cash flow opérationnel).
  | { type: "ligne"; libelle: string; montant: number; ratio?: number | null; niveau?: "titre" | "solde"; tresorerie?: boolean; indicateur?: IndicateurEconomique; vide?: boolean; texte?: string }
  | { type: "note"; texte: string }
  | { type: "bloc"; cash?: boolean };

function lignesPnl(page: PageGeneralPdf): LignePnl[] {
  const { pnl } = page;
  const ht = page.base === "ht";
  const ajustements = (lignes: LigneAjustement[]): LignePnl[] =>
    lignes.flatMap((ligne) => [
      { type: "ligne", libelle: ligne.label, montant: ligne.montant } as LignePnl,
      ...ligne.notes.map((texte) => ({ type: "note", texte }) as LignePnl),
    ]);
  return [
    { type: "ligne", libelle: LIBELLE_ENCAISSEMENTS, montant: pnl.ca, niveau: "titre", indicateur: "ca" },
    ...ajustements(pnl.ajustements.revenue),
    { type: "bloc" },
    { type: "ligne", libelle: "Coûts directs", montant: pnl.coutsDirects },
    ...ajustements(pnl.ajustements.gross_margin),
    { type: "ligne", libelle: "Marge brute", montant: pnl.margeBrute, ratio: pnl.ratios.margeBrute, niveau: "solde", indicateur: "margeBrute" },
    { type: "bloc" },
    { type: "ligne", libelle: libelleEtagePnl("contribution_margin"), montant: pnl.coutsCommerciaux },
    ...ajustements(pnl.ajustements.contribution_margin),
    { type: "ligne", libelle: "Marge contributive", montant: pnl.margeContributive, ratio: pnl.ratios.margeContributive, niveau: "solde", indicateur: "margeContributive" },
    { type: "bloc" },
    { type: "ligne", libelle: "Coûts de structure", montant: pnl.coutsStructure },
    ...ajustements(pnl.ajustements.ebitda),
    { type: "ligne", libelle: "EBITDA", montant: pnl.ebitda, ratio: pnl.ratios.ebitda, niveau: "solde", indicateur: "ebitda" },
    { type: "bloc", cash: true },
    { type: "ligne", libelle: libelleEtagePnl("extra_pnl"), montant: pnl.extraPnl },
    ...ajustements(pnl.ajustements.extra_pnl),
    // Comme à l'écran : ligne TVA en lecture TTC seulement ; la trésorerie la compte toujours.
    ...(ht ? [] : [{ type: "ligne", libelle: libelleEtagePnl("vat"), montant: pnl.tva } as LignePnl, ...ajustements(pnl.ajustements.vat)]),
    // Comme à l'écran : en HT, Cash flow opérationnel HT estimé (dernier résultat chiffré), puis
    // financement sans montant et « Voir onglet TTC » ; en TTC, la trésorerie complète.
    ht
      ? { type: "ligne", libelle: LIBELLE_CASH_FLOW_OPERATIONNEL, montant: pnl.cashFlowOperationnel, niveau: "solde", indicateur: "cashFlowOperationnel" }
      : { type: "ligne", libelle: LIBELLE_CASH_FLOW_OPERATIONNEL, montant: pnl.cashFlowOperationnel, niveau: "solde", tresorerie: true },
    { type: "bloc" },
    { type: "ligne", libelle: libelleEtagePnl("financing"), montant: pnl.financements, vide: ht },
    ...(ht ? [] : ajustements(pnl.ajustements.financing)),
    // Total final de la section : filet plein juste au-dessus.
    { type: "bloc", cash: true },
    { type: "ligne", libelle: LIBELLE_VARIATION_TRESORERIE, montant: pnl.variationTresorerie, niveau: "titre", tresorerie: true, texte: ht ? LIBELLE_VOIR_TTC : undefined },
  ];
}

const HAUTEUR_LIGNE_PNL = { titre: 24, solde: 21, ligne: 18, note: 10, bloc: 18 };

async function pageGeneral(doc: jsPDF, page: PageGeneralPdf, teintes: ReadonlyMap<string, string>) {
  const gauche: Zone = { x: PAGE.marge, y: HAUT_CONTENU, l: 350, h: BAS_CONTENU - HAUT_CONTENU };
  const lignes = lignesPnl(page);
  const hauteurDe = (ligne: LignePnl) =>
    ligne.type === "ligne" ? HAUTEUR_LIGNE_PNL[ligne.niveau ?? "ligne"] : HAUTEUR_LIGNE_PNL[ligne.type];
  const hauteurAvertissements = page.avertissements.length > 0 ? 14 + page.avertissements.length * 11 : 0;
  const hauteurTotale = lignes.reduce((total, ligne) => total + hauteurDe(ligne), 0);
  // Beaucoup d'ajustements : les lignes se resserrent plutôt que de sortir de la page.
  const echelle = Math.min(1, (gauche.h - hauteurAvertissements) / hauteurTotale);
  const xMontant = gauche.x + gauche.l - 62;
  const xRatio = gauche.x + gauche.l;

  let y = gauche.y;
  for (const ligne of lignes) {
    const hauteur = hauteurDe(ligne) * echelle;
    if (ligne.type === "bloc") {
      trait(doc, gauche.x, y + hauteur / 2, gauche.x + gauche.l, ligne.cash ? NEUTRES.encre : NEUTRES.bordure, ligne.cash ? 0.9 : 0.6);
    } else if (ligne.type === "note") {
      ecrire(doc, ligne.texte, gauche.x, y + hauteur * 0.7, { taille: 6.5 * echelle, couleur: NEUTRES.secondaire, largeurMax: gauche.l - 70 });
    } else {
      const fort = ligne.niveau !== undefined;
      const taille = (ligne.niveau === "titre" ? 12 : ligne.niveau === "solde" ? 10.5 : 9.5) * echelle;
      const base = y + hauteur * 0.72;
      const largeurLibelle = ecrire(doc, ligne.libelle, gauche.x, base, { taille, gras: fort, couleur: fort ? NEUTRES.encre : NEUTRES.secondaire, largeurMax: xMontant - gauche.x - 90 });
      // Indicateur principal : « Marge brute TTC », la mention en petit, à la suite du nom ; les
      // lignes de coûts restent sans mention, comme à l'écran.
      if (fort && !ligne.texte) ecrireMentionTTC(doc, gauche.x + largeurLibelle, base, 7 * echelle, ligne.tresorerie ? MENTION_TTC : mentionDeLaBase(page.base));
      const incomplet = ligne.indicateur !== undefined && page.incomplets.includes(ligne.indicateur);
      if (ligne.texte) ecrire(doc, ligne.texte, xMontant, base, { taille: 8.5 * echelle, couleur: NEUTRES.secondaire, aDroite: true });
      else if (!ligne.vide) ecrire(doc, incomplet ? "Incomplet" : formatMontantComptable(ligne.montant), xMontant, base, { taille, gras: fort, aDroite: true });
      if (ligne.ratio !== undefined && !incomplet && !ligne.vide && !ligne.texte) {
        ecrire(doc, formatPourcentage(ligne.ratio), xRatio, base, { taille: 8.5 * echelle, couleur: NEUTRES.secondaire, aDroite: true });
      }
    }
    y += hauteur;
  }

  if (page.avertissements.length > 0) {
    y += 14;
    for (const avertissement of page.avertissements) {
      doc.setFillColor(ROSE);
      doc.circle(gauche.x + 2, y - 2.4, 1.6, "F");
      ecrire(doc, avertissement, gauche.x + 9, y, { taille: 7.5, couleur: NEUTRES.secondaire, largeurMax: gauche.l - 9 });
      y += 11;
    }
  }

  const xDroite = PAGE.marge + 380;
  const hauteurBloc = (BAS_CONTENU - HAUT_CONTENU - 24) / 2;
  const droite = (rang: number): Zone => ({ x: xDroite, y: HAUT_CONTENU + rang * (hauteurBloc + 24), l: DROITE - xDroite, h: hauteurBloc });
  await blocStructure(
    doc,
    droite(0),
    "Structure des revenus",
    structureParCategorie(page.pnl.categories, ETAGES_REVENUS, "revenus"),
    "Aucun revenu mappé sur la période.",
    teintes,
    null,
    140
  );
  await blocStructure(
    doc,
    droite(1),
    "Structure des coûts",
    structureParCategorie(page.pnl.categories, ETAGES_COUTS, "couts"),
    "Aucun coût mappé sur la période.",
    teintes,
    null,
    140
  );
}

// --- Pages de détail ---

const HAUTEUR_LIGNE_TRANSACTION = 16;

async function pageDetail(doc: jsPDF, page: PageDetailPdf, teintes: ReadonlyMap<string, string>) {
  const config = METRIQUES_DETAIL[page.metrique];
  const { vue, filtres } = page;
  const gauche: Zone = { x: PAGE.marge, y: HAUT_CONTENU, l: 372, h: BAS_CONTENU - HAUT_CONTENU };

  // Indicateur.
  const largeurTitre = ecrire(doc, vue.kpi.categorie ?? vue.kpi.libelle, gauche.x, gauche.y + 9, {
    taille: 10.5,
    gras: true,
    capitales: true,
    couleur: ROSE,
    largeurMax: 250,
  });
  if (vue.kpi.categorie) {
    ecrire(doc, `· ${config.libelleDetail}`, gauche.x + largeurTitre + 6, gauche.y + 9, { taille: 8.5, couleur: NEUTRES.secondaire });
  }
  const mention = mentionDeLaBase(page.base);
  const largeurKpi = ecrire(doc, page.estimationIncomplete ? "Estimation incomplète" : formatMontant(vue.kpi.montant), gauche.x, gauche.y + 38, {
    taille: page.estimationIncomplete ? 18 : 26,
    gras: true,
  });
  ecrireMentionTTC(doc, gauche.x + largeurKpi, gauche.y + 38, 9, mention);
  if (vue.kpi.ratio !== undefined && !page.estimationIncomplete) {
    ecrire(doc, `${formatPourcentage(vue.kpi.ratio)} des encaissements`, gauche.x, gauche.y + 52, { taille: 9, couleur: NEUTRES.secondaire });
  } else if (vue.kpi.precision && vue.kpi.categorie === null) {
    // Cash flow : le périmètre exporté (hors financement, comme l'écran à son ouverture) est dit.
    ecrire(doc, vue.kpi.precision, gauche.x, gauche.y + 52, { taille: 9, couleur: NEUTRES.secondaire });
  }

  // Répartition par catégorie : camembert, ou histogramme par catégorie pour le Cash flow.
  const messageVide =
    filtres.mois !== null
      ? `Aucune catégorie mappée en ${config.libelleDetail} sur ce mois.`
      : `Aucune catégorie mappée en ${config.libelleDetail} sur la période.`;
  const titreRepartition = `${config.libelleDetail} par catégorie`;
  const repartition: Zone = { x: gauche.x, y: gauche.y + 70, l: gauche.l, h: 148 };
  if (vue.structure) {
    await blocStructure(doc, repartition, titreRepartition, vue.structure, messageVide, teintes, filtres.categorie, 118);
  } else if (vue.barresCategories) {
    titreBloc(doc, titreRepartition, repartition.x, repartition.y + 7, repartition.l);
    const svg =
      vue.barresCategories.length > 0
        ? await capturerSvg(
            <PasseCategoriesChart
              titre={titreRepartition}
              categories={vue.barresCategories}
              messageVide={messageVide}
              selection={filtres.categorie}
              onSelect={rien}
            />,
            520
          )
        : null;
    if (svg) await dessinerSvg(doc, svg, { x: repartition.x, y: repartition.y + 16, l: repartition.l, h: repartition.h - 20 });
    else ecrire(doc, messageVide, repartition.x, repartition.y + 30, { taille: 8.5, couleur: NEUTRES.secondaire, largeurMax: repartition.l });
  }

  // Évolution mensuelle.
  const titreEvolution = vue.kpi.categorie ? `${vue.kpi.categorie} par mois (en valeur absolue)` : `${vue.kpi.libelle} par mois`;
  const evolution: Zone = { x: gauche.x, y: repartition.y + repartition.h + 18, l: gauche.l, h: 0 };
  evolution.h = BAS_CONTENU - evolution.y;
  titreBloc(doc, titreEvolution, evolution.x, evolution.y + 7, evolution.l);
  const svgEvolution = await capturerSvg(
    <PasseEvolutionChart
      titre={titreEvolution}
      evolution={vue.evolution}
      enValeurAbsolue={vue.evolutionAbsolue}
      selection={filtres.mois}
      onSelect={rien}
    />,
    600
  );
  if (svgEvolution) await dessinerSvg(doc, svgEvolution, { x: evolution.x, y: evolution.y + 16, l: evolution.l, h: evolution.h - 16 });

  // Transactions : prioritaires, en haut de la colonne de droite.
  const x = PAGE.marge + 396;
  const largeur = DROITE - x;
  const colonnes = { date: x, libelle: x + 52, montant: x + largeur - 118, categorie: x + largeur - 110 };
  let y = HAUT_CONTENU + 7;
  const largeurTitreTransactions = titreBloc(doc, `Transactions · ${config.libelleDetail}`, x, y);
  ecrire(doc, String(page.nombreTransactions), x + largeurTitreTransactions + 8, y, { taille: 7.5, couleur: NEUTRES.secondaire });
  y += 12;
  if (page.nombreTransactions === 0) {
    const vide = page.libellesFiltres.length > 0 ? "Aucune transaction ne correspond au filtre actif." : "Aucune transaction sur la période.";
    ecrire(doc, vide, x, y + 4, { taille: 8.5, couleur: NEUTRES.secondaire });
    y += 16;
  } else {
    const precision =
      page.nombreTransactions > page.transactions.length
        ? `Les ${page.transactions.length} plus importantes en valeur absolue, sur ${page.nombreTransactions}`
        : "Triées par montant décroissant en valeur absolue";
    ecrire(doc, precision, x, y, { taille: 7, couleur: NEUTRES.secondaire });
    y += 15;
    const entete = { taille: 6.5, gras: true, capitales: true, couleur: NEUTRES.secondaire };
    ecrire(doc, "Date", colonnes.date, y, entete);
    ecrire(doc, "Libellé", colonnes.libelle, y, entete);
    ecrire(doc, `Montant ${mention}`, colonnes.montant, y, { ...entete, aDroite: true });
    ecrire(doc, "Catégorie", colonnes.categorie, y, entete);
    y += 5;
    trait(doc, x, y, x + largeur, NEUTRES.secondaire, 0.5);
    for (const part of page.transactions) {
      const base = y + 10.5;
      const ventilee = part.weight !== 1;
      ecrire(doc, formatDateCourte(part.transactionDate), colonnes.date, base, { taille: 7.5, couleur: NEUTRES.secondaire });
      ecrire(doc, part.label || "—", colonnes.libelle, base, { taille: 7.5, largeurMax: colonnes.montant - colonnes.libelle - 62 });
      ecrire(doc, formatMontant(part.montant), colonnes.montant, ventilee ? base - 2.5 : base, { taille: 7.5, gras: true, aDroite: true });
      // Transaction ventilée : la ligne porte la part de la catégorie, le montant bancaire reste visible.
      if (ventilee) {
        ecrire(doc, `${formatPourcentage(part.weight)} de ${formatMontant(part.montantSource)}`, colonnes.montant, base + 4, {
          taille: 5.5,
          couleur: NEUTRES.secondaire,
          aDroite: true,
        });
      }
      ecrire(doc, part.sourceCategoryName, colonnes.categorie, base, { taille: 7.5, couleur: NEUTRES.secondaire, largeurMax: x + largeur - colonnes.categorie });
      y += HAUTEUR_LIGNE_TRANSACTION;
      trait(doc, x, y, x + largeur);
    }
  }

  // Ajustements de gestion : zone compacte sous les transactions, dans la place qui reste.
  const lignes = vue.ajustements.lignes;
  if (lignes.length > 0) {
    y += 18;
    const largeurTitreAjustements = titreBloc(doc, "Ajustements de gestion", x, y);
    // Ajustements : jamais convertis — en lecture HT, ils sont repris tels que saisis.
    const precisionAjustements = page.base === "ht" ? "montants saisis, non convertis" : `montants ${MENTION_TTC}`;
    ecrire(doc, `hors banque, compris dans l'indicateur · ${precisionAjustements}`, x + largeurTitreAjustements + 8, y, { taille: 6.5, couleur: NEUTRES.secondaire });
    y += 6;
    let affichees = 0;
    for (const ligne of lignes) {
      const hauteur = ligne.notes.length > 0 ? 20 : 13;
      const resteApres = lignes.length - affichees - 1 + vue.ajustements.nombreMasques;
      if (y + hauteur + (resteApres > 0 ? 11 : 0) > BAS_CONTENU) break;
      ecrire(doc, ligne.label, x, y + 9, { taille: 7.5, largeurMax: largeur - 80 });
      ecrire(doc, formatKiloEuros(ligne.montant), x + largeur, y + 9, { taille: 7.5, gras: true, aDroite: true });
      if (ligne.notes.length > 0) {
        ecrire(doc, ligne.notes.join(" · "), x, y + 16.5, { taille: 6, couleur: NEUTRES.secondaire, largeurMax: largeur });
      }
      y += hauteur;
      affichees++;
    }
    const masquees = lignes.length - affichees + vue.ajustements.nombreMasques;
    if (masquees > 0) {
      ecrire(doc, `+ ${masquees} autre${masquees > 1 ? "s" : ""}`, x, y + 9, { taille: 6.5, couleur: NEUTRES.secondaire });
    }
  }
}

// --- Page BFR ---

const enK = (montant: number) => `${formatKiloEuros(montant, Math.abs(montant) < 10_000 ? 1 : 0)} HT`;
const jours = (valeur: number) => `${Math.round(valeur)} j`;
const LIBELLES_DISPERSION = { faible: "Dispersion faible", moderee: "Dispersion modérée", forte: "Dispersion forte" } as const;
const plurielFr = (n: number, mot: string) => `${n} ${mot}${n > 1 ? "s" : ""}`;

/** Bloc d'un délai : les lignes de la cartouche de l'onglet BFR, dans le même ordre. */
function blocDelai(doc: jsPDF, titre: string, cohorte: DelaisCohorte, precedente: DelaisCohorte, mois: string, x: number, y: number, largeur: number): number {
  const periode = libelleMois(mois).toLowerCase();
  const periodePrecedente = libelleMois(moisGlissants(mois, 2)[0]).toLowerCase();
  titreBloc(doc, titre, x, y, largeur);
  y += 16;
  if (cohorte.delaiMoyen === null) {
    ecrire(doc, `Aucune facture émise en ${periode} n'est réglée.`, x, y, { taille: 8.5, couleur: NEUTRES.secondaire, largeurMax: largeur });
    y += 12;
  } else {
    const comparaison = comparerAvecPrecedente(cohorte, precedente);
    const delta = (valeur: number | null) =>
      valeur === null ? `comparaison avec ${periodePrecedente} indisponible` : `${libelleVariationJours(valeur)} vs ${periodePrecedente}`;
    const l = ecrire(doc, jours(cohorte.delaiMoyen), x, y + 2, { taille: 15, gras: true });
    ecrire(doc, `en moyenne sur ${periode}`, x + l + 5, y + 2, { taille: 8.5, largeurMax: largeur - l - 5 });
    y += 13;
    const note = { taille: 7, couleur: NEUTRES.secondaire, largeurMax: largeur };
    ecrire(doc, "Moyenne pondérée par les montants HT des factures réglées", x, y, note);
    y += 10;
    ecrire(doc, `Délai : ${delta(comparaison.delai)}`, x, y, note);
    y += 11;
    if (cohorte.ecartEcheanceMoyen !== null) {
      const avecEcheance = cohorte.reglees.length - cohorte.sansEcheance;
      ecrire(doc, `${libelleEcartEcheance(cohorte.ecartEcheanceMoyen)}${cohorte.sansEcheance > 0 ? ` · sur ${plurielFr(avecEcheance, "facture")} avec échéance` : ""}`, x, y, { taille: 8, largeurMax: largeur });
      y += 10;
      ecrire(doc, `Écart à l'échéance : ${delta(comparaison.ecartEcheance)}`, x, y, note);
      y += 11;
    }
    if (cohorte.niveauDispersion !== null && cohorte.ecartType !== null) {
      ecrire(doc, `${LIBELLES_DISPERSION[cohorte.niveauDispersion]} · écart-type ${jours(cohorte.ecartType)}`, x, y, { taille: 8, largeurMax: largeur });
    } else {
      ecrire(doc, `Seulement ${plurielFr(cohorte.reglees.length, "facture réglée")} : moyenne peu représentative.`, x, y, note);
    }
    y += 10;
    if (cohorte.trancheDominante && cohorte.reglees.length >= SEUIL_REPRESENTATIF) {
      ecrire(doc, `${Math.round(cohorte.trancheDominante.part * 100)} % des factures réglées ${libelleTrancheDansPhrase(cohorte.trancheDominante.tranche)}`, x, y, { taille: 8, largeurMax: largeur });
      y += 10;
    }
  }
  if (cohorte.ouvertes.length > 0) {
    ecrire(doc, `${plurielFr(cohorte.ouvertes.length, "facture")} encore ouverte${cohorte.ouvertes.length > 1 ? "s" : ""} · ${enK(cohorte.montantOuvertes)}`, x, y + 2, { taille: 8, gras: true, largeurMax: largeur });
    y += 12;
    // Délai provisoire : la cohorte compte encore des factures ouvertes ; la moyenne peut bouger.
    if (cohorte.delaiMoyen !== null) {
      ecrire(doc, "Délai provisoire : il évoluera quand ces factures seront réglées.", x, y, { taille: 7, couleur: NEUTRES.secondaire, largeurMax: largeur });
      y += 10;
    }
  }
  return y;
}

async function pageBfr(doc: jsPDF, page: PageBfrPdf) {
  if (page.indisponible !== null || page.lecture === null || page.mois === null) {
    paragraphe(doc, page.indisponible ?? "BFR non disponible.", PAGE.marge, HAUT_CONTENU + 12, 520, { taille: 10, couleur: NEUTRES.encre });
    return;
  }
  const { situation, validee, statut, totaux } = page.lecture;
  const gauche = { x: PAGE.marge, l: 250 };

  // Situation : BFR HT, statut, puis la décomposition — les mêmes montants que l'onglet BFR.
  let y = HAUT_CONTENU + 9;
  titreBloc(doc, "BFR HT", gauche.x, y);
  const largeurBfr = ecrire(doc, totaux ? formatKiloEuros(totaux.bfr, Math.abs(totaux.bfr) < 10_000 ? 1 : 0) : "Incomplet", gauche.x, y + 29, { taille: 24, gras: true });
  if (totaux) ecrireMentionTTC(doc, gauche.x + largeurBfr, y + 29, 9, "HT");
  y += 45;
  ecrire(doc, LIBELLES_STATUT_BFR[statut] + (validee ? ` · photographie validée le ${formatDateCourte(validee.valideeLe.slice(0, 10))}` : ""), gauche.x, y, {
    taille: 8.5,
    gras: true,
    couleur: statut === "incomplete" ? ROSE : NEUTRES.secondaire,
    largeurMax: gauche.l,
  });
  y += 4;
  if (totaux === null && situation.raisons.length > 0) {
    y = paragraphe(doc, situation.raisons.join(" "), gauche.x, y + 10, gauche.l, { taille: 7, couleur: NEUTRES.secondaire });
  }
  y += 12;
  const termes: [string, string, boolean][] = [
    ["Créances clients HT", enK(validee ? validee.creances : situation.totalCreances), false],
    ["+ Stocks HT", validee ? enK(validee.stock) : situation.stock === null ? "Non renseigné" : enK(situation.stock), false],
    ["− Dettes fournisseurs HT", enK(validee ? validee.dettes : situation.totalDettes), false],
    ["= BFR HT", totaux ? enK(totaux.bfr) : "Incomplet", true],
  ];
  for (const [libelle, montant, total] of termes) {
    if (total) trait(doc, gauche.x, y - 3, gauche.x + gauche.l, NEUTRES.encre, 0.8);
    ecrire(doc, libelle, gauche.x, y + 9, { taille: total ? 9.5 : 9, gras: total, couleur: total ? NEUTRES.encre : NEUTRES.secondaire });
    ecrire(doc, montant, gauche.x + gauche.l, y + 9, { taille: total ? 9.5 : 9, gras: true, aDroite: true });
    y += 18;
  }


  // Évolution sur 12 mois : le graphique de l'onglet, rendu hors écran.
  const x = PAGE.marge + 280;
  const largeur = DROITE - x;
  let yd = HAUT_CONTENU + 9;
  titreBloc(doc, "Évolution sur 12 mois — BFR HT et délais de paiement", x, yd, largeur);
  yd += 14;
  // Légende fidèle aux marques du graphique : carré (BFR), trait plein (clients), tirets (fournisseurs).
  let xl = x;
  const bfrAffiche = page.evolution.some((p) => p.valeur !== null);
  if (bfrAffiche) {
    doc.setFillColor(COULEUR_BFR);
    doc.roundedRect(xl, yd - 6, 7, 7, 1.2, 1.2, "F");
    xl += 11 + ecrire(doc, "BFR HT (k€)", xl + 11, yd, { taille: 7.5, couleur: NEUTRES.secondaire }) + 14;
  }
  const traitLegende = (tirets: number[] | null, texte: string) => {
    doc.setDrawColor(COULEUR_DELAIS);
    doc.setLineWidth(1.6);
    if (tirets) doc.setLineDashPattern(tirets, 0);
    doc.line(xl, yd - 2.5, xl + 16, yd - 2.5);
    doc.setLineDashPattern([], 0);
    xl += 20 + ecrire(doc, texte, xl + 20, yd, { taille: 7.5, couleur: NEUTRES.secondaire }) + 14;
  };
  traitLegende(null, "Délai clients (j)");
  traitLegende(TIRETS_FOURNISSEURS.split(" ").map(Number), "Délai fournisseurs (j)");
  yd += 6;
  // Dates de l'axe sur deux lignes (« 30/09 » / « 2026 ») : lisibles une fois le graphique réduit.
  const svg = await capturerSvg(<PasseBfrEvolutionChart evolution={page.evolution} courant={page.mois} formatImpose="deux_lignes" />, 640);
  const zone = svg ? await dessinerSvg(doc, svg, { x, y: yd, l: largeur, h: 215 }) : { x, y: yd, l: largeur, h: 0 };
  const yNote = paragraphe(
    doc,
    (bfrAffiche
      ? "BFR (barres, axe de gauche, k€) : barre pleine = validé, barre claire = provisoire, pas de barre = mois incomplet, jamais estimé ; le mois de la situation est encadré. "
      : "BFR non affiché : aucun des 12 mois n'a de situation complète (stock HT non renseigné ou factures au solde inconnu). ") +
      "Délais (courbes, axe de droite, jours) : délai moyen réel des factures émises chaque mois, pondéré par le montant HT ; pas de point sans facture réglée. Chaque mois est daté à son dernier jour.",
    x,
    zone.y + zone.h + 12,
    largeur,
    { taille: 7, couleur: NEUTRES.secondaire }
  );

  // Délais : la cohorte du mois de la situation, comme les cartouches de l'onglet — en bas de page,
  // côte à côte sur toute la largeur.
  if (page.delais) {
    const yDelais = Math.max(y, yNote) + 16;
    trait(doc, PAGE.marge, yDelais - 12, DROITE);
    const colonne = (DROITE - PAGE.marge - 30) / 2;
    blocDelai(doc, "Délai clients", page.delais.client, page.delais.clientPrecedent, page.mois, PAGE.marge, yDelais, colonne);
    blocDelai(doc, "Délai fournisseurs", page.delais.fournisseur, page.delais.fournisseurPrecedent, page.mois, PAGE.marge + colonne + 30, yDelais, colonne);
  }
}

// --- Page Analyse d'écarts ---

const signeMontant = (montant: number) => (montant > 0 ? `+${formatMontant(montant)}` : formatMontant(montant));
const signeK = (montant: number) => (montant > 0 ? `+${formatKiloEuros(montant)}` : formatKiloEuros(montant));

async function pageEcarts(doc: jsPDF, page: PageEcartsPdf) {
  const { plan, comparaison } = page;
  if (comparaison === null) {
    let y = paragraphe(doc, page.indisponible ?? "Comparaison indisponible.", PAGE.marge, HAUT_CONTENU + 12, 560, { taille: 10, couleur: NEUTRES.encre });
    y = paragraphe(
      doc,
      `Le rapport compare toujours la période choisie à la période précédente comparable (${plan.libelle}) ; aucune autre période n'est prise à sa place.`,
      PAGE.marge,
      y + 6,
      560,
      { taille: 8, couleur: NEUTRES.secondaire }
    );
    return;
  }

  // Indicateurs : A (période précédente comparable), B (période du rapport), écart — convention de l'écran.
  const colonnes = [PAGE.marge, PAGE.marge + 260, PAGE.marge + 520];
  const bornes = (p: { debut: string; fin: string }) => `${formatDateCourte(p.debut)} — ${formatDateCourte(p.fin)}`;
  const kpi = (x: number, libelle: string, detail: string, valeur: string) => {
    ecrire(doc, libelle, x, HAUT_CONTENU + 8, { taille: 7.5, gras: true, capitales: true, couleur: NEUTRES.secondaire, largeurMax: 240 });
    ecrire(doc, detail, x, HAUT_CONTENU + 19, { taille: 7.5, couleur: NEUTRES.secondaire, largeurMax: 240 });
    const l = ecrire(doc, valeur, x, HAUT_CONTENU + 42, { taille: 17, gras: true });
    ecrireMentionTTC(doc, x + l, HAUT_CONTENU + 42, 8);
  };
  kpi(colonnes[0], `${comparaison.metrique} A`, `${plan.libelleA.charAt(0).toUpperCase()}${plan.libelleA.slice(1)} · ${bornes(plan.a)}`, formatMontant(comparaison.cashFlowA));
  kpi(colonnes[1], `${comparaison.metrique} B`, `${plan.libelleB} · ${bornes(plan.b)}`, formatMontant(comparaison.cashFlowB));
  kpi(
    colonnes[2],
    "Écart",
    comparaison.ecartRelatif === null ? "—" : `${comparaison.ecartRelatif > 0 ? "+" : ""}${formatPourcentage(comparaison.ecartRelatif)}`,
    signeMontant(comparaison.ecart)
  );
  let y = HAUT_CONTENU + 58;
  const reserves = [
    comparaison.financementCompris ? "Lecture : financement compris (Variation de trésorerie)." : "Lecture : hors financement (Cash flow opérationnel).",
    ...(plan.portion ? [`Période en cours : comparée à la même portion de la période précédente (${bornes(plan.b)} vs ${bornes(plan.a)}), jamais à une période entière.`] : []),
  ];
  for (const reserve of reserves) {
    ecrire(doc, reserve, PAGE.marge, y, { taille: 7.5, couleur: NEUTRES.secondaire, largeurMax: DROITE - PAGE.marge });
    y += 10;
  }

  // Waterfall : le graphique de l'écran, sans sélection.
  const gauche = { x: PAGE.marge, y: y + 8, l: 470 };
  titreBloc(doc, comparaison.financementCompris ? "Ce qui fait varier la trésorerie" : "Ce qui fait varier le Cash flow opérationnel", gauche.x, gauche.y, gauche.l);
  const svg = await capturerSvg(<PasseWaterfallChart comparaison={comparaison} libelleA="A" libelleB="B" selection={null} onSelect={rien} />, 780);
  const hauteurWaterfall = BAS_CONTENU - gauche.y - 44;
  const zone = svg ? await dessinerSvg(doc, svg, { x: gauche.x, y: gauche.y + 8, l: gauche.l, h: hauteurWaterfall }) : { x: gauche.x, y: gauche.y, l: gauche.l, h: 0 };
  const dont = [
    `Dont variation d'EBITDA : ${signeMontant(comparaison.variationEbitda)}`,
    `variation d'Extra P&L : ${signeMontant(comparaison.variationExtraPnl)}`,
    ...(comparaison.variationTva !== 0 ? [`variation de TVA : ${signeMontant(comparaison.variationTva)}`] : []),
    ...(comparaison.financementCompris ? [`variation des virements internes & financement : ${signeMontant(comparaison.variationFinancements)}`] : []),
  ].join(" · ");
  paragraphe(doc, dont, gauche.x, zone.y + zone.h + 14, gauche.l, { taille: 7.5, couleur: NEUTRES.secondaire });

  // Contributions par étage, puis les mouvements qui pèsent le plus.
  const x = PAGE.marge + 494;
  const largeur = DROITE - x;
  const col = { a: x + largeur - 120, b: x + largeur - 62, impact: x + largeur };
  let yt = gauche.y;
  const enteteTableau = (premiere: string, colonnesMontants: [number, string][]) => {
    const style = { taille: 6.5, gras: true, capitales: true, couleur: NEUTRES.secondaire };
    ecrire(doc, premiere, x, yt, style);
    for (const [xc, libelle] of colonnesMontants) ecrire(doc, libelle, xc, yt, { ...style, aDroite: true });
    yt += 5;
    trait(doc, x, yt, x + largeur, NEUTRES.secondaire, 0.5);
  };
  titreBloc(doc, "Contribution par étage", x, yt, largeur);
  yt += 14;
  enteteTableau(`Étage · ${MENTION_TTC}`, [[col.a, "A"], [col.b, "B"], [col.impact, "Impact"]]);
  for (const etage of comparaison.etages) {
    const base = yt + 11;
    ecrire(doc, etage.libelle, x, base, { taille: 7.5, largeurMax: col.a - x - 52 });
    ecrire(doc, formatKiloEuros(etage.montantA), col.a, base, { taille: 7.5, couleur: NEUTRES.secondaire, aDroite: true });
    ecrire(doc, formatKiloEuros(etage.montantB), col.b, base, { taille: 7.5, couleur: NEUTRES.secondaire, aDroite: true });
    ecrire(doc, signeK(etage.contribution), col.impact, base, { taille: 7.5, gras: true, aDroite: true });
    yt += 15;
    trait(doc, x, yt, x + largeur);
  }

  yt += 22;
  titreBloc(doc, "Principaux mouvements", x, yt, largeur);
  yt += 14;
  if (page.mouvements.length === 0) {
    ecrire(doc, "Aucun mouvement significatif entre les deux périodes.", x, yt + 4, { taille: 8, couleur: NEUTRES.secondaire, largeurMax: largeur });
    return;
  }
  enteteTableau("Catégorie", [[col.b, "Variation"], [col.impact, "Impact"]]);
  for (const mouvement of page.mouvements) {
    if (yt + 20 > BAS_CONTENU) break;
    const base = yt + 10;
    ecrire(doc, mouvement.nom, x, base, { taille: 7.5, largeurMax: col.b - x - 60 });
    ecrire(doc, mouvement.horsBanque ? `${mouvement.libelleEtage} · ajustement de gestion` : mouvement.libelleEtage, x, base + 7.5, {
      taille: 5.8,
      couleur: NEUTRES.secondaire,
      largeurMax: col.b - x - 60,
    });
    ecrire(doc, libelleVariation(mouvement.variation, (m) => formatKiloEuros(m)), col.b, base, { taille: 7.5, couleur: NEUTRES.secondaire, aDroite: true });
    ecrire(doc, signeK(mouvement.contribution), col.impact, base, { taille: 7.5, gras: true, aDroite: true });
    yt += 19;
    trait(doc, x, yt, x + largeur);
  }
}

// --- Document ---

async function chargerPolice(doc: jsPDF, fichier: string, style: "normal" | "bold") {
  const reponse = await fetch(`/fonts/${fichier}`);
  if (!reponse.ok) throw new Error(`Police ${fichier} indisponible (${reponse.status})`);
  const octets = new Uint8Array(await reponse.arrayBuffer());
  let binaire = "";
  for (let i = 0; i < octets.length; i += 0x8000) binaire += String.fromCharCode(...octets.subarray(i, i + 0x8000));
  doc.addFileToVFS(fichier, btoa(binaire));
  doc.addFont(fichier, POLICE, style);
}

export interface DocumentPdfPasse {
  organisation: string;
  pages: PagePdf[];
  teintes: ReadonlyMap<string, string>;
}

/** Compose le PDF et le renvoie ; le téléchargement est l'affaire de l'appelant. */
export async function genererPdfPasse({ organisation, pages, teintes }: DocumentPdfPasse): Promise<Blob> {
  const [{ jsPDF: JsPdf }] = await Promise.all([import("jspdf"), import("svg2pdf.js")]);
  const doc = new JsPdf({ orientation: "landscape", unit: "pt", format: "a4", compress: true });
  await Promise.all([chargerPolice(doc, "Lexend-Regular.ttf", "normal"), chargerPolice(doc, "Lexend-SemiBold.ttf", "bold")]);
  doc.setProperties({ title: `Novanta — Passé — ${organisation}`, creator: "Novanta" });

  // Pied de page : la lecture du rapport (Général) pour les pages P&L ; le BFR est toujours HT, l'Analyse
  // d'écarts toujours TTC.
  const baseRapport = pages[0]?.type === "general" ? pages[0].base : "ttc";
  const mention = (page: PagePdf) => (page.type === "bfr" ? DISCLAIMER_PDF_BFR : disclaimerPdf(page.type === "ecarts" ? "ttc" : baseRapport));
  for (const [index, page] of pages.entries()) {
    if (index > 0) doc.addPage("a4", "landscape");
    cadre(doc, organisation, page.titre, page.entete, page.type === "detail" ? page.libellesFiltres : [], index + 1, pages.length, mention(page));
    if (page.type === "general") await pageGeneral(doc, page, teintes);
    else if (page.type === "detail") await pageDetail(doc, page, teintes);
    else if (page.type === "bfr") await pageBfr(doc, page);
    else await pageEcarts(doc, page);
  }
  return doc.output("blob");
}

export function telechargerPdf(blob: Blob, nomFichier: string) {
  const url = URL.createObjectURL(blob);
  const lien = document.createElement("a");
  lien.href = url;
  lien.download = nomFichier;
  document.body.appendChild(lien);
  lien.click();
  lien.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
