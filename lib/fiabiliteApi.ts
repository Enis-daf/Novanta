import type {
  Comparaison,
  CouvertureReference,
  LignePrevue,
  LigneRealisee,
  PeriodeFiabilite,
  Precision,
  StatutRealise,
  TotauxFlux,
} from "./fiabiliteProjection";

/** Réponse de /api/futur/fiabilite (écran « Fiabilité de la projection »). */

export interface PointFiabilite {
  periode: PeriodeFiabilite;
  referenceDisponible: boolean;
  statutRealise: StatutRealise["statut"];
  // Scores publiés seulement si la référence existe ET le réalisé est complet : jamais un 0 % ou
  // un score inventé pour une période indisponible.
  publiable: boolean;
  globale: Precision | null;
  encaissements: Precision | null;
  decaissements: Precision | null;
  revision: number | null;
}

export interface RevisionFiabilite {
  revision: number;
  calculeLe: string;
  globale: Precision | null;
  totauxRealise: TotauxFlux;
}

export interface DetailFiabilite {
  periode: PeriodeFiabilite;
  reference: {
    arreteeAu: string; // instant de clôture (ISO)
    captureeLe: string; // instant réel du calcul (ISO)
    modeCapture: "before_close" | "after_close_unchanged";
    lignes: LignePrevue[];
    totaux: TotauxFlux;
    couverture: CouvertureReference;
  } | null;
  realise: { lignes: LigneRealisee[]; totaux: TotauxFlux; nombreTransactions: number };
  statutRealise: StatutRealise;
  comparaison: Comparaison | null;
  revisions: RevisionFiabilite[]; // de la plus récente à la plus ancienne
}

export interface ReponseFiabilite {
  aujourdhui: string;
  derniereSynchronisation: string | null;
  points: PointFiabilite[]; // de la plus récente à la plus ancienne
  detail: DetailFiabilite;
}
