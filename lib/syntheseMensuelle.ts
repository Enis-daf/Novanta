import { genererOccurrencesRecurrentes } from "./cash-engine";
import { ajouterJours, estDateValide, parseDateISO } from "./dates";
import {
  AutreDepense,
  ChargeFixe,
  FactureClient,
  FactureFournisseur,
  Financement,
  RentreeReguliere,
} from "./types";

export interface MoisSynthese {
  cle: string; // "2026-08"
  libelle: string; // "Août"
}

export interface LigneSynthese {
  libelle: string;
  montantsParMois: number[]; // aligné avec ResultatSyntheseMensuelle.mois
  total: number;
}

export interface ResultatSyntheseMensuelle {
  mois: MoisSynthese[];
  lignes: LigneSynthese[];
}

export interface ParametresSyntheseMensuelle {
  dateReleve: string;
  horizonJours: number;
  facturesClients: FactureClient[];
  facturesFournisseurs: FactureFournisseur[];
  chargesFixes: ChargeFixe[];
  autresDepenses: AutreDepense[];
  financements: Financement[];
  rentreesRegulieres: RentreeReguliere[];
}

const NOMS_MOIS_COURTS = [
  "Janv.",
  "Févr.",
  "Mars",
  "Avr.",
  "Mai",
  "Juin",
  "Juil.",
  "Août",
  "Sept.",
  "Oct.",
  "Nov.",
  "Déc.",
];

interface Occurrence {
  date: Date;
  montant: number;
}

function clefMois(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function moisCouverts(debut: Date, fin: Date): MoisSynthese[] {
  const mois: MoisSynthese[] = [];
  let curseur = new Date(debut.getFullYear(), debut.getMonth(), 1);
  const dernierMois = new Date(fin.getFullYear(), fin.getMonth(), 1);
  while (curseur <= dernierMois) {
    mois.push({ cle: clefMois(curseur), libelle: NOMS_MOIS_COURTS[curseur.getMonth()] });
    curseur = new Date(curseur.getFullYear(), curseur.getMonth() + 1, 1);
  }
  return mois;
}

function dansHorizon(date: Date, debut: Date, fin: Date): boolean {
  return date >= debut && date <= fin;
}

function agreger(occurrences: Occurrence[], mois: MoisSynthese[]): LigneSynthese["montantsParMois"] {
  const parCle = new Map<string, number>();
  for (const { date, montant } of occurrences) {
    const cle = clefMois(date);
    parCle.set(cle, (parCle.get(cle) ?? 0) + montant);
  }
  return mois.map((m) => parCle.get(m.cle) ?? 0);
}

function ligne(libelle: string, occurrences: Occurrence[], mois: MoisSynthese[]): LigneSynthese {
  const montantsParMois = agreger(occurrences, mois);
  const total = montantsParMois.reduce((acc, v) => acc + v, 0);
  return { libelle, montantsParMois, total };
}

function occurrencesFacturesClients(factures: FactureClient[], debut: Date, fin: Date): Occurrence[] {
  const res: Occurrence[] = [];
  for (const f of factures) {
    if (f.litigieuse || f.payee) continue;
    if (!estDateValide(f.dateEncaissementAnticipee)) continue;
    const date = parseDateISO(f.dateEncaissementAnticipee);
    if (!dansHorizon(date, debut, fin)) continue;
    res.push({ date, montant: f.montant });
  }
  return res;
}

function occurrencesFacturesFournisseurs(factures: FactureFournisseur[], debut: Date, fin: Date): Occurrence[] {
  const res: Occurrence[] = [];
  for (const f of factures) {
    if (f.litigieuse || f.payee) continue;
    if (!estDateValide(f.datePaiementPrevue)) continue;
    const date = parseDateISO(f.datePaiementPrevue);
    if (!dansHorizon(date, debut, fin)) continue;
    res.push({ date, montant: -f.montant });
  }
  return res;
}

function occurrencesFinancements(financements: Financement[], debut: Date, fin: Date): Occurrence[] {
  const res: Occurrence[] = [];
  for (const f of financements) {
    if (!estDateValide(f.dateEncaissementPrevue)) continue;
    const date = parseDateISO(f.dateEncaissementPrevue);
    if (!dansHorizon(date, debut, fin)) continue;
    res.push({ date, montant: f.montant });
  }
  return res;
}

function occurrencesAutresDepenses(depenses: AutreDepense[], debut: Date, fin: Date): Occurrence[] {
  const res: Occurrence[] = [];
  for (const d of depenses) {
    if (!estDateValide(d.datePrevue)) continue;
    const date = parseDateISO(d.datePrevue);
    if (!dansHorizon(date, debut, fin)) continue;
    res.push({ date, montant: -d.montant });
  }
  return res;
}

function occurrencesRentreesRegulieres(rentrees: RentreeReguliere[], debut: Date, fin: Date): Occurrence[] {
  const res: Occurrence[] = [];
  for (const r of rentrees) {
    for (const occ of genererOccurrencesRecurrentes(r.dateDebut, r.frequence, r.dateFin, fin)) {
      if (!dansHorizon(occ, debut, fin)) continue;
      res.push({ date: occ, montant: r.montant });
    }
  }
  return res;
}

function occurrencesChargesFixes(charges: ChargeFixe[], debut: Date, fin: Date): Occurrence[] {
  const res: Occurrence[] = [];
  for (const c of charges) {
    for (const occ of genererOccurrencesRecurrentes(c.datePrevue, c.recurrence, c.dateFin, fin)) {
      if (!dansHorizon(occ, debut, fin)) continue;
      res.push({ date: occ, montant: -c.montant });
    }
  }
  return res;
}

/**
 * Synthèse mensuelle en lecture seule, calculée côté interface à partir des mêmes
 * données que le moteur de calcul, mais indépendamment de celui-ci (aucun effet sur
 * calculerProjectionCash, les KPIs ou la courbe).
 */
export function calculerSyntheseMensuelle(params: ParametresSyntheseMensuelle): ResultatSyntheseMensuelle {
  const {
    dateReleve,
    horizonJours,
    facturesClients,
    facturesFournisseurs,
    chargesFixes,
    autresDepenses,
    financements,
    rentreesRegulieres,
  } = params;

  if (!estDateValide(dateReleve)) {
    return { mois: [], lignes: [] };
  }

  const debut = parseDateISO(dateReleve);
  const fin = ajouterJours(debut, horizonJours);
  const mois = moisCouverts(debut, fin);

  const lignes: LigneSynthese[] = [
    ligne("Factures clients", occurrencesFacturesClients(facturesClients, debut, fin), mois),
    ligne("Rentrées régulières", occurrencesRentreesRegulieres(rentreesRegulieres, debut, fin), mois),
    ligne("Financements", occurrencesFinancements(financements, debut, fin), mois),
    ligne("Factures fournisseurs", occurrencesFacturesFournisseurs(facturesFournisseurs, debut, fin), mois),
    ligne("Charges fixes", occurrencesChargesFixes(chargesFixes, debut, fin), mois),
    ligne("Autres dépenses", occurrencesAutresDepenses(autresDepenses, debut, fin), mois),
  ];

  return { mois, lignes };
}
