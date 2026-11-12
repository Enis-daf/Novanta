import type { FluxProjete, SourceFlux } from "./cash-engine";
import type { FactureClient, FactureFournisseur } from "./types";

/**
 * Prévision probabiliste — 3. Définition des événements de trésorerie. Fonctions pures.
 *
 * Deux notions :
 *  - la LIGNE (une facture, une charge fixe, une rentrée régulière…) porte les hypothèses saisies :
 *    probabilité de survenir, fiabilité de la date, éventuelle dépendance à une autre ligne. La
 *    survenue est tirée une fois par ligne et par simulation : un contrat récurrent « Probable »
 *    existe ou n'existe pas pour toutes ses échéances ;
 *  - l'ÉVÉNEMENT est une échéance de la ligne (un flux daté, signé). Sa date est simulée
 *    indépendamment pour chaque échéance quand elle n'est pas « Ferme ».
 *
 * Dépendance parent / enfant : si la ligne parente ne survient pas dans une simulation, ses
 * enfants (et leurs descendants) non plus. Une ligne enfant garde sa propre probabilité, tirée
 * seulement quand le parent survient. La structure (tirage des lignes dans un ordre topologique,
 * centralisé dans tirerSurvenues du moteur) permettra plus tard des corrélations plus riches.
 */

export const PROBABILITES = [100, 75, 50, 25] as const;
export type ProbabiliteSaisie = (typeof PROBABILITES)[number];
export const FIABILITES = [100, 75, 50, 25] as const;
export type FiabiliteDate = (typeof FIABILITES)[number];

export const LIBELLES_PROBABILITE: Record<ProbabiliteSaisie, string> = {
  100: "Certain",
  75: "Probable",
  50: "Possible",
  25: "Incertain",
};

export const LIBELLES_FIABILITE: Record<FiabiliteDate, string> = {
  100: "Ferme",
  75: "Assez fiable",
  50: "Approximative",
  25: "Très incertaine",
};

/**
 * Fiabilité de la date -> facteur appliqué aux retards tirés de l'historique du compte :
 *   retard simulé = facteur × retard tiré de la distribution historique (client, segment, compte).
 * Ce sont des multiplicateurs, jamais des délais absolus : 50 % reproduit le comportement observé
 * du compte, 75 % le resserre, 25 % l'élargit. 100 % : date certaine, aucun retard ajouté.
 */
export const FACTEURS_FIABILITE: Record<FiabiliteDate, number> = {
  100: 0,
  75: 0.5,
  50: 1,
  25: 2,
};

export type Sens = "encaissement" | "decaissement";

export interface LigneProbabiliste {
  cle: string; // `${source}:${sourceId}`
  probabilite: number; // 0..100 (l'interface ne propose que 25 / 50 / 75 / 100)
  parentCle: string | null;
}

export interface EvenementTresorerie {
  id: string;
  cleLigne: string;
  libelle: string;
  montant: number; // > 0
  sens: Sens;
  datePrevue: string; // YYYY-MM-DD
  // Échéance contractuelle (factures) : point de départ des retards tirés de l'historique.
  dateEcheance: string | null;
  fiabiliteDate: FiabiliteDate;
  tiers: string | null; // client ou fournisseur, pour son historique propre
}

/** Hypothèse saisie sur une ligne de Futur (table forecast_event_assumptions). */
export interface HypotheseLigne {
  source: SourceFlux;
  sourceId: string;
  probabilite: ProbabiliteSaisie;
  fiabiliteDate: FiabiliteDate;
  parentSource: SourceFlux | null;
  parentSourceId: string | null;
}

export const SOURCES_FLUX: readonly SourceFlux[] = [
  "facture_client",
  "facture_fournisseur",
  "financement",
  "charge_fixe",
  "autre_depense",
  "rentree_reguliere",
];

export function cleLigne(source: SourceFlux, sourceId: string): string {
  return `${source}:${sourceId}`;
}

export function estProbabilite(v: unknown): v is ProbabiliteSaisie {
  return typeof v === "number" && (PROBABILITES as readonly number[]).includes(v);
}

export function estFiabilite(v: unknown): v is FiabiliteDate {
  return typeof v === "number" && (FIABILITES as readonly number[]).includes(v);
}

export function estSourceFlux(v: unknown): v is SourceFlux {
  return typeof v === "string" && (SOURCES_FLUX as readonly string[]).includes(v);
}

/**
 * Hypothèses par défaut, sans saisie : tout est certain et à sa date, SAUF les factures clients
 * dont la date d'encaissement suit le comportement de paiement observé du compte (« Approximative »).
 * Sans aucune saisie, la prévision probabiliste n'ajoute donc que l'aléa des retards clients.
 */
export function hypotheseParDefaut(source: SourceFlux): { probabilite: ProbabiliteSaisie; fiabiliteDate: FiabiliteDate } {
  return { probabilite: 100, fiabiliteDate: source === "facture_client" ? 50 : 100 };
}

export interface DonneesTiers {
  facturesClients: Pick<FactureClient, "id" | "client" | "dateEcheance">[];
  facturesFournisseurs: Pick<FactureFournisseur, "id" | "fournisseur" | "dateEcheance">[];
}

export interface EvenementsConstruits {
  lignes: LigneProbabiliste[];
  evenements: EvenementTresorerie[];
}

/**
 * Flux de la projection déterministe (mêmes règles d'inclusion, lib/cash-engine.ts) + hypothèses
 * -> lignes et événements du moteur. Un flux nul est ignoré.
 */
export function construireEvenements(flux: FluxProjete[], donnees: DonneesTiers, hypotheses: HypotheseLigne[]): EvenementsConstruits {
  const parCle = new Map(hypotheses.map((h) => [cleLigne(h.source, h.sourceId), h]));
  const clients = new Map(donnees.facturesClients.map((f) => [f.id, f]));
  const fournisseurs = new Map(donnees.facturesFournisseurs.map((f) => [f.id, f]));
  const lignes = new Map<string, LigneProbabiliste>();
  const evenements: EvenementTresorerie[] = [];
  const compteurs = new Map<string, number>();

  for (const f of flux) {
    if (f.montant === 0) continue;
    const cle = cleLigne(f.source, f.sourceId);
    const h = parCle.get(cle);
    const defaut = hypotheseParDefaut(f.source);
    if (!lignes.has(cle)) {
      lignes.set(cle, {
        cle,
        probabilite: h?.probabilite ?? defaut.probabilite,
        parentCle: h?.parentSource && h.parentSourceId ? cleLigne(h.parentSource, h.parentSourceId) : null,
      });
    }
    let tiers: string | null = null;
    let dateEcheance: string | null = null;
    if (f.source === "facture_client") {
      const facture = clients.get(f.sourceId);
      tiers = facture?.client ?? null;
      dateEcheance = facture?.dateEcheance || null;
    } else if (f.source === "facture_fournisseur") {
      const facture = fournisseurs.get(f.sourceId);
      tiers = facture?.fournisseur ?? null;
      dateEcheance = facture?.dateEcheance || null;
    }
    const rang = compteurs.get(cle) ?? 0;
    compteurs.set(cle, rang + 1);
    evenements.push({
      id: `${cle}#${rang}`,
      cleLigne: cle,
      libelle: f.libelle,
      montant: Math.abs(f.montant),
      sens: f.montant > 0 ? "encaissement" : "decaissement",
      datePrevue: f.date,
      dateEcheance,
      fiabiliteDate: h?.fiabiliteDate ?? defaut.fiabiliteDate,
      tiers,
    });
  }
  return { lignes: Array.from(lignes.values()), evenements };
}

export interface OrdreLignes {
  ordre: LigneProbabiliste[]; // parents avant enfants
  // Dépendances ignorées (parent absent de l'horizon, cycle) : la ligne devient indépendante.
  dependancesIgnorees: { cle: string; raison: "parent_absent" | "cycle" }[];
}

/** Ordre topologique des lignes ; une dépendance invalide est ignorée et signalée, jamais bloquante. */
export function ordonnerLignes(lignes: LigneProbabiliste[]): OrdreLignes {
  const parCle = new Map(lignes.map((l) => [l.cle, { ...l }]));
  const dependancesIgnorees: OrdreLignes["dependancesIgnorees"] = [];
  parCle.forEach((l) => {
    if (l.parentCle !== null && (!parCle.has(l.parentCle) || l.parentCle === l.cle)) {
      dependancesIgnorees.push({ cle: l.cle, raison: l.parentCle === l.cle ? "cycle" : "parent_absent" });
      l.parentCle = null;
    }
  });
  // Cycles : on remonte la chaîne des parents ; une ligne qui se retrouve elle-même perd son parent.
  parCle.forEach((l) => {
    const vus = new Set<string>([l.cle]);
    let courant = l.parentCle;
    while (courant !== null) {
      if (vus.has(courant)) {
        dependancesIgnorees.push({ cle: l.cle, raison: "cycle" });
        l.parentCle = null;
        break;
      }
      vus.add(courant);
      courant = parCle.get(courant)?.parentCle ?? null;
    }
  });
  const ordre: LigneProbabiliste[] = [];
  const places = new Set<string>();
  const placer = (l: LigneProbabiliste) => {
    if (places.has(l.cle)) return;
    if (l.parentCle !== null) placer(parCle.get(l.parentCle)!);
    places.add(l.cle);
    ordre.push(l);
  };
  parCle.forEach(placer);
  return { ordre, dependancesIgnorees };
}

/** Lignes qui dépendent (directement ou non) de `cle` : on ne peut pas les choisir comme parent. */
export function descendants(lignes: Pick<LigneProbabiliste, "cle" | "parentCle">[], cle: string): Set<string> {
  const resultat = new Set<string>();
  let ajout = true;
  while (ajout) {
    ajout = false;
    for (const l of lignes) {
      if (l.parentCle !== null && (l.parentCle === cle || resultat.has(l.parentCle)) && !resultat.has(l.cle)) {
        resultat.add(l.cle);
        ajout = true;
      }
    }
  }
  return resultat;
}
