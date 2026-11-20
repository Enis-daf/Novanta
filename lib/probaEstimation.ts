import { creerAlea, graineDepuisTexte } from "./probaAlea";
import { Echantillonneur, echantillonneurPour, ModeleRetards, quantileTrie } from "./probaCalibration";
import { joursEntre } from "./pastBfrDelais";
import { decalerDateISO, estDateValide } from "./dates";
import type { FactureClient } from "./types";

/**
 * Factures clients ouvertes dont la date d'encaissement anticipée est passée (ou absente) : date
 * d'encaissement de référence ESTIMÉE à partir de l'historique de paiement du compte. Pur.
 *
 * Ordre de priorité (une facture ouverte ne sort jamais du périmètre de risque) :
 *  A. date d'encaissement anticipée saisie et encore à venir : elle fait foi (pas d'estimation) ;
 *  B. sinon, estimation du délai RESTANT, sachant que la facture est toujours impayée aujourd'hui :
 *     retards tirés de l'historique (lib/probaCalibration.ts), comptés depuis l'échéance
 *     contractuelle (à défaut, depuis la date anticipée dépassée) ; seuls les paiements tombant
 *     aujourd'hui ou plus tard sont retenus (paiement conditionnel) ; la date de référence est la
 *     MÉDIANE de ces paiements (convention P50 du modèle). Le retard déjà constaté n'est donc ni
 *     ignoré (on ne repart pas de l'échéance passée) ni compté deux fois. Niveaux :
 *       1. historique du client, s'il pèse au moins `poidsClientMinimal` dans son échantillonneur ;
 *       2. sinon historique du compte (segment puis compte), s'il n'est pas « peu calibré » et ne
 *          repose pas surtout sur les hypothèses par défaut ;
 *     un niveau dont moins de `partMinimaleSupport` des tirages restent possibles (retard constaté
 *     au-delà de ce que l'historique a connu) est écarté au profit du suivant ;
 *  C. sinon : « Date d'encaissement à actualiser » — la facture reste suivie, sans date ni
 *     certitude inventées, et l'analyse de risque se déclare incomplète.
 * Jamais de placement d'office au premier jour : la règle des dépenses en retard ne s'applique pas
 * aux recettes. L'estimation ne modifie ni la date saisie ni l'échéance de la facture.
 */

export const CONFIG_ESTIMATION = {
  echantillons: 4_000,
  poidsClientMinimal: 0.5,
  partMinimaleSupport: 0.02,
} as const;

export interface FactureEnRetard {
  id: string;
  numero: string;
  client: string;
  montant: number; // reste à encaisser
  dateEcheance: string | null;
  dateEncaissementAnticipee: string | null; // dépassée ou absente
}

export type RaisonAActualiser = "sans_reference" | "historique_insuffisant" | "retard_hors_historique";

export type EstimationDate =
  | { factureId: string; statut: "estimee"; date: string; origine: "client" | "compte"; joursDepuisReference: number }
  | { factureId: string; statut: "a_actualiser"; raison: RaisonAActualiser };

export const LIBELLES_RAISON_A_ACTUALISER: Record<RaisonAActualiser, string> = {
  sans_reference: "ni échéance ni date d'encaissement renseignées",
  historique_insuffisant: "historique de paiement insuffisant pour estimer une date",
  retard_hors_historique: "retard déjà constaté au-delà de ce que l'historique a connu",
};

/** Factures clients ouvertes, éligibles, que la projection ne place pas faute de date à venir. */
export function facturesEnRetard(facturesClients: FactureClient[], dateDepart: string): FactureEnRetard[] {
  return facturesClients
    .filter((f) => !f.payee && !f.litigieuse && f.montant > 0)
    .filter((f) => !estDateValide(f.dateEncaissementAnticipee) || f.dateEncaissementAnticipee < dateDepart)
    .map((f) => ({
      id: f.id,
      numero: f.facture,
      client: f.client,
      montant: f.montant,
      dateEcheance: estDateValide(f.dateEcheance) ? f.dateEcheance : null,
      dateEncaissementAnticipee: estDateValide(f.dateEncaissementAnticipee) ? f.dateEncaissementAnticipee : null,
    }));
}

/** Médiane des paiements possibles (≥ aujourd'hui), ou null si l'historique ne les couvre pas. */
function medianeConditionnelle(ech: Echantillonneur, base: number, graine: number): number | null {
  const alea = creerAlea(graine);
  const possibles: number[] = [];
  for (let i = 0; i < CONFIG_ESTIMATION.echantillons; i++) {
    const jour = base + Math.round(ech.tirer(alea));
    if (jour >= 0) possibles.push(jour);
  }
  if (possibles.length < CONFIG_ESTIMATION.partMinimaleSupport * CONFIG_ESTIMATION.echantillons) return null;
  possibles.sort((a, b) => a - b);
  return Math.round(quantileTrie(possibles, 0.5));
}

export function estimerDateEncaissement(f: FactureEnRetard, modele: ModeleRetards, dateDepart: string): EstimationDate {
  const reference = f.dateEcheance ?? f.dateEncaissementAnticipee;
  if (!reference) return { factureId: f.id, statut: "a_actualiser", raison: "sans_reference" };
  const base = joursEntre(dateDepart, reference);
  const graine = graineDepuisTexte(`${f.id}|${dateDepart}`);
  let horsSupport = false;

  const client = echantillonneurPour(modele, f.client || null, f.montant);
  if (client.poids.client >= CONFIG_ESTIMATION.poidsClientMinimal) {
    const jour = medianeConditionnelle(client, base, graine);
    if (jour !== null) return { factureId: f.id, statut: "estimee", date: decalerDateISO(dateDepart, jour), origine: "client", joursDepuisReference: jour - base };
    horsSupport = true;
  }
  const compte = echantillonneurPour(modele, null, f.montant);
  if (modele.confiance.niveau !== "peu_calibre" && compte.poids.defaut < 0.5) {
    const jour = medianeConditionnelle(compte, base, graine);
    if (jour !== null) return { factureId: f.id, statut: "estimee", date: decalerDateISO(dateDepart, jour), origine: "compte", joursDepuisReference: jour - base };
    horsSupport = true;
  }
  return { factureId: f.id, statut: "a_actualiser", raison: horsSupport ? "retard_hors_historique" : "historique_insuffisant" };
}

export function estimerDates(factures: FactureEnRetard[], modele: ModeleRetards, dateDepart: string): EstimationDate[] {
  return factures.map((f) => estimerDateEncaissement(f, modele, dateDepart));
}
