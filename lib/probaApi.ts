import type { ScoreConfiance } from "./probaCalibration";
import {
  ConditionMoteur,
  DIMENSIONS,
  estFiabilite,
  estIndicateurSeuil,
  estProbabilite,
  estSourceFlux,
  EvenementTresorerie,
  DECALAGE_MOIS_MAX,
  HypotheseLigne,
  LigneProbabiliste,
  lireConditionSaisie,
  OrdreLignes,
} from "./probaEvenements";
import { estEtagePnl } from "./pastCategoryMapping";
import type { Completude } from "./probaEcran";
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
  completude: Pick<Completude, "aRenseigner" | "importantesARenseigner" | "secondairesARenseigner">;
  calibration: { client: ResumeCalibration; fournisseur: ResumeCalibration };
  dependancesIgnorees: OrdreLignes["dependancesIgnorees"];
  parametres: { nombreSimulations: number; graine: number; dateDepart: string; horizonJours: number };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const estDate = (v: unknown): v is string => typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(v));
const estTexte = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const estNombreFini = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export type Validation<T> = { ok: true; valeur: T } | { ok: false; erreur: string };

/** Condition du moteur : null (aucune), une condition valide, ou undefined (refusée). */
function validerConditionMoteur(brut: unknown): ConditionMoteur | null | undefined {
  if (brut === null) return null;
  if (typeof brut !== "object") return undefined;
  const c = brut as Record<string, unknown>;
  if (c.type === "evenement" && estTexte(c.parentCle, 200)) return { type: "evenement", parentCle: c.parentCle };
  if (c.type === "seuil" && estIndicateurSeuil(c.indicateur) && (c.comparateur === ">" || c.comparateur === "<") && estNombreFini(c.valeur)) {
    return { type: "seuil", indicateur: c.indicateur, comparateur: c.comparateur, valeur: c.valeur };
  }
  if (c.type === "apres_evenement" && estTexte(c.parentCle, 200) && Number.isInteger(c.decalageMois) && (c.decalageMois as number) >= 0 && (c.decalageMois as number) <= DECALAGE_MOIS_MAX) {
    return { type: "apres_evenement", parentCle: c.parentCle, decalageMois: c.decalageMois as number };
  }
  return undefined;
}

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
    if (!estFiabilite(l.fiabiliteMontant)) return { ok: false, erreur: "Fiabilité du montant invalide." };
    if (l.modeDate !== "echeance" && l.modeDate !== "debut") return { ok: false, erreur: "Ligne invalide." };
    if (typeof l.aRenseigner !== "boolean") return { ok: false, erreur: "Ligne invalide." };
    const condition = validerConditionMoteur(l.condition);
    if (condition === undefined) return { ok: false, erreur: "Condition invalide." };
    lignes.push({ cle: l.cle, probabilite: l.probabilite, condition, fiabiliteMontant: l.fiabiliteMontant, modeDate: l.modeDate, aRenseigner: l.aRenseigner });
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
    if (e.etage !== null && !estEtagePnl(e.etage)) return { ok: false, erreur: "Étage invalide." };
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
      etage: e.etage as EvenementTresorerie["etage"],
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
  const dims = DIMENSIONS[h.source];
  if (h.fiabiliteMontant !== null && !(dims.montant && estFiabilite(h.fiabiliteMontant))) return { ok: false, erreur: "Fiabilité du montant invalide." };
  if (h.montantCible !== null && !(h.source === "rentree_reguliere" && estNombreFini(h.montantCible) && h.montantCible > 0)) {
    return { ok: false, erreur: "Montant cible invalide." };
  }
  let condition = null;
  if (h.condition !== null) {
    condition = lireConditionSaisie(h.condition);
    if (condition === null) return { ok: false, erreur: "Condition invalide." };
    if (condition.type !== "seuil" && condition.source === h.source && condition.sourceId === h.sourceId) {
      return { ok: false, erreur: "Une ligne ne peut pas dépendre d'elle-même." };
    }
  }
  return {
    ok: true,
    valeur: {
      source: h.source,
      sourceId: h.sourceId,
      probabilite: h.probabilite,
      fiabiliteDate: h.fiabiliteDate,
      fiabiliteMontant: (h.fiabiliteMontant as HypotheseLigne["fiabiliteMontant"]) ?? null,
      montantCible: (h.montantCible as number | null) ?? null,
      condition,
    },
  };
}
