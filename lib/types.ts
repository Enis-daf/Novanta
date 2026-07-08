export interface FactureClient {
  id: string;
  facture: string;
  client: string;
  montant: number;
  dateEcheance: string; // YYYY-MM-DD
  dateEncaissementAnticipee: string; // YYYY-MM-DD — variable de simulation
  litigieuse: boolean;
  payee: boolean;
}

export interface FactureFournisseur {
  id: string;
  facture: string;
  fournisseur: string;
  montant: number;
  dateEcheance: string; // YYYY-MM-DD
  datePaiementPrevue: string; // YYYY-MM-DD — variable de simulation
  litigieuse: boolean;
  payee: boolean;
}

export interface ChargeFixe {
  id: string;
  libelle: string;
  montant: number;
  datePrevue: string; // YYYY-MM-DD — première échéance
  recurrence: "ponctuel" | "quotidien" | "hebdomadaire" | "mensuel";
  dateFin: string | null; // YYYY-MM-DD — optionnelle, sinon jusqu'à J+90
}

export interface AutreDepense {
  id: string;
  libelle: string;
  montant: number;
  datePrevue: string; // YYYY-MM-DD
  type: "certaine" | "probable";
}

export interface Financement {
  id: string;
  libelle: string;
  montant: number;
  dateEncaissementPrevue: string; // YYYY-MM-DD
}

export interface RentreeReguliere {
  id: string;
  libelle: string;
  montant: number;
  dateDebut: string; // YYYY-MM-DD
  frequence: "ponctuel" | "quotidien" | "mensuel";
  dateFin: string | null; // YYYY-MM-DD — optionnelle, sinon jusqu'à J+90
}

export interface SoldeJournalier {
  date: string; // YYYY-MM-DD
  solde: number;
}

export type HorizonJours = 90 | 180;
