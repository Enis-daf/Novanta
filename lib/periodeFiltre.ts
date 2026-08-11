import { genererOccurrencesRecurrentes } from "./cash-engine";
import { ajouterJours, estDateValide, parseDateISO, toISODate } from "./dates";
import { montantEffectifChargeFixe } from "./montantCalcule";
import {
  AutreDepense,
  ChargeFixe,
  FactureClient,
  FactureFournisseur,
  Financement,
  RentreeReguliere,
} from "./types";

export interface PeriodeFiltre {
  dateClic: string; // YYYY-MM-DD
  debut: string; // YYYY-MM-DD
  fin: string; // YYYY-MM-DD
}

const JOURS_AVANT_APRES = 3;

/**
 * Calcule la fenêtre D-3..D+3 autour de la date cliquée sur la courbe, bornée à
 * l'horizon (jamais avant la date du relevé, jamais après la fin d'horizon).
 * Retourne null si la date cliquée ou la date du relevé est invalide.
 */
export function calculerPeriodeFiltre(
  dateClic: string,
  dateReleve: string,
  horizonJours: number
): PeriodeFiltre | null {
  if (!estDateValide(dateClic) || !estDateValide(dateReleve)) return null;

  const debutHorizon = parseDateISO(dateReleve);
  const finHorizon = ajouterJours(debutHorizon, horizonJours);
  const clic = parseDateISO(dateClic);

  let debut = ajouterJours(clic, -JOURS_AVANT_APRES);
  let fin = ajouterJours(clic, JOURS_AVANT_APRES);
  if (debut < debutHorizon) debut = debutHorizon;
  if (fin > finHorizon) fin = finHorizon;
  if (debut > fin) return null;

  return { dateClic, debut: toISODate(debut), fin: toISODate(fin) };
}

function dansPeriode(date: Date, debut: Date, fin: Date): boolean {
  return date >= debut && date <= fin;
}

/** id -> dates ISO des occurrences de cette ligne tombant dans la période. */
export type OccurrencesParId = Map<string, string[]>;

interface ResultatCategorie {
  parId: OccurrencesParId;
  totalSigne: number;
}

function itemSimple<T extends { id: string; montant: number }>(
  items: T[],
  dateDe: (item: T) => string,
  signe: 1 | -1,
  exclu: (item: T) => boolean,
  debut: Date,
  fin: Date
): ResultatCategorie {
  const parId: OccurrencesParId = new Map();
  let totalSigne = 0;
  for (const item of items) {
    if (exclu(item)) continue;
    const dateStr = dateDe(item);
    if (!estDateValide(dateStr)) continue;
    const date = parseDateISO(dateStr);
    if (!dansPeriode(date, debut, fin)) continue;
    parId.set(item.id, [dateStr]);
    totalSigne += signe * item.montant;
  }
  return { parId, totalSigne };
}

function itemRecurrent<T extends { id: string }>(
  items: T[],
  dateDebutDe: (item: T) => string,
  frequenceDe: (item: T) => Parameters<typeof genererOccurrencesRecurrentes>[1],
  dateFinDe: (item: T) => string | null,
  montantDe: (item: T) => number | null,
  signe: 1 | -1,
  debut: Date,
  fin: Date
): ResultatCategorie {
  const parId: OccurrencesParId = new Map();
  let totalSigne = 0;
  for (const item of items) {
    const occurrences = genererOccurrencesRecurrentes(
      dateDebutDe(item),
      frequenceDe(item),
      dateFinDe(item),
      fin
    ).filter((d) => dansPeriode(d, debut, fin));
    if (occurrences.length === 0) continue;
    parId.set(item.id, occurrences.map(toISODate));
    const montant = montantDe(item);
    if (montant === null) continue; // source indisponible : occurrences affichées, montant exclu du résumé
    totalSigne += signe * montant * occurrences.length;
  }
  return { parId, totalSigne };
}

export interface ResumePeriode {
  entrees: number;
  sorties: number;
  net: number;
}

export interface ResultatFluxPeriode {
  resume: ResumePeriode;
  idsFacturesClients: OccurrencesParId;
  idsFacturesFournisseurs: OccurrencesParId;
  idsAutresDepenses: OccurrencesParId;
  idsFinancements: OccurrencesParId;
  occurrencesChargesFixes: OccurrencesParId;
  occurrencesRentreesRegulieres: OccurrencesParId;
}

export interface ParametresFluxPeriode {
  debut: string; // YYYY-MM-DD
  fin: string; // YYYY-MM-DD
  facturesClients: FactureClient[];
  facturesFournisseurs: FactureFournisseur[];
  chargesFixes: ChargeFixe[];
  autresDepenses: AutreDepense[];
  financements: Financement[];
  rentreesRegulieres: RentreeReguliere[];
}

/**
 * Calcule, pour la fenêtre [debut, fin], les lignes qui contribuent réellement au
 * mouvement de trésorerie (mêmes règles d'exclusion que le moteur de calcul : pas de
 * facture payée/litigieuse, pas de ligne sans date). Purement pour l'affichage —
 * n'affecte jamais calculerProjectionCash, les KPIs ou la courbe.
 */
export function calculerFluxPeriode(params: ParametresFluxPeriode): ResultatFluxPeriode {
  const debut = parseDateISO(params.debut);
  const fin = parseDateISO(params.fin);

  const facturesClientsRes = itemSimple(
    params.facturesClients,
    (f) => f.dateEncaissementAnticipee,
    1,
    (f) => f.litigieuse || f.payee,
    debut,
    fin
  );
  const facturesFournisseursRes = itemSimple(
    params.facturesFournisseurs,
    (f) => f.datePaiementPrevue,
    -1,
    (f) => f.litigieuse || f.payee,
    debut,
    fin
  );
  const autresDepensesRes = itemSimple(
    params.autresDepenses,
    (d) => d.datePrevue,
    -1,
    (d) => d.facturee,
    debut,
    fin
  );
  const financementsRes = itemSimple(
    params.financements,
    (f) => f.dateEncaissementPrevue,
    1,
    (f) => f.verse,
    debut,
    fin
  );
  const chargesFixesRes = itemRecurrent(
    params.chargesFixes,
    (c) => c.datePrevue,
    (c) => c.recurrence,
    (c) => c.dateFin,
    (c) => montantEffectifChargeFixe(c, params.chargesFixes, params.rentreesRegulieres),
    -1,
    debut,
    fin
  );
  const rentreesRegulieresRes = itemRecurrent(
    params.rentreesRegulieres,
    (r) => r.dateDebut,
    (r) => r.frequence,
    (r) => r.dateFin,
    (r) => r.montant,
    1,
    debut,
    fin
  );

  const entrees = facturesClientsRes.totalSigne + financementsRes.totalSigne + rentreesRegulieresRes.totalSigne;
  const sorties = facturesFournisseursRes.totalSigne + chargesFixesRes.totalSigne + autresDepensesRes.totalSigne;

  return {
    resume: { entrees, sorties, net: entrees + sorties },
    idsFacturesClients: facturesClientsRes.parId,
    idsFacturesFournisseurs: facturesFournisseursRes.parId,
    idsAutresDepenses: autresDepensesRes.parId,
    idsFinancements: financementsRes.parId,
    occurrencesChargesFixes: chargesFixesRes.parId,
    occurrencesRentreesRegulieres: rentreesRegulieresRes.parId,
  };
}
