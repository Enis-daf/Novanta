import { genererOccurrencesRecurrentes } from "./cash-engine";
import { ajouterJours, ajouterMois, estDateValide, parseDateISO } from "./dates";
import { montantOccurrenceChargeFixe } from "./montantCalcule";
import { montantOccurrenceRentreeReguliere } from "./saisonnalite";
import {
  AutreDepense,
  ChargeFixe,
  FactureClient,
  FactureFournisseur,
  Financement,
  RentreeReguliere,
} from "./types";

export interface MoisControle {
  cle: string; // "2026-05"
  libelle: string; // "Mai 2026"
}

export interface TotauxMoisControle {
  entrees: number;
  sorties: number;
  net: number;
}

export interface ResultatControleMensuel {
  mois: MoisControle[];
  totauxParMois: TotauxMoisControle[];
}

export interface ParametresControleMensuel {
  facturesClients: FactureClient[];
  facturesFournisseurs: FactureFournisseur[];
  chargesFixes: ChargeFixe[];
  autresDepenses: AutreDepense[];
  financements: Financement[];
  rentreesRegulieres: RentreeReguliere[];
}

const NOMS_MOIS = [
  "Janvier",
  "Février",
  "Mars",
  "Avril",
  "Mai",
  "Juin",
  "Juillet",
  "Août",
  "Septembre",
  "Octobre",
  "Novembre",
  "Décembre",
];

function clefMois(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function premierJourMois(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Les 3 derniers mois calendaires complets écoulés avant le mois en cours
 * (indépendant de la date du relevé et de l'horizon sélectionné).
 */
export function calculerTroisDerniersMoisComplets(maintenant: Date): { debut: Date; fin: Date; mois: MoisControle[] } {
  const premierJourMoisCourant = premierJourMois(maintenant);
  const debut = ajouterMois(premierJourMoisCourant, -3);
  const fin = ajouterJours(premierJourMoisCourant, -1); // dernier jour du mois précédent

  const mois: MoisControle[] = [];
  let curseur = debut;
  for (let i = 0; i < 3; i += 1) {
    mois.push({ cle: clefMois(curseur), libelle: `${NOMS_MOIS[curseur.getMonth()]} ${curseur.getFullYear()}` });
    curseur = ajouterMois(curseur, 1);
  }

  return { debut, fin, mois };
}

function dansPeriode(date: Date, debut: Date, fin: Date): boolean {
  return date >= debut && date <= fin;
}

function ajouterAuMois(totaux: Map<string, TotauxMoisControle>, date: Date, montant: number, sens: "entree" | "sortie") {
  const cle = clefMois(date);
  const courant = totaux.get(cle) ?? { entrees: 0, sorties: 0, net: 0 };
  if (sens === "entree") courant.entrees += montant;
  else courant.sorties -= montant;
  courant.net = courant.entrees + courant.sorties;
  totaux.set(cle, courant);
}

/**
 * Contrôle mensuel : totaux Novanta en lecture seule pour les 3 derniers mois calendaires
 * complets, à comparer manuellement par l'utilisateur avec ses relevés bancaires. Calculé
 * indépendamment de calculerProjectionCash et calculerSyntheseMensuelle — n'affecte jamais
 * les KPIs, la courbe, la synthèse mensuelle ou le prévisionnel.
 *
 * Contrairement au prévisionnel, les factures cochées "Payée" sont incluses ici : sur un
 * mois écoulé, une facture payée est un mouvement réel qui doit apparaître dans le total à
 * comparer avec le relevé bancaire. Seule l'exclusion "Litigieuse" (montant incertain) reste.
 */
export function calculerControleMensuel(
  params: ParametresControleMensuel,
  maintenant: Date = new Date()
): ResultatControleMensuel {
  const { debut, fin, mois } = calculerTroisDerniersMoisComplets(maintenant);
  const totaux = new Map<string, TotauxMoisControle>();

  for (const f of params.facturesClients) {
    if (f.litigieuse) continue;
    if (!estDateValide(f.dateEncaissementAnticipee)) continue;
    const date = parseDateISO(f.dateEncaissementAnticipee);
    if (!dansPeriode(date, debut, fin)) continue;
    ajouterAuMois(totaux, date, f.montant, "entree");
  }

  for (const f of params.financements) {
    if (!estDateValide(f.dateEncaissementPrevue)) continue;
    const date = parseDateISO(f.dateEncaissementPrevue);
    if (!dansPeriode(date, debut, fin)) continue;
    ajouterAuMois(totaux, date, f.montant, "entree");
  }

  for (const r of params.rentreesRegulieres) {
    for (const occ of genererOccurrencesRecurrentes(r.dateDebut, r.frequence, r.dateFin, fin)) {
      if (!dansPeriode(occ, debut, fin)) continue;
      const montant = montantOccurrenceRentreeReguliere(r, occ);
      if (montant === null) continue; // profil de saisonnalité indisponible : occurrence exclue
      ajouterAuMois(totaux, occ, montant, "entree");
    }
  }

  for (const f of params.facturesFournisseurs) {
    if (f.litigieuse) continue;
    if (!estDateValide(f.datePaiementPrevue)) continue;
    const date = parseDateISO(f.datePaiementPrevue);
    if (!dansPeriode(date, debut, fin)) continue;
    ajouterAuMois(totaux, date, f.montant, "sortie");
  }

  for (const c of params.chargesFixes) {
    const occurrencesCharge = genererOccurrencesRecurrentes(c.datePrevue, c.recurrence, c.dateFin, fin);
    occurrencesCharge.forEach((occ, index) => {
      if (!dansPeriode(occ, debut, fin)) return;
      const precedente = index > 0 ? occurrencesCharge[index - 1] : null;
      const montant = montantOccurrenceChargeFixe(c, occ, precedente, params.chargesFixes, params.rentreesRegulieres, fin);
      if (montant === null) return; // source indisponible : occurrence exclue
      ajouterAuMois(totaux, occ, montant, "sortie");
    });
  }

  for (const d of params.autresDepenses) {
    if (!estDateValide(d.datePrevue)) continue;
    const date = parseDateISO(d.datePrevue);
    if (!dansPeriode(date, debut, fin)) continue;
    ajouterAuMois(totaux, date, d.montant, "sortie");
  }

  const totauxParMois = mois.map((m) => totaux.get(m.cle) ?? { entrees: 0, sorties: 0, net: 0 });

  return { mois, totauxParMois };
}
