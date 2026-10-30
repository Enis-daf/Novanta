import { LigneEcriture } from "./comptaPnl";
import { CompteSource } from "./comptaSource";

/**
 * Jeu de données SIMULÉ, déterministe, pour les tests et la page de démonstration. Aucune donnée
 * d'entreprise réelle, et aucune promesse sur ce que Pennylane renverra réellement.
 */
export const COMPTES_FIXTURES: CompteSource[] = [
  { idSource: "1", numero: "411000", libelle: "Clients", type: "asset", actif: true },
  { idSource: "2", numero: "401000", libelle: "Fournisseurs", type: "liability", actif: true },
  { idSource: "3", numero: "512000", libelle: "Banque", type: "asset", actif: true },
  { idSource: "4", numero: "445710", libelle: "TVA collectée", type: "liability", actif: true },
  { idSource: "5", numero: "706000", libelle: "Prestations de services", type: "revenue", actif: true },
  { idSource: "6", numero: "707000", libelle: "Ventes de marchandises", type: "revenue", actif: true },
  { idSource: "7", numero: "607000", libelle: "Achats de marchandises", type: "expense", actif: true },
  { idSource: "8", numero: "603700", libelle: "Variation de stock de marchandises", type: "expense", actif: true },
  { idSource: "9", numero: "624100", libelle: "Transports sur ventes", type: "expense", actif: true },
  { idSource: "10", numero: "613200", libelle: "Locations immobilières", type: "expense", actif: true },
  { idSource: "11", numero: "641100", libelle: "Salaires", type: "expense", actif: true },
  { idSource: "12", numero: "681120", libelle: "Dotations aux amortissements", type: "expense", actif: true },
  { idSource: "13", numero: "661100", libelle: "Intérêts d'emprunt", type: "expense", actif: true },
  { idSource: "14", numero: "695000", libelle: "Impôts sur les bénéfices", type: "expense", actif: true },
  { idSource: "15", numero: "489000", libelle: "Compte de bilan divers", type: "asset", actif: true },
  // Volontairement hors du modèle de correspondance : détection des comptes non affectés.
  { idSource: "16", numero: "780000", libelle: "Reprises diverses", type: "revenue", actif: true },
];

function ligne(compte: string, date: string, debit: number, credit: number): LigneEcriture {
  return { compte, date, debit, credit };
}

/** Trois mois d'activité : facture, avoir, extourne, comptes de bilan et un compte sans affectation. */
export const LIGNES_FIXTURES: LigneEcriture[] = [
  ligne("706000", "2026-01-31", 0, 60_000),
  ligne("707000", "2026-01-31", 0, 40_000),
  ligne("411000", "2026-01-31", 120_000, 0),
  ligne("445710", "2026-01-31", 0, 20_000),
  ligne("607000", "2026-01-31", 30_000, 0),
  ligne("401000", "2026-01-31", 0, 36_000),
  ligne("624100", "2026-01-31", 5_000, 0),
  ligne("613200", "2026-01-31", 4_000, 0),
  ligne("641100", "2026-01-31", 20_000, 0),
  ligne("681120", "2026-01-31", 2_000, 0),
  ligne("706000", "2026-02-28", 0, 70_000),
  ligne("707000", "2026-02-28", 0, 30_000),
  // Avoir client : un débit sur un compte de produit.
  ligne("707000", "2026-02-20", 2_500, 0),
  ligne("607000", "2026-02-28", 28_000, 0),
  ligne("624100", "2026-02-28", 4_500, 0),
  ligne("613200", "2026-02-28", 4_000, 0),
  ligne("641100", "2026-02-28", 20_000, 0),
  ligne("681120", "2026-02-28", 2_000, 0),
  ligne("661100", "2026-02-28", 800, 0),
  // Charge constatée puis extournée le mois suivant.
  ligne("613200", "2026-02-28", 1_000, 0),
  ligne("613200", "2026-03-01", 0, 1_000),
  ligne("706000", "2026-03-31", 0, 80_000),
  ligne("707000", "2026-03-31", 0, 35_000),
  ligne("607000", "2026-03-31", 32_000, 0),
  ligne("603700", "2026-03-31", 0, 3_000),
  ligne("624100", "2026-03-31", 5_500, 0),
  ligne("613200", "2026-03-31", 4_000, 0),
  ligne("641100", "2026-03-31", 21_000, 0),
  ligne("681120", "2026-03-31", 2_000, 0),
  ligne("661100", "2026-03-31", 800, 0),
  ligne("695000", "2026-03-31", 6_000, 0),
  ligne("780000", "2026-03-31", 0, 1_500),
  ligne("512000", "2026-03-31", 40_000, 40_000),
  ligne("489000", "2026-03-31", 500, 0),
];
