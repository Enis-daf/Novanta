import { affecterCompte, IndexRegles, LIGNES_COMPTABLES, RegleCorrespondance } from "./comptaCorrespondance";
import { CompteAnalyse, periodeEnMoisEntiers, PnlComptable } from "./comptaPnl";
import { LIMITE_EXERCICES_INDISPONIBLES } from "./comptaExercices";
import type { BilanSynchro, RaisonEchecMois } from "./comptaSynchro";
import { libelleMois, moisDeLaPeriode } from "./pastDetail";
import { Periode } from "./pastTransactions";
import { PnlCategorie, Structure, structureParCategorie } from "./pastPnl";
import type { EtagePnl } from "./pastCategoryMapping";

/** Lecture des écrans du P&L comptable. Fonctions pures, à partir de ce que le moteur a calculé. */

export const TITRE_PNL_COMPTABLE = "P&L comptable";

// Texte générique : le DAF reste responsable de l'interprétation. Pas de rapprochement automatique.
export const TEXTE_DEUX_PNL =
  "Le P&L cash estimé se lit sur les transactions bancaires, en HT estimé : il pilote l'activité même quand la comptabilité n'est pas à jour. Le P&L comptable se lit sur les écritures de Pennylane : il reconnaît le chiffre d'affaires et les charges selon les règles comptables. Ce sont deux lectures différentes, qui n'ont pas vocation à donner le même chiffre.";

// Ce que le diagnostic a montré : la balance ne distingue pas ce qui est validé de ce qui ne l'est pas.
export const MENTION_BALANCE = "Ce P&L reprend la balance de Pennylane : toutes ses écritures, y compris celles en attente de validation.";

export const TITRE_PROVISOIRE = "Comptabilité provisoire — exercice non clôturé";
export const TEXTE_PROVISOIRE = "Les montants peuvent évoluer jusqu'à la clôture comptable, notamment après comptabilisation des stocks, amortissements et écritures de régularisation.";
// Statut non documenté, ou exercice inconnu de Novanta : on ne conclut pas à une clôture.
export const TEXTE_STATUT_AMBIGU = "Le statut de clôture de cet exercice n'a pas pu être établi.";

/** « écritures en décembre 2026 », « 11 mois saisis, de janvier à novembre 2026 ». */
export function libellePerimetreMois(mois: string[]): string {
  if (mois.length === 0) return "aucun mois";
  if (mois.length === 1) return libelleMois(mois[0]).toLocaleLowerCase("fr");
  return `${mois.length} mois, de ${libelleMois(mois[0]).toLocaleLowerCase("fr")} à ${libelleMois(mois[mois.length - 1]).toLocaleLowerCase("fr")}`;
}

const RAISONS_ECHEC: Record<RaisonEchecMois, string> = {
  troncature: "réponse incomplète",
  desequilibre: "balance déséquilibrée",
  balance_vide_suspecte: "balance vide inattendue",
  format: "format inattendu",
  lecture: "lecture impossible",
  ecriture: "enregistrement impossible",
  non_lu: "non lu",
};

/** Résultat d'une synchronisation, dit simplement : un mois en échec garde ses chiffres précédents. */
export function resumeSynchro(bilan: BilanSynchro): string {
  const parties = [`${bilan.moisActualises} mois actualisé${bilan.moisActualises > 1 ? "s" : ""} sur ${bilan.moisDemandes}.`];
  if (bilan.moisEnEchec.length > 0) {
    const raisons = [...new Set(bilan.moisEnEchec.map((e) => RAISONS_ECHEC[e.raison]))].join(", ");
    parties.push(`${bilan.moisEnEchec.length} mois garde${bilan.moisEnEchec.length > 1 ? "nt" : ""} ses chiffres précédents (${raisons}).`);
  }
  if (bilan.nouveauxComptes > 0) parties.push(`${bilan.nouveauxComptes} nouveau${bilan.nouveauxComptes > 1 ? "x" : ""} compte${bilan.nouveauxComptes > 1 ? "s" : ""}.`);
  if (bilan.comptesIllisibles > 0) parties.push(`${bilan.comptesIllisibles} numéro${bilan.comptesIllisibles > 1 ? "s" : ""} de compte illisible${bilan.comptesIllisibles > 1 ? "s" : ""}, hors du calcul.`);
  if (bilan.limites.includes(LIMITE_EXERCICES_INDISPONIBLES)) parties.push("Exercices illisibles : seuls les mois récents sont garantis.");
  return parties.join(" ");
}

/** La période choisie ne tombe pas sur des mois entiers : la balance en couvrira davantage. */
export function periodePartielle(periode: Periode): boolean {
  const entiers = periodeEnMoisEntiers(periode);
  return entiers.debut !== periode.debut || entiers.fin !== periode.fin;
}

/** Mois à lire chez Pennylane : ceux de la période, sans aller au-delà du mois en cours. */
export function moisALire(periode: Periode, aujourdhui: string): string[] {
  return moisDeLaPeriode(periode).filter((mois) => mois <= aujourdhui.slice(0, 7));
}

export type FiltreComptes = "tous" | "non_affectes" | "affectes" | "hors_perimetre" | "bilan";

export interface LigneCompteCorrespondance extends CompteAnalyse {
  nouveau: boolean;
}

/** Comptes de la période, à traiter d'abord : non affectés, nouveaux, puis numéro croissant. */
export function lignesCorrespondance(comptes: CompteAnalyse[], index: IndexRegles, nouveaux: ReadonlySet<string>): LigneCompteCorrespondance[] {
  return comptes
    .map((compte) => {
      // Racine en cours d'édition : le statut suit la règle courante, pas le dernier calcul serveur.
      const { statut, regle } = affecterCompte(compte.compte, index);
      return { ...compte, statut, regle, nouveau: nouveaux.has(compte.compte) };
    })
    .sort((a, b) => Number(b.statut === "non_affecte") - Number(a.statut === "non_affecte") || Number(b.nouveau) - Number(a.nouveau) || a.compte.localeCompare(b.compte));
}

export function filtrerComptes<T extends Pick<CompteAnalyse, "statut">>(lignes: T[], filtre: FiltreComptes): T[] {
  switch (filtre) {
    case "tous":
      return lignes;
    case "non_affectes":
      return lignes.filter((l) => l.statut === "non_affecte");
    case "affectes":
      return lignes.filter((l) => l.statut === "affecte");
    case "hors_perimetre":
      return lignes.filter((l) => l.statut === "hors_perimetre");
    case "bilan":
      return lignes.filter((l) => l.statut === "bilan");
  }
}

const FENETRE_NOUVEAU_COMPTE_MS = 7 * 86_400_000;

/**
 * Comptes apparus dans les 7 jours précédant la dernière synchronisation terminée. Une fenêtre, et non
 * « après la fin » : un compte est enregistré PENDANT la synchronisation, une lecture se fait mois par
 * mois, et la première vue précède donc toujours la date de fin.
 */
export function comptesNouveaux(comptes: { numero: string; premiereVue: string }[], derniereSynchro: string | null): Set<string> {
  if (!derniereSynchro) return new Set();
  const depuis = new Date(derniereSynchro).getTime() - FENETRE_NOUVEAU_COMPTE_MS;
  return new Set(comptes.filter((c) => new Date(c.premiereVue).getTime() >= depuis).map((c) => c.numero));
}

export interface LigneRapport {
  cle: string;
  libelle: string;
  montant: number;
  ratio?: number | null;
  niveau?: "titre" | "solde" | "total";
  categories?: { nom: string; montant: number }[];
}

const libelleLigne = (cle: (typeof LIGNES_COMPTABLES)[number]["cle"]) => LIGNES_COMPTABLES.find((l) => l.cle === cle)!.libelle;

/** La cascade à l'écran : chaque ligne vient du moteur, rien n'est recalculé ici. */
export function lignesDuRapport(pnl: PnlComptable): LigneRapport[][] {
  const detail = (ligne: (typeof LIGNES_COMPTABLES)[number]["cle"]) =>
    pnl.categories
      .filter((c) => c.ligne === ligne)
      .sort((a, b) => Math.abs(b.montant) - Math.abs(a.montant))
      .map((c) => ({ nom: c.nom, montant: c.montant }));
  // Un ajustement de gestion reste identifiable : jamais fondu dans une catégorie de comptes.
  const ajustements = (ligne: string) => pnl.ajustementsGestion.filter((a) => a.ligne === ligne).map((a) => ({ nom: `${a.libelle} (ajustement de gestion)`, montant: a.montant }));
  const avecDetail = (cle: (typeof LIGNES_COMPTABLES)[number]["cle"], montant: number): LigneRapport => ({ cle, libelle: libelleLigne(cle), montant, categories: [...detail(cle), ...ajustements(cle)] });
  return [
    [{ ...avecDetail("revenue", pnl.chiffreAffaires), niveau: "titre" }],
    [
      avecDetail("direct_costs", pnl.coutsDirects),
      { ...avecDetail("inventory_variation", pnl.variationStocks), libelle: pnl.stock.source === "novanta" ? "Variation de stocks (ajustement de gestion Novanta)" : pnl.stock.source === "mixte" ? "Variation de stocks (selon l'exercice)" : libelleLigne("inventory_variation") },
      { cle: "marge_brute", libelle: "Marge brute", montant: pnl.margeBrute, ratio: pnl.ratios.margeBrute, niveau: "solde" },
    ],
    [
      avecDetail("other_variable_costs", pnl.autresCoutsVariables),
      { cle: "marge_contributive", libelle: "Marge contributive", montant: pnl.margeContributive, ratio: pnl.ratios.margeContributive, niveau: "solde" },
    ],
    [avecDetail("structure_costs", pnl.coutsStructure), { cle: "ebitda", libelle: "EBITDA", montant: pnl.ebitda, ratio: pnl.ratios.ebitda, niveau: "solde" }],
    [avecDetail("depreciation", pnl.amortissements), { cle: "resultat_exploitation", libelle: "Résultat d'exploitation", montant: pnl.resultatExploitation, niveau: "solde" }],
    [
      avecDetail("financial", pnl.elementsFinanciers),
      avecDetail("other_items", pnl.autresElements),
      avecDetail("income_tax", pnl.impots),
      { cle: "resultat_net", libelle: "Résultat net", montant: pnl.resultatNet, ratio: pnl.ratios.resultatNet, niveau: "total" },
    ],
  ];
}

// Les graphiques de répartition existants lisent des « étages » : simple traduction de forme.
const ETAGE_GRAPHIQUE: Partial<Record<string, EtagePnl>> = {
  revenue: "revenue",
  direct_costs: "gross_margin",
  other_variable_costs: "contribution_margin",
  structure_costs: "ebitda",
};

function categoriesPourGraphique(pnl: PnlComptable): PnlCategorie[] {
  return pnl.categories.flatMap((c) => {
    const etage = ETAGE_GRAPHIQUE[c.ligne];
    return etage ? [{ sourceCategoryId: c.cle, sourceCategoryName: c.nom, etage, montant: c.montant }] : [];
  });
}

export function structuresDuRapport(pnl: PnlComptable): { revenus: Structure; couts: Structure; categories: PnlCategorie[] } {
  const categories = categoriesPourGraphique(pnl);
  return {
    revenus: structureParCategorie(categories, ["revenue"], "revenus"),
    couts: structureParCategorie(categories, ["gross_margin", "contribution_margin", "ebitda"], "couts"),
    categories,
  };
}

export type { RegleCorrespondance };
