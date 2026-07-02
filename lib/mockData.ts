import {
  AutreDepense,
  ChargeFixe,
  FactureClient,
  FactureFournisseur,
  Financement,
  RentreeReguliere,
} from "./types";
import { toISODate } from "./dates";

function addDays(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

const today = new Date();

export const SOLDE_BANCAIRE_INITIAL = 45000;

export const mockFacturesClients: FactureClient[] = [
  {
    id: "fc-1",
    facture: "FC-2026-101",
    client: "Atlas Industries",
    montant: 18500,
    dateEcheance: addDays(today, 5),
    dateEncaissementAnticipee: addDays(today, 5),
    litigieuse: false,
  },
  {
    id: "fc-2",
    facture: "FC-2026-102",
    client: "Nova Retail",
    montant: 9200,
    dateEcheance: addDays(today, 12),
    dateEncaissementAnticipee: addDays(today, 12),
    litigieuse: false,
  },
  {
    id: "fc-3",
    facture: "FC-2026-103",
    client: "Orion Santé",
    montant: 27600,
    dateEcheance: addDays(today, 20),
    dateEncaissementAnticipee: addDays(today, 20),
    litigieuse: false,
  },
  {
    id: "fc-4",
    facture: "FC-2026-104",
    client: "Delta Logistique",
    montant: 6400,
    dateEcheance: addDays(today, 25),
    dateEncaissementAnticipee: addDays(today, 25),
    litigieuse: true,
  },
  {
    id: "fc-5",
    facture: "FC-2026-105",
    client: "Cristal BTP",
    montant: 14300,
    dateEcheance: addDays(today, 35),
    dateEncaissementAnticipee: addDays(today, 35),
    litigieuse: false,
  },
  {
    id: "fc-6",
    facture: "FC-2026-106",
    client: "Solstice Group",
    montant: 21000,
    dateEcheance: addDays(today, 48),
    dateEncaissementAnticipee: addDays(today, 48),
    litigieuse: false,
  },
  {
    id: "fc-7",
    facture: "FC-2026-107",
    client: "Atlas Industries",
    montant: 11800,
    dateEcheance: addDays(today, 60),
    dateEncaissementAnticipee: addDays(today, 60),
    litigieuse: false,
  },
  {
    id: "fc-8",
    facture: "FC-2026-108",
    client: "Nova Retail",
    montant: 8700,
    dateEcheance: addDays(today, 75),
    dateEncaissementAnticipee: addDays(today, 75),
    litigieuse: false,
  },
];

export const mockFacturesFournisseurs: FactureFournisseur[] = [
  {
    id: "ff-1",
    facture: "FF-2026-201",
    fournisseur: "MatPro SARL",
    montant: 12400,
    dateEcheance: addDays(today, 3),
    datePaiementPrevue: addDays(today, 3),
    litigieuse: false,
  },
  {
    id: "ff-2",
    facture: "FF-2026-202",
    fournisseur: "TransExpress",
    montant: 7600,
    dateEcheance: addDays(today, 8),
    datePaiementPrevue: addDays(today, 8),
    litigieuse: false,
  },
  {
    id: "ff-3",
    facture: "FF-2026-203",
    fournisseur: "Bureau Plus",
    montant: 3200,
    dateEcheance: addDays(today, 15),
    datePaiementPrevue: addDays(today, 15),
    litigieuse: false,
  },
  {
    id: "ff-4",
    facture: "FF-2026-204",
    fournisseur: "Energis",
    montant: 15900,
    dateEcheance: addDays(today, 18),
    datePaiementPrevue: addDays(today, 18),
    litigieuse: false,
  },
  {
    id: "ff-5",
    facture: "FF-2026-205",
    fournisseur: "Composants Ouest",
    montant: 22000,
    dateEcheance: addDays(today, 30),
    datePaiementPrevue: addDays(today, 30),
    litigieuse: true,
  },
  {
    id: "ff-6",
    facture: "FF-2026-206",
    fournisseur: "MatPro SARL",
    montant: 9800,
    dateEcheance: addDays(today, 42),
    datePaiementPrevue: addDays(today, 42),
    litigieuse: false,
  },
  {
    id: "ff-7",
    facture: "FF-2026-207",
    fournisseur: "TransExpress",
    montant: 6100,
    dateEcheance: addDays(today, 55),
    datePaiementPrevue: addDays(today, 55),
    litigieuse: false,
  },
  {
    id: "ff-8",
    facture: "FF-2026-208",
    fournisseur: "Energis",
    montant: 16500,
    dateEcheance: addDays(today, 70),
    datePaiementPrevue: addDays(today, 70),
    litigieuse: false,
  },
];

export const mockChargesFixes: ChargeFixe[] = [
  {
    id: "cf-1",
    libelle: "Loyer bureaux",
    montant: 4200,
    datePrevue: addDays(today, 1),
    recurrence: "mensuelle",
  },
  {
    id: "cf-2",
    libelle: "Salaires équipe",
    montant: 32000,
    datePrevue: addDays(today, 2),
    recurrence: "mensuelle",
  },
  {
    id: "cf-3",
    libelle: "Charges sociales",
    montant: 11500,
    datePrevue: addDays(today, 5),
    recurrence: "mensuelle",
  },
  {
    id: "cf-4",
    libelle: "Assurance locaux",
    montant: 1800,
    datePrevue: addDays(today, 40),
    recurrence: "aucune",
  },
];

export const mockAutresDepenses: AutreDepense[] = [
  {
    id: "ad-1",
    libelle: "Réparation véhicule utilitaire",
    montant: 2200,
    datePrevue: addDays(today, 10),
    type: "certaine",
  },
  {
    id: "ad-2",
    libelle: "Prime exceptionnelle équipe",
    montant: 5000,
    datePrevue: addDays(today, 50),
    type: "probable",
  },
];

export const mockFinancements: Financement[] = [
  {
    id: "fi-1",
    libelle: "Avance associé",
    montant: 15000,
    dateEncaissementPrevue: addDays(today, 15),
  },
];

export const mockRentreesRegulieres: RentreeReguliere[] = [
  {
    id: "rr-1",
    libelle: "Ventes boutique en ligne moyennes",
    montant: 450,
    dateDebut: addDays(today, 1),
    frequence: "quotidien",
    dateFin: null,
  },
  {
    id: "rr-2",
    libelle: "Loyer encaissé (local commercial)",
    montant: 1800,
    dateDebut: addDays(today, 15),
    frequence: "mensuel",
    dateFin: null,
  },
];
