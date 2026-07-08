import {
  AutreDepense,
  ChargeFixe,
  FactureClient,
  FactureFournisseur,
  Financement,
  RentreeReguliere,
  SoldeJournalier,
} from "./types";
import { ajouterJours, ajouterMois, estDateValide, parseDateISO, toISODate } from "./dates";

export const HORIZON_JOURS_DEFAUT = 90;

export interface ParametresProjectionCash {
  soldeInitial: number;
  facturesClients: FactureClient[];
  facturesFournisseurs: FactureFournisseur[];
  chargesFixes: ChargeFixe[];
  autresDepenses: AutreDepense[];
  financements: Financement[];
  rentreesRegulieres: RentreeReguliere[];
  dateDepart: string; // YYYY-MM-DD
  horizonJours?: number;
}

export interface ResultatProjectionCash {
  serie: SoldeJournalier[];
  soldeJ90: number;
  pointBas: number;
  dateDuPointBas: string;
  datePassageSousZero: string | null;
}

type FrequenceRecurrence = ChargeFixe["recurrence"] | RentreeReguliere["frequence"];

function genererOccurrencesRecurrentes(
  dateDebut: string,
  frequence: FrequenceRecurrence,
  dateFin: string | null,
  fin: Date
): Date[] {
  if (!estDateValide(dateDebut)) return [];

  const debut = parseDateISO(dateDebut);
  if (frequence === "ponctuel") return [debut];

  const borneFin = dateFin && parseDateISO(dateFin) < fin ? parseDateISO(dateFin) : fin;
  const pas =
    frequence === "quotidien"
      ? (d: Date) => ajouterJours(d, 1)
      : frequence === "hebdomadaire"
        ? (d: Date) => ajouterJours(d, 7)
        : (d: Date) => ajouterMois(d, 1);

  const occurrences: Date[] = [];
  let curseur = debut;
  while (curseur <= borneFin) {
    occurrences.push(curseur);
    curseur = pas(curseur);
  }
  return occurrences;
}

export function calculerProjectionCash(params: ParametresProjectionCash): ResultatProjectionCash {
  const {
    soldeInitial,
    facturesClients,
    facturesFournisseurs,
    chargesFixes,
    autresDepenses,
    financements,
    rentreesRegulieres,
    dateDepart,
    horizonJours = HORIZON_JOURS_DEFAUT,
  } = params;

  const debut = parseDateISO(dateDepart);
  const fin = ajouterJours(debut, horizonJours);

  const fluxParDate = new Map<string, number>();

  const enregistrerFlux = (dateStr: string, montant: number) => {
    // Une ligne sans date (nouvellement ajoutée, pas encore complétée par l'utilisateur)
    // ne doit jamais entrer dans le calcul, et ne doit jamais faire planter le moteur.
    if (!estDateValide(dateStr)) return;
    const date = parseDateISO(dateStr);
    if (date < debut || date > fin) return;
    const cle = toISODate(date);
    fluxParDate.set(cle, (fluxParDate.get(cle) ?? 0) + montant);
  };

  for (const facture of facturesClients) {
    if (facture.litigieuse || facture.payee) continue;
    enregistrerFlux(facture.dateEncaissementAnticipee, facture.montant);
  }

  for (const facture of facturesFournisseurs) {
    if (facture.litigieuse || facture.payee) continue;
    enregistrerFlux(facture.datePaiementPrevue, -facture.montant);
  }

  for (const financement of financements) {
    enregistrerFlux(financement.dateEncaissementPrevue, financement.montant);
  }

  for (const charge of chargesFixes) {
    for (const occurrence of genererOccurrencesRecurrentes(charge.datePrevue, charge.recurrence, charge.dateFin, fin)) {
      enregistrerFlux(toISODate(occurrence), -charge.montant);
    }
  }

  for (const depense of autresDepenses) {
    enregistrerFlux(depense.datePrevue, -depense.montant);
  }

  for (const rentree of rentreesRegulieres) {
    for (const occurrence of genererOccurrencesRecurrentes(rentree.dateDebut, rentree.frequence, rentree.dateFin, fin)) {
      enregistrerFlux(toISODate(occurrence), rentree.montant);
    }
  }

  const serie: SoldeJournalier[] = [];
  let solde = soldeInitial;

  for (let i = 0; i <= horizonJours; i++) {
    const cle = toISODate(ajouterJours(debut, i));
    solde += fluxParDate.get(cle) ?? 0;
    serie.push({ date: cle, solde });
  }

  let pointBas = serie[0].solde;
  let dateDuPointBas = serie[0].date;
  let datePassageSousZero: string | null = null;

  for (const point of serie) {
    if (point.solde < pointBas) {
      pointBas = point.solde;
      dateDuPointBas = point.date;
    }
    if (datePassageSousZero === null && point.solde < 0) {
      datePassageSousZero = point.date;
    }
  }

  return {
    serie,
    soldeJ90: serie[serie.length - 1].solde,
    pointBas,
    dateDuPointBas,
    datePassageSousZero,
  };
}
