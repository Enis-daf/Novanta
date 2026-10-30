import { AjustementGestion, moisDe } from "./pastAdjustments";
import type { AjustementComptable } from "./comptaStocks";
import {
  affecterCompte,
  indexerRegles,
  LigneComptable,
  normaliserCompte,
  RegleCorrespondance,
  regleDuCompte,
  StatutCompte,
} from "./comptaCorrespondance";
import { Periode } from "./pastTransactions";

/**
 * P&L comptable, calculé à partir des écritures lues dans Pennylane — pur, sans effet de bord.
 * Pennylane reste seul responsable de la comptabilisation : rien n'est corrigé, recalculé ni écrit ici.
 *
 * Signe : crédit − débit. Un produit est positif, une charge négative ; une extourne ou un avoir vient
 * naturellement en déduction de sa ligne. Les niveaux s'additionnent à partir des catégories
 * élémentaires, comme le P&L cash estimé. Tous les cumuls se font en centimes : aucun total ne dérive
 * sur un grand volume d'écritures.
 */

/** Ligne d'écriture telle que le moteur la lit. Le statut n'existe que si la source le fournit. */
export interface LigneEcriture {
  compte: string;
  date: string; // YYYY-MM-DD
  debit: number;
  credit: number;
  // Écriture annulée ou provisoire, seulement si la source sait le dire (pas d'hypothèse sinon).
  exclue?: boolean;
}

/** Cumul d'un compte sur un mois : une ligne de balance mensuelle, ou soldesDepuisLignes. */
export interface SoldeCompte {
  compte: string;
  mois: string; // YYYY-MM
  debit: number;
  credit: number;
  nombreLignes: number;
}

const centimes = (montant: number) => Math.round(montant * 100);

export function soldesDepuisLignes(lignes: Iterable<LigneEcriture>, periode: Periode): SoldeCompte[] {
  const cumuls = new Map<string, { compte: string; mois: string; debit: number; credit: number; nombreLignes: number }>();
  for (const ligne of lignes) {
    if (ligne.exclue || ligne.date < periode.debut || ligne.date > periode.fin) continue;
    const compte = normaliserCompte(ligne.compte);
    if (!compte) continue;
    const mois = ligne.date.slice(0, 7);
    const cle = `${compte}|${mois}`;
    const cumul = cumuls.get(cle) ?? { compte, mois, debit: 0, credit: 0, nombreLignes: 0 };
    cumul.debit += centimes(ligne.debit);
    cumul.credit += centimes(ligne.credit);
    cumul.nombreLignes += 1;
    cumuls.set(cle, cumul);
  }
  return [...cumuls.values()].map((c) => ({ ...c, debit: c.debit / 100, credit: c.credit / 100 }));
}

export interface CompteAnalyse {
  compte: string;
  libelle: string | null;
  statut: StatutCompte;
  regle: RegleCorrespondance | null;
  montant: number; // crédit − débit
  debit: number;
  credit: number;
  nombreLignes: number;
}

export interface CategorieComptable {
  cle: string; // `${ligne}|${categorie}`
  ligne: LigneComptable;
  nom: string;
  montant: number;
  comptes: string[];
}

export type SourceStock = "pennylane" | "novanta";

/** D'où vient la variation de stocks du P&L comptable. Jamais la somme des deux pour un même exercice. */
export interface DecisionStock {
  // « mixte » : la période est à cheval sur deux exercices arbitrés différemment.
  source: SourceStock | "aucune" | "mixte";
  // Les deux sources existent et personne n'a tranché : à demander à l'utilisateur.
  conflit: boolean;
  montantPennylane: number;
  montantNovanta: number;
}

export interface OptionsPnlComptable {
  soldes: SoldeCompte[];
  regles: RegleCorrespondance[];
  libellesComptes?: ReadonlyMap<string, string>;
  // Variations de stock Novanta de la période (ajustementsDepuisStocks), et l'arbitrage enregistré.
  variationsStockNovanta?: AjustementGestion[];
  sourceStockChoisie?: SourceStock | null;
  // Décision par mois (lib/comptaStocks.ts) : prime sur sourceStockChoisie. Un mois suit une seule source.
  arbitrageStockParMois?: ReadonlyMap<string, SourceStock | "aucune">;
  conflitStock?: boolean;
  // Ajustements de gestion du P&L comptable, déjà triés (lib/comptaStocks.ts::trierAjustements).
  ajustements?: AjustementComptable[];
  // Mois et lignes où la comptabilité cède la place à un ajustement de gestion, sur arbitrage. Les comptes
  // restent listés et contrôlés ; seul le montant ne compte pas : rien n'est compté deux fois.
  lignesEcarteesParMois?: ReadonlyMap<string, ReadonlySet<LigneComptable>>;
}

export interface PnlComptable {
  chiffreAffaires: number;
  coutsDirects: number;
  variationStocks: number;
  margeBrute: number;
  autresCoutsVariables: number;
  margeContributive: number;
  coutsStructure: number;
  ebitda: number;
  amortissements: number;
  resultatExploitation: number;
  elementsFinanciers: number;
  autresElements: number;
  impots: number;
  resultatNet: number;
  ratios: { margeBrute: number | null; margeContributive: number | null; ebitda: number | null; resultatNet: number | null };
  categories: CategorieComptable[];
  comptes: CompteAnalyse[];
  stock: DecisionStock;
  // Ajustements compris dans les lignes : identifiables, jamais fondus dans une écriture.
  ajustementsGestion: AjustementComptable[];
  nonAffectes: { comptes: CompteAnalyse[]; montant: number; montantAbsolu: number; significatif: boolean };
  // Numéros que la source renvoie mais que Novanta ne sait pas lire : hors calcul, jamais en silence.
  comptesIllisibles: number;
  // Une ligne d'écriture qui existe mais dont le P&L ne peut rien dire avec certitude.
  complet: boolean;
  controle: ControleExhaustivite;
  aDesEcritures: boolean;
}

/**
 * Le contrôle « Confirmation exhaustivité » du fichier de référence : le résultat de tous les comptes
 * de résultat doit se retrouver dans le P&L, à ce qui est explicitement écarté ou non affecté près.
 */
export interface ControleExhaustivite {
  totalComptesDeResultat: number;
  totalAffecte: number;
  totalHorsPerimetre: number;
  totalNonAffecte: number;
  equilibre: boolean;
}

// Au-delà, un compte sans affectation rend le résultat « Incomplet » : le chiffre n'est pas présenté.
// En deçà, il est présenté avec son alerte, jusqu'à ce que l'affectation soit faite.
const SEUIL_SIGNIFICATIF_MIN_EUROS = 100;
const SEUIL_SIGNIFICATIF_PART_CA = 0.005;

export function estSignificatif(montantAbsolu: number, chiffreAffaires: number): boolean {
  return montantAbsolu > Math.max(SEUIL_SIGNIFICATIF_MIN_EUROS, Math.abs(chiffreAffaires) * SEUIL_SIGNIFICATIF_PART_CA);
}

/**
 * Une seule source de variation de stocks. Pennylane seule ou Novanta seule : celle qui existe. Les
 * deux : celle que l'utilisateur a choisie. Sans choix, on signale le conflit et on garde les écritures
 * de Pennylane, source de ce P&L, sans jamais ajouter la variation Novanta par-dessus.
 */
export function deciderStock(aEcritures: boolean, montantPennylane: number, variationsNovanta: AjustementGestion[], choix: SourceStock | null | undefined): DecisionStock {
  const montantNovanta = variationsNovanta.reduce((total, a) => total + a.montant, 0);
  const aNovanta = variationsNovanta.length > 0;
  const base = { montantPennylane, montantNovanta };
  if (aEcritures && aNovanta) {
    if (choix === "pennylane" || choix === "novanta") return { ...base, source: choix, conflit: false };
    return { ...base, source: "pennylane", conflit: true };
  }
  if (aEcritures) return { ...base, source: "pennylane", conflit: false };
  if (aNovanta) return { ...base, source: "novanta", conflit: false };
  return { ...base, source: "aucune", conflit: false };
}

export function calculerPnlComptable(options: OptionsPnlComptable): PnlComptable {
  const index = indexerRegles(options.regles);
  const parCompte = new Map<string, { debit: number; credit: number; nombreLignes: number }>();
  const illisibles = new Set<string>();
  const arbitrage = options.arbitrageStockParMois;
  let stockPennylaneRetenu = 0;
  const retraits = new Map<LigneComptable, number>();
  for (const solde of options.soldes) {
    const compte = normaliserCompte(solde.compte);
    if (!compte) {
      illisibles.add(solde.compte);
      continue;
    }
    const cumul = parCompte.get(compte) ?? { debit: 0, credit: 0, nombreLignes: 0 };
    cumul.debit += centimes(solde.debit);
    cumul.credit += centimes(solde.credit);
    cumul.nombreLignes += solde.nombreLignes;
    parCompte.set(compte, cumul);
    if (arbitrage?.get(solde.mois) === "pennylane" && regleDuCompte(compte, index)?.destination === "inventory_variation") {
      stockPennylaneRetenu += centimes(solde.credit) - centimes(solde.debit);
    }
    const ecartees = options.lignesEcarteesParMois?.get(solde.mois);
    if (ecartees) {
      const destination = regleDuCompte(compte, index)?.destination;
      if (destination && destination !== "out_of_scope" && ecartees.has(destination)) {
        retraits.set(destination, (retraits.get(destination) ?? 0) + centimes(solde.credit) - centimes(solde.debit));
      }
    }
  }

  const totaux: Record<LigneComptable, number> = {
    revenue: 0,
    direct_costs: 0,
    inventory_variation: 0,
    other_variable_costs: 0,
    structure_costs: 0,
    depreciation: 0,
    financial: 0,
    other_items: 0,
    income_tax: 0,
  };
  const categories = new Map<string, CategorieComptable & { centimes: number }>();
  const comptes: CompteAnalyse[] = [];
  let totalResultat = 0;
  let totalHorsPerimetre = 0;
  let totalNonAffecte = 0;
  let absoluNonAffecte = 0;
  let aEcrituresStock = false;

  for (const [compte, cumul] of parCompte) {
    const { statut, regle } = affecterCompte(compte, index);
    const montant = cumul.credit - cumul.debit;
    comptes.push({
      compte,
      libelle: options.libellesComptes?.get(compte) ?? null,
      statut,
      regle,
      montant: montant / 100,
      debit: cumul.debit / 100,
      credit: cumul.credit / 100,
      nombreLignes: cumul.nombreLignes,
    });
    if (statut === "bilan") continue;
    totalResultat += montant;
    if (statut === "non_affecte") {
      totalNonAffecte += montant;
      absoluNonAffecte += Math.abs(montant);
      continue;
    }
    if (statut === "hors_perimetre") {
      totalHorsPerimetre += montant;
      continue;
    }
    const ligne = regle!.destination as LigneComptable;
    if (ligne === "inventory_variation") aEcrituresStock = true;
    totaux[ligne] += montant;
    const cle = `${ligne}|${regle!.categorie}`;
    const categorie = categories.get(cle) ?? { cle, ligne, nom: regle!.categorie, montant: 0, comptes: [], centimes: 0 };
    categorie.centimes += montant;
    categorie.comptes.push(compte);
    categories.set(cle, categorie);
  }

  const totalAffecte = Object.values(totaux).reduce((a, b) => a + b, 0);
  let stock: DecisionStock;
  let stockRetenu: number;
  if (arbitrage) {
    const novantaRetenues = (options.variationsStockNovanta ?? []).filter((a) => arbitrage.get(moisDe(a.date)) === "novanta");
    const stockNovantaRetenu = novantaRetenues.reduce((t, a) => t + centimes(a.montant), 0);
    const parLaCompta = [...arbitrage.values()].includes("pennylane") && aEcrituresStock;
    const parNovanta = novantaRetenues.length > 0;
    stockRetenu = stockPennylaneRetenu + stockNovantaRetenu;
    stock = {
      source: parLaCompta && parNovanta ? "mixte" : parLaCompta ? "pennylane" : parNovanta ? "novanta" : "aucune",
      conflit: options.conflitStock ?? false,
      montantPennylane: stockPennylaneRetenu / 100,
      montantNovanta: stockNovantaRetenu / 100,
    };
  } else {
    stock = deciderStock(aEcrituresStock, totaux.inventory_variation / 100, options.variationsStockNovanta ?? [], options.sourceStockChoisie);
    stockRetenu = stock.source === "novanta" ? centimes(stock.montantNovanta) : stock.source === "pennylane" ? totaux.inventory_variation : 0;
  }

  // Ajustements de gestion : additionnés à leur ligne, hors du contrôle d'exhaustivité des comptes.
  const ajustementsGestion = options.ajustements ?? [];
  const ajuste = (ligne: LigneComptable) => totaux[ligne] - (retraits.get(ligne) ?? 0) + ajustementsGestion.reduce((t, a) => (a.ligne === ligne ? t + centimes(a.montant) : t), 0);

  const ca = ajuste("revenue");
  const margeBrute = ca + ajuste("direct_costs") + stockRetenu;
  const margeContributive = margeBrute + ajuste("other_variable_costs");
  const ebitda = margeContributive + ajuste("structure_costs");
  const resultatExploitation = ebitda + ajuste("depreciation");
  const resultatNet = resultatExploitation + ajuste("financial") + ajuste("other_items") + ajuste("income_tax");
  const ratio = (valeur: number) => (ca === 0 ? null : valeur / ca);
  const significatif = estSignificatif(absoluNonAffecte / 100, ca / 100);

  return {
    chiffreAffaires: ca / 100,
    coutsDirects: ajuste("direct_costs") / 100,
    variationStocks: stockRetenu / 100,
    margeBrute: margeBrute / 100,
    autresCoutsVariables: ajuste("other_variable_costs") / 100,
    margeContributive: margeContributive / 100,
    coutsStructure: ajuste("structure_costs") / 100,
    ebitda: ebitda / 100,
    amortissements: ajuste("depreciation") / 100,
    resultatExploitation: resultatExploitation / 100,
    elementsFinanciers: ajuste("financial") / 100,
    autresElements: ajuste("other_items") / 100,
    impots: ajuste("income_tax") / 100,
    resultatNet: resultatNet / 100,
    ratios: { margeBrute: ratio(margeBrute), margeContributive: ratio(margeContributive), ebitda: ratio(ebitda), resultatNet: ratio(resultatNet) },
    categories: [...categories.values()]
      // Écritures écartées par l'arbitrage : la ligne de stock ne se lit plus ici.
      .filter((c) => c.ligne !== "inventory_variation" || stock.source === "pennylane")
      .map(({ centimes: montant, ...c }) => ({ ...c, montant: montant / 100, comptes: c.comptes.sort() })),
    comptes: comptes.sort((a, b) => a.compte.localeCompare(b.compte)),
    stock,
    ajustementsGestion,
    nonAffectes: {
      // Mouvementé même à solde nul : la balance ne donne pas de nombre de lignes.
      comptes: comptes.filter((c) => c.statut === "non_affecte" && (c.debit !== 0 || c.credit !== 0 || c.nombreLignes > 0)).sort((a, b) => Math.abs(b.montant) - Math.abs(a.montant)),
      montant: totalNonAffecte / 100,
      montantAbsolu: absoluNonAffecte / 100,
      significatif,
    },
    comptesIllisibles: illisibles.size,
    complet: !significatif && !stock.conflit && illisibles.size === 0,
    controle: {
      totalComptesDeResultat: totalResultat / 100,
      totalAffecte: totalAffecte / 100,
      totalHorsPerimetre: totalHorsPerimetre / 100,
      totalNonAffecte: totalNonAffecte / 100,
      equilibre: totalResultat === totalAffecte + totalHorsPerimetre + totalNonAffecte,
    },
    aDesEcritures: comptes.length > 0,
  };
}

/** Soldes d'une période : un mois de solde appartient à la période s'il la recoupe. */
/** Mois entiers couverts : la balance est mensuelle, une période partielle s'élargit à ses mois. */
export function periodeEnMoisEntiers(periode: Periode): Periode {
  return { debut: `${periode.debut.slice(0, 7)}-01`, fin: finDuMois(periode.fin.slice(0, 7)) };
}

function finDuMois(mois: string): string {
  const [annee, numero] = mois.split("-").map(Number);
  return new Date(Date.UTC(annee, numero, 0)).toISOString().slice(0, 10);
}

export function soldesDeLaPeriode(soldes: SoldeCompte[], periode: Periode): SoldeCompte[] {
  const debut = periode.debut.slice(0, 7);
  const fin = periode.fin.slice(0, 7);
  return soldes.filter((s) => s.mois >= debut && s.mois <= fin);
}
