import { StockFinDeMois, finDeMois } from "./pastAdjustments";
import { FactureBfr, FactureIncertaine, facturesExcluesRetenues, moisGlissants, SituationBfr, situationBfr, SituationValidee, StatutBfr, statutBfr, TotauxBfr, totauxRetenus } from "./pastBfr";
import { DelaisCohorte, delaisDuMois } from "./pastBfrDelais";

/**
 * Lecture du BFR d'un mois et de son évolution sur 12 mois — fonctions pures, partagées par l'onglet
 * BFR et par l'export PDF : un même mois donne exactement les mêmes chiffres dans les deux.
 */

export interface SourcesBfr {
  factures: FactureBfr[];
  validees: SituationValidee[];
  stocks: StockFinDeMois[];
  sansStock: boolean;
  // Jour (YYYY-MM-DD, date locale) de la dernière synchronisation des factures, null si jamais.
  synchroniseLe: string | null;
}

/** Stock HT de fin de mois retenu ; null s'il n'est pas renseigné. */
export function stockBfrDuMois(stocks: StockFinDeMois[], sansStock: boolean, mois: string): number | null {
  const saisi = stocks.find((s) => s.mois === mois);
  if (saisi) return saisi.valeur;
  // Société déclarée sans stock (et aucun stock saisi) : un stock nul est une donnée, pas un manque.
  return sansStock && stocks.length === 0 ? 0 : null;
}

export function situationBfrDuMois(sources: SourcesBfr, mois: string): SituationBfr {
  return situationBfr({
    factures: sources.factures,
    date: finDeMois(mois),
    stock: stockBfrDuMois(sources.stocks, sources.sansStock, mois),
    synchroniseLe: sources.synchroniseLe,
  });
}

export function valideeDuMois(validees: SituationValidee[], mois: string): SituationValidee | null {
  return validees.find((v) => v.date === finDeMois(mois)) ?? null;
}

export interface LectureBfr {
  situation: SituationBfr;
  validee: SituationValidee | null;
  statut: StatutBfr;
  // Photographie validée si elle existe, sinon le calcul complet ; null si incomplet.
  totaux: TotauxBfr | null;
  // Factures exclues du chiffre retenu (celles de la photographie si elle est validée).
  facturesExclues: FactureIncertaine[];
}

export function lectureBfrDuMois(sources: SourcesBfr, mois: string): LectureBfr {
  const situation = situationBfrDuMois(sources, mois);
  const validee = valideeDuMois(sources.validees, mois);
  return {
    situation,
    validee,
    statut: statutBfr(situation, validee),
    totaux: totauxRetenus(situation, validee),
    facturesExclues: facturesExcluesRetenues(situation, validee),
  };
}

// Délai d'une cohorte mensuelle tel que le KPI du mois l'affiche (null : aucune facture réglée).
export interface DelaiDuPoint {
  moyen: number | null;
  ecartEcheance: number | null;
  reglees: number;
  ouvertes: number;
  provisoire: boolean;
}

export interface PointBfr {
  mois: string;
  valeur: number | null;
  totaux: TotauxBfr | null;
  statut: StatutBfr;
  nombreExclues: number;
  // Délais réels de la cohorte du mois (factures émises ce mois-là), en jours ; null sans facture réglée.
  delaiClients: number | null;
  delaiFournisseurs: number | null;
  clients: DelaiDuPoint;
  fournisseurs: DelaiDuPoint;
}

export function delaiDuPoint(c: DelaisCohorte): DelaiDuPoint {
  return {
    moyen: c.delaiMoyen,
    ecartEcheance: c.ecartEcheanceMoyen,
    reglees: c.reglees.length,
    ouvertes: c.ouvertes.length,
    provisoire: c.statut === "provisoire",
  };
}

// Quels délais l'offre de l'organisation laisse voir (lib/offres.ts : canViewDSO, canViewDPO).
export interface DelaisVisibles {
  clients: boolean;
  fournisseurs: boolean;
}

const DELAI_MASQUE: DelaiDuPoint = { moyen: null, ecartEcheance: null, reglees: 0, ouvertes: 0, provisoire: false };

// Retire de l'évolution les délais hors offre (aucune valeur ne reste dans les points) ; le BFR est inchangé.
export function evolutionVisible(points: PointBfr[], visibles: DelaisVisibles): PointBfr[] {
  return points.map((p) => ({
    ...p,
    delaiClients: visibles.clients ? p.delaiClients : null,
    delaiFournisseurs: visibles.fournisseurs ? p.delaiFournisseurs : null,
    clients: visibles.clients ? p.clients : DELAI_MASQUE,
    fournisseurs: visibles.fournisseurs ? p.fournisseurs : DELAI_MASQUE,
  }));
}

/**
 * Évolution : les 12 derniers mois glissants jusqu'au mois donné — BFR (situation de fin de mois)
 * et délais clients / fournisseurs (cohorte du mois, même calcul que le KPI du mois). Un mois sans
 * valeur exploitable n'a pas de point (jamais 0, jamais interpolé).
 */
export function evolutionBfr(sources: SourcesBfr, mois: string, aujourdhui: string): PointBfr[] {
  return moisGlissants(mois).map((m) => {
    const { totaux, statut, facturesExclues } = lectureBfrDuMois(sources, m);
    const clients = delaisDuMois(sources.factures, "client", m, aujourdhui);
    const fournisseurs = delaisDuMois(sources.factures, "fournisseur", m, aujourdhui);
    return {
      mois: m,
      valeur: totaux?.bfr ?? null,
      totaux,
      statut,
      nombreExclues: facturesExclues.length,
      delaiClients: clients.delaiMoyen,
      delaiFournisseurs: fournisseurs.delaiMoyen,
      clients: delaiDuPoint(clients),
      fournisseurs: delaiDuPoint(fournisseurs),
    };
  });
}
