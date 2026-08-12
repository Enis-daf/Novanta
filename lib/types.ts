export interface FactureClient {
  id: string;
  facture: string;
  client: string;
  montant: number;
  dateEcheance: string; // YYYY-MM-DD
  dateEncaissementAnticipee: string; // YYYY-MM-DD — variable de simulation
  litigieuse: boolean;
  payee: boolean;
  paidAt: string | null; // ISO 8601 datetime — moment où "Payée" a été cochée
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
  paidAt: string | null; // ISO 8601 datetime — moment où "Payée" a été cochée
}

export type ModeMontantChargeFixe = "fixe" | "calcule";

export type TypeSourceCalculChargeFixe = "charge_fixe" | "rentree_reguliere";

export interface ChargeFixe {
  id: string;
  libelle: string;
  montant: number; // montant fixe en mode "fixe" ; en mode "calcule", dernière valeur connue seulement — jamais lue par le moteur, voir lib/montantCalcule.ts
  datePrevue: string; // YYYY-MM-DD — première échéance
  recurrence: "ponctuel" | "quotidien" | "hebdomadaire" | "mensuel";
  dateFin: string | null; // YYYY-MM-DD — optionnelle, sinon jusqu'à J+90
  modeMontant: ModeMontantChargeFixe;
  tauxCalcul: number | null; // % — non nul uniquement en mode "calcule"
  sourceCalculId: string | null; // id de la ligne source (ChargeFixe non calculée ou RentreeReguliere)
  sourceCalculType: TypeSourceCalculChargeFixe | null;
}

export interface AutreDepense {
  id: string;
  libelle: string;
  montant: number;
  datePrevue: string; // YYYY-MM-DD
  type: "certaine" | "probable";
  facturee: boolean; // true = remplacée par une vraie facture fournisseur, exclue du calcul
}

export interface Financement {
  id: string;
  libelle: string;
  montant: number;
  dateEncaissementPrevue: string; // YYYY-MM-DD
  verse: boolean; // true = effectivement versé sur le compte, exclu du calcul (libellé UI : "Versé")
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

export type TriMode = "date" | "montant";
