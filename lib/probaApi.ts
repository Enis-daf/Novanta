import type { SourceFlux } from "./cash-engine";
import type { ScoreConfiance } from "./probaCalibration";
import {
  estFiabilite,
  estProbabilite,
  estSourceFlux,
  EvenementTresorerie,
  HypotheseLigne,
  LigneProbabiliste,
  OrdreLignes,
} from "./probaEvenements";
import type { IndicateursRisque } from "./probaIndicateurs";

/**
 * Prévision probabiliste — 7. Contrat de l'API (app/api/futur/probabiliste), partagé par le
 * navigateur et le serveur, et validation des requêtes. Le navigateur envoie les événements de
 * SA projection (mêmes flux que la courbe déterministe, avec leurs hypothèses) ; le serveur
 * vérifie l'offre, calibre les retards sur l'historique de la société de l'utilisateur, simule et
 * ne renvoie que des agrégats.
 */

export const LIMITES = {
  evenements: 5_000,
  lignes: 2_000,
  horizonMax: 366,
  simulationsMin: 1_000,
  simulationsMax: 20_000,
} as const;

export interface RequeteSimulation {
  soldeInitial: number;
  dateDepart: string;
  horizonJours: number;
  lignes: LigneProbabiliste[];
  evenements: EvenementTresorerie[];
  nombreSimulations?: number;
  graine?: number;
}

/** Comportement de paiement observé, en mots simples pour l'écran. */
export interface ResumeCalibration {
  nombreFactures: number;
  confiance: ScoreConfiance;
  retardMedian: number | null; // jours après l'échéance
  retardP90: number | null;
  partALHeure: number | null;
  partPlus30: number | null;
}

export interface ReponseSimulation {
  indicateurs: IndicateursRisque;
  calibration: { client: ResumeCalibration; fournisseur: ResumeCalibration };
  dependancesIgnorees: OrdreLignes["dependancesIgnorees"];
  parametres: { nombreSimulations: number; graine: number; dateDepart: string; horizonJours: number };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const estDate = (v: unknown): v is string => typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(v));
const estTexte = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const estNombreFini = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export type Validation<T> = { ok: true; valeur: T } | { ok: false; erreur: string };

/** Valide le corps d'une requête de simulation ; jamais d'exception, jamais de valeur douteuse retenue. */
export function validerRequeteSimulation(corps: unknown): Validation<RequeteSimulation> {
  if (typeof corps !== "object" || corps === null) return { ok: false, erreur: "Requête invalide." };
  const c = corps as Record<string, unknown>;
  if (!estNombreFini(c.soldeInitial)) return { ok: false, erreur: "Solde initial invalide." };
  if (!estDate(c.dateDepart)) return { ok: false, erreur: "Date de départ invalide." };
  if (!Number.isInteger(c.horizonJours) || (c.horizonJours as number) < 1 || (c.horizonJours as number) > LIMITES.horizonMax) {
    return { ok: false, erreur: "Horizon invalide." };
  }
  if (!Array.isArray(c.lignes) || c.lignes.length > LIMITES.lignes) return { ok: false, erreur: "Lignes invalides." };
  if (!Array.isArray(c.evenements) || c.evenements.length > LIMITES.evenements) return { ok: false, erreur: "Trop d'échéances à simuler." };

  const lignes: LigneProbabiliste[] = [];
  for (const l of c.lignes as Record<string, unknown>[]) {
    if (typeof l !== "object" || l === null || !estTexte(l.cle, 200)) return { ok: false, erreur: "Ligne invalide." };
    if (!estNombreFini(l.probabilite) || l.probabilite < 0 || l.probabilite > 100) return { ok: false, erreur: "Probabilité invalide." };
    if (l.parentCle !== null && !estTexte(l.parentCle, 200)) return { ok: false, erreur: "Dépendance invalide." };
    lignes.push({ cle: l.cle, probabilite: l.probabilite, parentCle: l.parentCle as string | null });
  }

  const evenements: EvenementTresorerie[] = [];
  for (const e of c.evenements as Record<string, unknown>[]) {
    if (typeof e !== "object" || e === null) return { ok: false, erreur: "Échéance invalide." };
    if (!estTexte(e.id, 220) || !estTexte(e.cleLigne, 200) || typeof e.libelle !== "string") return { ok: false, erreur: "Échéance invalide." };
    if (!estNombreFini(e.montant) || e.montant <= 0) return { ok: false, erreur: "Montant invalide." };
    if (e.sens !== "encaissement" && e.sens !== "decaissement") return { ok: false, erreur: "Sens invalide." };
    if (!estDate(e.datePrevue)) return { ok: false, erreur: "Date prévue invalide." };
    if (e.dateEcheance !== null && !estDate(e.dateEcheance)) return { ok: false, erreur: "Échéance invalide." };
    if (!estFiabilite(e.fiabiliteDate)) return { ok: false, erreur: "Fiabilité invalide." };
    if (e.tiers !== null && typeof e.tiers !== "string") return { ok: false, erreur: "Tiers invalide." };
    evenements.push({
      id: e.id,
      cleLigne: e.cleLigne,
      libelle: e.libelle.slice(0, 300),
      montant: e.montant,
      sens: e.sens,
      datePrevue: e.datePrevue,
      dateEcheance: e.dateEcheance as string | null,
      fiabiliteDate: e.fiabiliteDate,
      tiers: e.tiers === null ? null : (e.tiers as string).slice(0, 300),
    });
  }

  let nombreSimulations: number | undefined;
  if (c.nombreSimulations !== undefined) {
    if (!Number.isInteger(c.nombreSimulations)) return { ok: false, erreur: "Nombre de simulations invalide." };
    nombreSimulations = Math.min(LIMITES.simulationsMax, Math.max(LIMITES.simulationsMin, c.nombreSimulations as number));
  }
  let graine: number | undefined;
  if (c.graine !== undefined) {
    if (!Number.isInteger(c.graine)) return { ok: false, erreur: "Graine invalide." };
    graine = (c.graine as number) >>> 0;
  }
  return {
    ok: true,
    valeur: { soldeInitial: c.soldeInitial, dateDepart: c.dateDepart, horizonJours: c.horizonJours as number, lignes, evenements, nombreSimulations, graine },
  };
}

/** Valide une hypothèse envoyée à PUT /api/futur/probabiliste/hypotheses. */
export function validerHypothese(corps: unknown): Validation<HypotheseLigne> {
  if (typeof corps !== "object" || corps === null) return { ok: false, erreur: "Requête invalide." };
  const h = corps as Record<string, unknown>;
  if (!estSourceFlux(h.source) || !estTexte(h.sourceId, 100)) return { ok: false, erreur: "Ligne invalide." };
  if (!estProbabilite(h.probabilite)) return { ok: false, erreur: "Probabilité invalide." };
  if (!estFiabilite(h.fiabiliteDate)) return { ok: false, erreur: "Fiabilité invalide." };
  const sansParent = h.parentSource === null && h.parentSourceId === null;
  const avecParent = estSourceFlux(h.parentSource) && estTexte(h.parentSourceId, 100);
  if (!sansParent && !avecParent) return { ok: false, erreur: "Dépendance invalide." };
  if (avecParent && h.parentSource === h.source && h.parentSourceId === h.sourceId) return { ok: false, erreur: "Une ligne ne peut pas dépendre d'elle-même." };
  return {
    ok: true,
    valeur: {
      source: h.source,
      sourceId: h.sourceId,
      probabilite: h.probabilite,
      fiabiliteDate: h.fiabiliteDate,
      parentSource: avecParent ? (h.parentSource as SourceFlux) : null,
      parentSourceId: avecParent ? (h.parentSourceId as string) : null,
    },
  };
}
