import { FactureBfr } from "./pastBfr";
import { CoteDelai, delaisDeLaCohorte, joursEntre } from "./pastBfrDelais";

/**
 * Prévision probabiliste — 1. Collecte et préparation de l'historique des retards de paiement.
 * Fonctions pures. Chaque compte n'est calibré QUE sur ses propres factures : l'appelant ne fournit
 * jamais que les factures de l'organisation de l'utilisateur connecté.
 *
 *   retard = max(0, date de règlement − date d'échéance), en jours calendaires.
 *
 * Un paiement anticipé compte comme « à l'heure » (retard 0), jamais comme un retard négatif.
 *
 * Deux sources, dédoublonnées par identifiant Pennylane :
 *  - les factures Pennylane du module Passé (past_bfr_invoices), selon les règles du délai réel de
 *    l'onglet BFR (lib/pastBfrDelais.ts) : facture soldée, date de règlement = dernière transaction
 *    bancaire rapprochée, avoirs déduits, factures annulées / archivées / sans date écartées ;
 *  - les factures de Futur cochées « Payée » dont le règlement réel est connu (settled_on, écrit
 *    par le rapprochement Pennylane) — jamais la date où la case a été cochée.
 * Une facture sans échéance ne dit rien d'un retard : elle est écartée.
 */

export type CoteRetard = CoteDelai; // "client" (encaissements) | "fournisseur" (décaissements)

export interface ObservationRetard {
  cote: CoteRetard;
  tiers: string; // libellé tel que lu
  cleTiers: string; // libellé normalisé : regroupe les factures d'un même tiers
  montant: number; // TTC, > 0 — sert au segment (taille de facture)
  echeance: string; // YYYY-MM-DD
  dateReglement: string; // YYYY-MM-DD
  retard: number; // jours, ≥ 0
}

/** Clé d'un tiers : casse, accents, ponctuation et espaces neutralisés. */
export function cleTiers(libelle: string): string {
  return libelle
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function retardObserve(echeance: string, dateReglement: string): number {
  return Math.max(0, joursEntre(echeance, dateReglement));
}

/** Factures Pennylane réglées (module Passé) -> observations, mêmes règles que le délai réel du BFR. */
export function observationsDepuisFacturesPennylane(factures: FactureBfr[], cote: CoteRetard, aujourdhui: string): ObservationRetard[] {
  const parId = new Map(factures.map((f) => [f.pennylaneId, f]));
  const cohorte = delaisDeLaCohorte(factures, cote, { debut: "0000-01-01", fin: aujourdhui }, aujourdhui);
  const observations: ObservationRetard[] = [];
  for (const f of cohorte.reglees) {
    if (!f.echeance) continue;
    const source = parId.get(f.pennylaneId);
    const montant = source?.montantTtc ?? f.montantHt;
    if (!(montant > 0)) continue;
    observations.push({
      cote,
      tiers: f.tiers,
      cleTiers: cleTiers(f.tiers),
      montant,
      echeance: f.echeance,
      dateReglement: f.dateReglement,
      retard: retardObserve(f.echeance, f.dateReglement),
    });
  }
  return observations;
}

/** Facture de Futur payée, telle que lue en base (customer_invoices / supplier_invoices). */
export interface FacturePayeeFutur {
  tiers: string;
  montant: number;
  dateEcheance: string | null;
  settledOn: string | null;
  pennylaneId: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Observations des factures de Futur réglées, sauf celles déjà connues par Passé (même identifiant
 * Pennylane) : une facture n'est jamais comptée deux fois.
 */
export function observationsDepuisFacturesFutur(
  factures: FacturePayeeFutur[],
  cote: CoteRetard,
  dejaConnues: ReadonlySet<string>
): ObservationRetard[] {
  const observations: ObservationRetard[] = [];
  for (const f of factures) {
    if (f.pennylaneId && dejaConnues.has(f.pennylaneId)) continue;
    if (!f.dateEcheance || !f.settledOn || !DATE.test(f.dateEcheance) || !DATE.test(f.settledOn)) continue;
    if (!(f.montant > 0)) continue;
    observations.push({
      cote,
      tiers: f.tiers,
      cleTiers: cleTiers(f.tiers),
      montant: f.montant,
      echeance: f.dateEcheance,
      dateReglement: f.settledOn,
      retard: retardObserve(f.dateEcheance, f.settledOn),
    });
  }
  return observations;
}

export interface HistoriqueRetards {
  client: ObservationRetard[];
  fournisseur: ObservationRetard[];
}

/** Historique complet d'un compte, par côté. */
export function construireHistorique(
  facturesPennylane: FactureBfr[],
  futur: { clients: FacturePayeeFutur[]; fournisseurs: FacturePayeeFutur[] },
  aujourdhui: string
): HistoriqueRetards {
  const connues = new Set(facturesPennylane.map((f) => f.pennylaneId));
  return {
    client: [
      ...observationsDepuisFacturesPennylane(facturesPennylane, "client", aujourdhui),
      ...observationsDepuisFacturesFutur(futur.clients, "client", connues),
    ],
    fournisseur: [
      ...observationsDepuisFacturesPennylane(facturesPennylane, "fournisseur", aujourdhui),
      ...observationsDepuisFacturesFutur(futur.fournisseurs, "fournisseur", connues),
    ],
  };
}
