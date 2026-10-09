import type { jsPDF } from "jspdf";
import { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import PasseCategoriesChart from "@/components/PasseCategoriesChart";
import PasseEvolutionChart from "@/components/PasseEvolutionChart";
import PasseStructureChart from "@/components/PasseStructureChart";
import { formatDateCourte } from "./dates";
import { NEUTRES, teintesDesParts } from "./dataviz";
import { formatKiloEuros, formatMontant, formatMontantComptable, formatPourcentage } from "./format";
import { LigneAjustement } from "./pastAdjustments";
import { libelleEtagePnl } from "./pastCategoryMapping";
import { METRIQUES_DETAIL } from "./pastDetail";
import { DISCLAIMER_PASSE, PageDetailPdf, PageGeneralPdf, PagePdf, textePdf } from "./pastPdfModel";
import { ETAGES_COUTS, ETAGES_REVENUS, Structure, structureParCategorie } from "./pastPnl";
import { Periode } from "./pastTransactions";

/**
 * Dessin du PDF du module "Passé" (A4 paysage, une page par onglet). Chaque page est composée à
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

function trait(doc: jsPDF, x1: number, y: number, x2: number, couleur: string = NEUTRES.bordure, epaisseur = 0.6) {
  doc.setDrawColor(couleur);
  doc.setLineWidth(epaisseur);
  doc.line(x1, y, x2, y);
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

function cadre(doc: jsPDF, organisation: string, titre: string, periode: Periode, filtres: string[], numero: number, total: number) {
  doc.setFillColor(NEUTRES.fond);
  doc.rect(0, 0, PAGE.largeur, PAGE.hauteur, "F");

  ecrire(doc, organisation, PAGE.marge, 44, { taille: 7.5, gras: true, capitales: true, couleur: NEUTRES.secondaire, largeurMax: 380 });
  ecrire(doc, titre, PAGE.marge, 70, { taille: 23, gras: true });
  // Le rose reste un accent : un seul filet par page.
  doc.setFillColor(ROSE);
  doc.rect(PAGE.marge, 78, 30, 2.4, "F");

  ecrire(doc, "Période analysée", DROITE, 44, { taille: 7.5, gras: true, capitales: true, couleur: NEUTRES.secondaire, aDroite: true });
  ecrire(doc, `${formatDateCourte(periode.debut)} — ${formatDateCourte(periode.fin)}`, DROITE, 59, { taille: 11.5, gras: true, aDroite: true });
  if (filtres.length > 0) {
    const largeur = ecrire(doc, filtres.join(" · "), DROITE, 76, { taille: 9, gras: true, aDroite: true, largeurMax: 330 });
    ecrire(doc, "Filtre", DROITE - largeur - 8, 76, { taille: 7.5, gras: true, capitales: true, couleur: ROSE, aDroite: true });
  }
  trait(doc, PAGE.marge, 88, DROITE);

  trait(doc, PAGE.marge, PAGE.hauteur - 42, DROITE);
  ecrire(doc, DISCLAIMER_PASSE, PAGE.marge, PAGE.hauteur - 28, { taille: 7.5, couleur: NEUTRES.secondaire });
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
  | { type: "ligne"; libelle: string; montant: number; ratio?: number | null; niveau?: "titre" | "solde" }
  | { type: "note"; texte: string }
  | { type: "bloc"; cash?: boolean };

function lignesPnl(page: PageGeneralPdf): LignePnl[] {
  const { pnl } = page;
  const ajustements = (lignes: LigneAjustement[]): LignePnl[] =>
    lignes.flatMap((ligne) => [
      { type: "ligne", libelle: ligne.label, montant: ligne.montant } as LignePnl,
      ...ligne.notes.map((texte) => ({ type: "note", texte }) as LignePnl),
    ]);
  return [
    { type: "ligne", libelle: "Chiffre d'affaires", montant: pnl.ca, niveau: "titre" },
    ...ajustements(pnl.ajustements.revenue),
    { type: "bloc" },
    { type: "ligne", libelle: "Coûts directs", montant: pnl.coutsDirects },
    ...ajustements(pnl.ajustements.gross_margin),
    { type: "ligne", libelle: "Marge brute", montant: pnl.margeBrute, ratio: pnl.ratios.margeBrute, niveau: "solde" },
    { type: "bloc" },
    { type: "ligne", libelle: libelleEtagePnl("contribution_margin"), montant: pnl.coutsCommerciaux },
    ...ajustements(pnl.ajustements.contribution_margin),
    { type: "ligne", libelle: "Marge contributive", montant: pnl.margeContributive, ratio: pnl.ratios.margeContributive, niveau: "solde" },
    { type: "bloc" },
    { type: "ligne", libelle: "Coûts de structure", montant: pnl.coutsStructure },
    ...ajustements(pnl.ajustements.ebitda),
    { type: "ligne", libelle: "EBITDA", montant: pnl.ebitda, ratio: pnl.ratios.ebitda, niveau: "solde" },
    { type: "bloc", cash: true },
    { type: "ligne", libelle: "Extra P&L", montant: pnl.extraPnl },
    ...ajustements(pnl.ajustements.extra_pnl),
    { type: "ligne", libelle: "Cash flow", montant: pnl.cashFlow, niveau: "titre" },
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
      ecrire(doc, ligne.libelle, gauche.x, base, { taille, gras: fort, couleur: fort ? NEUTRES.encre : NEUTRES.secondaire, largeurMax: xMontant - gauche.x - 90 });
      ecrire(doc, formatMontantComptable(ligne.montant), xMontant, base, { taille, gras: fort, aDroite: true });
      if (ligne.ratio !== undefined) {
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
  const largeurTitre = ecrire(doc, vue.kpi.categorie ?? config.libelle, gauche.x, gauche.y + 9, {
    taille: 10.5,
    gras: true,
    capitales: true,
    couleur: ROSE,
    largeurMax: 250,
  });
  if (vue.kpi.categorie) {
    ecrire(doc, `· ${config.libelleDetail}`, gauche.x + largeurTitre + 6, gauche.y + 9, { taille: 8.5, couleur: NEUTRES.secondaire });
  }
  ecrire(doc, formatMontant(vue.kpi.montant), gauche.x, gauche.y + 38, { taille: 26, gras: true });
  if (vue.kpi.ratio !== undefined) {
    ecrire(doc, `${formatPourcentage(vue.kpi.ratio)} du CA`, gauche.x, gauche.y + 52, { taille: 9, couleur: NEUTRES.secondaire });
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
  const titreEvolution = vue.kpi.categorie ? `${vue.kpi.categorie} par mois (en valeur absolue)` : `${config.libelle} par mois`;
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
    ecrire(doc, "Montant", colonnes.montant, y, { ...entete, aDroite: true });
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
    ecrire(doc, "hors banque, compris dans l'indicateur", x + largeurTitreAjustements + 8, y, { taille: 6.5, couleur: NEUTRES.secondaire });
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
  periode: Periode;
  pages: PagePdf[];
  teintes: ReadonlyMap<string, string>;
}

/** Compose le PDF et le renvoie ; le téléchargement est l'affaire de l'appelant. */
export async function genererPdfPasse({ organisation, periode, pages, teintes }: DocumentPdfPasse): Promise<Blob> {
  const [{ jsPDF: JsPdf }] = await Promise.all([import("jspdf"), import("svg2pdf.js")]);
  const doc = new JsPdf({ orientation: "landscape", unit: "pt", format: "a4", compress: true });
  await Promise.all([chargerPolice(doc, "Lexend-Regular.ttf", "normal"), chargerPolice(doc, "Lexend-SemiBold.ttf", "bold")]);
  doc.setProperties({ title: `Novanta — Passé — ${organisation}`, creator: "Novanta" });

  for (const [index, page] of pages.entries()) {
    if (index > 0) doc.addPage("a4", "landscape");
    cadre(doc, organisation, page.titre, periode, page.type === "detail" ? page.libellesFiltres : [], index + 1, pages.length);
    if (page.type === "general") await pageGeneral(doc, page, teintes);
    else await pageDetail(doc, page, teintes);
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
