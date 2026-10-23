import {
  AutreDepense,
  ChargeFixe,
  FactureClient,
  FactureFournisseur,
  Financement,
  RentreeReguliere,
  SoldeJournalier,
} from "./types";
import { ajouterJours, estDateValide, genererOccurrencesRecurrentes, parseDateISO, toISODate } from "./dates";
import { montantOccurrenceChargeFixe } from "./montantCalcule";
import { montantOccurrenceRentreeReguliere } from "./saisonnalite";
import { estOccurrenceRemplacee, Remplacements } from "./remplacementsOccurrences";

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
  // Occurrences de Charges fixes remplacées par une facture fournisseur (rapprochement confirmé) :
  // elles ne génèrent aucun flux, la facture portant seule la dépense. Absent = aucun remplacement.
  remplacements?: Remplacements;
}

export interface ResultatProjectionCash {
  serie: SoldeJournalier[];
  soldeJ90: number;
  pointBas: number;
  dateDuPointBas: string;
  datePassageSousZero: string | null;
}

// Ré-exporté pour compatibilité : la génération d'occurrences vit désormais dans lib/dates.ts
// (déplacée pour éviter un import circulaire avec lib/montantCalcule.ts, qui en a aussi besoin).
export { genererOccurrencesRecurrentes };
export type { FrequenceRecurrence } from "./dates";

/** Type de ligne Futur à l'origine d'un flux projeté. */
export type SourceFlux =
  | "facture_client"
  | "facture_fournisseur"
  | "financement"
  | "charge_fixe"
  | "autre_depense"
  | "rentree_reguliere";

/** Un flux de la projection : sa ligne d'origine, sa date et son montant signé (+ entrée, − sortie). */
export interface FluxProjete {
  source: SourceFlux;
  sourceId: string;
  libelle: string;
  date: string; // YYYY-MM-DD
  montant: number;
}

/**
 * Tous les flux que la projection retient entre dateDepart et dateDepart + horizonJours (bornes
 * incluses), ligne par ligne. SEULE définition des règles d'inclusion de Futur : la courbe
 * (calculerProjectionCash) et la prévision de référence (lib/fiabiliteProjection.ts) la partagent.
 */
export function listerFluxProjetes(
  params: Omit<ParametresProjectionCash, "soldeInitial">,
  // Occurrence exclue faute de montant calculable (source indisponible, profil incomplet) : la
  // prévision de référence la signale au lieu de la compter pour zéro.
  onOccurrenceIndisponible?: (source: SourceFlux, sourceId: string, date: string) => void
): FluxProjete[] {
  const {
    facturesClients,
    facturesFournisseurs,
    chargesFixes,
    autresDepenses,
    financements,
    rentreesRegulieres,
    dateDepart,
    horizonJours = HORIZON_JOURS_DEFAUT,
    remplacements,
  } = params;

  const debut = parseDateISO(dateDepart);
  const fin = ajouterJours(debut, horizonJours);
  const flux: FluxProjete[] = [];

  const enregistrerFlux = (source: SourceFlux, sourceId: string, libelle: string, dateStr: string, montant: number) => {
    // Une ligne sans date (nouvellement ajoutée, pas encore complétée par l'utilisateur)
    // ne doit jamais entrer dans le calcul, et ne doit jamais faire planter le moteur.
    if (!estDateValide(dateStr)) return;
    const date = parseDateISO(dateStr);
    if (date < debut || date > fin) return;
    flux.push({ source, sourceId, libelle, date: toISODate(date), montant });
  };

  for (const facture of facturesClients) {
    if (facture.litigieuse || facture.payee) continue;
    enregistrerFlux("facture_client", facture.id, `${facture.facture} — ${facture.client}`, facture.dateEncaissementAnticipee, facture.montant);
  }

  for (const facture of facturesFournisseurs) {
    if (facture.litigieuse || facture.payee) continue;
    enregistrerFlux("facture_fournisseur", facture.id, `${facture.facture} — ${facture.fournisseur}`, facture.datePaiementPrevue, -facture.montant);
  }

  for (const financement of financements) {
    if (financement.verse) continue;
    enregistrerFlux("financement", financement.id, financement.libelle, financement.dateEncaissementPrevue, financement.montant);
  }

  for (const charge of chargesFixes) {
    if (charge.aCouper) continue;
    const occurrencesCharge = genererOccurrencesRecurrentes(charge.datePrevue, charge.recurrence, charge.dateFin, fin);
    occurrencesCharge.forEach((occurrence, index) => {
      // Remplacée par une facture fournisseur : la facture est la vérité pour cette occurrence,
      // qu'elle soit encore à payer (projetée à sa propre date) ou déjà payée (dans le solde initial).
      if (estOccurrenceRemplacee(remplacements, charge.id, occurrence)) return;
      const precedente = index > 0 ? occurrencesCharge[index - 1] : null;
      const montant = montantOccurrenceChargeFixe(charge, occurrence, precedente, chargesFixes, rentreesRegulieres, fin, remplacements);
      if (montant === null) {
        // source indisponible : occurrence exclue du calcul
        if (occurrence >= debut) onOccurrenceIndisponible?.("charge_fixe", charge.id, toISODate(occurrence));
        return;
      }
      enregistrerFlux("charge_fixe", charge.id, charge.libelle, toISODate(occurrence), -montant);
    });
  }

  for (const depense of autresDepenses) {
    // Facturée et Payée sont deux raisons distinctes d'exclusion, comportement identique.
    if (depense.facturee || depense.payee) continue;
    enregistrerFlux("autre_depense", depense.id, depense.libelle, depense.datePrevue, -depense.montant);
  }

  for (const rentree of rentreesRegulieres) {
    for (const occurrence of genererOccurrencesRecurrentes(rentree.dateDebut, rentree.frequence, rentree.dateFin, fin)) {
      const montant = montantOccurrenceRentreeReguliere(rentree, occurrence);
      if (montant === null) {
        // profil de saisonnalité indisponible : occurrence exclue
        if (occurrence >= debut) onOccurrenceIndisponible?.("rentree_reguliere", rentree.id, toISODate(occurrence));
        continue;
      }
      enregistrerFlux("rentree_reguliere", rentree.id, rentree.libelle, toISODate(occurrence), montant);
    }
  }

  return flux;
}

export function calculerProjectionCash(params: ParametresProjectionCash): ResultatProjectionCash {
  const { soldeInitial, dateDepart, horizonJours = HORIZON_JOURS_DEFAUT } = params;
  const debut = parseDateISO(dateDepart);

  const fluxParDate = new Map<string, number>();
  for (const flux of listerFluxProjetes(params)) {
    fluxParDate.set(flux.date, (fluxParDate.get(flux.date) ?? 0) + flux.montant);
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
