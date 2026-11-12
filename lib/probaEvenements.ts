import type { FluxProjete, SourceFlux } from "./cash-engine";
import type { EtagePnl } from "./pastCategoryMapping";
import type { FactureClient, FactureFournisseur, RentreeReguliere } from "./types";

/**
 * Prévision probabiliste — 3. Définition des hypothèses et des événements. Fonctions pures.
 *
 * Deux notions :
 *  - la LIGNE (une facture, une charge fixe, une rentrée régulière…) porte les hypothèses saisies ;
 *  - l'ÉVÉNEMENT est une échéance de la ligne (un flux daté, signé).
 *
 * Trois dimensions d'incertitude, qui ne s'appliquent pas à toutes les lignes (DIMENSIONS) :
 *  - EXISTENCE : la ligne survient-elle dans cette simulation ? Probabilité tirée une fois par
 *    ligne (un contrat récurrent « Probable » existe ou non pour toutes ses échéances), puis
 *    condition d'activation éventuelle (« Dépend de ») ;
 *  - MONTANT : le montant varie-t-il autour de sa valeur cible ? Un facteur tiré une fois par ligne
 *    et par simulation, jamais négatif ;
 *  - DATE : la date varie-t-elle ? Selon les habitudes de paiement du compte (lib/probaCalibration.ts),
 *    échéance par échéance pour une facture, ou en décalant le début de toute la série pour une
 *    charge fixe ou une rentrée régulière (une fois démarrée, la série suit sa fréquence).
 *
 * « Dépend de » est une condition d'EXISTENCE, jamais une date : une fois activée, la ligne garde ses
 * propres règles de montant et de date. Trois formes, extensibles sans changer le stockage (jsonb) :
 *  - evenement       : la ligne n'existe que si une autre ligne existe ;
 *  - seuil           : la ligne n'existe que si un indicateur dépasse (ou reste sous) un seuil au
 *                      moment où elle démarrerait — CA du mois précédent, trésorerie, marge brute
 *                      du mois précédent ;
 *  - apres_evenement : la ligne n'existe que si une autre ligne existe, et ne démarre qu'à partir
 *                      du mois suivant celle-ci (+ un décalage en mois).
 */

export const PROBABILITES = [100, 75, 50, 25] as const;
export type ProbabiliteSaisie = (typeof PROBABILITES)[number];
export const FIABILITES = [100, 75, 50, 25] as const;
export type FiabiliteDate = (typeof FIABILITES)[number];
export type FiabiliteMontant = FiabiliteDate;

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

export const LIBELLES_FIABILITE_MONTANT: Record<FiabiliteMontant, string> = {
  100: "Certain",
  75: "Assez sûr",
  50: "Approximatif",
  25: "Très incertain",
};

/**
 * Fiabilité de la date -> facteur appliqué aux retards tirés de l'historique du compte :
 *   retard simulé = facteur × retard tiré de la distribution historique (client, segment, compte).
 * Multiplicateurs, jamais des délais absolus : 50 % reproduit le comportement observé du compte,
 * 75 % le resserre, 25 % l'élargit, 100 % n'ajoute aucun retard.
 */
export const FACTEURS_FIABILITE: Record<FiabiliteDate, number> = {
  100: 0,
  75: 0.5,
  50: 1,
  25: 2,
};

/**
 * Fiabilité du montant -> demi-largeur relative de la fourchette « 8 cas sur 10 » autour de la
 * valeur cible (±10 %, ±25 %, ±50 %). Aucun historique de montants n'existe pour les lignes
 * saisies : c'est la traduction directe du niveau choisi, affichée en euros à l'utilisateur.
 */
export const ECARTS_MONTANT: Record<FiabiliteMontant, number> = {
  100: 0,
  75: 0.1,
  50: 0.25,
  25: 0.5,
};

export type Sens = "encaissement" | "decaissement";

// ---------------------------------------------------------------------------------------------
// Conditions d'activation (« Dépend de »)
// ---------------------------------------------------------------------------------------------

export const INDICATEURS_SEUIL = ["ca_mois_precedent", "tresorerie", "marge_brute_mois_precedent"] as const;
export type IndicateurSeuil = (typeof INDICATEURS_SEUIL)[number];

export const LIBELLES_INDICATEUR: Record<IndicateurSeuil, string> = {
  ca_mois_precedent: "CA du mois précédent",
  tresorerie: "Trésorerie",
  marge_brute_mois_precedent: "Marge brute du mois précédent",
};

/** Unité de la valeur seuil : euros, ou pourcentage pour la marge brute. */
export const UNITE_INDICATEUR: Record<IndicateurSeuil, "€" | "%"> = {
  ca_mois_precedent: "€",
  tresorerie: "€",
  marge_brute_mois_precedent: "%",
};

export type Comparateur = ">" | "<";

/** Condition telle que saisie et stockée : les lignes sont désignées par leur source. */
export type ConditionSaisie =
  | { type: "evenement"; source: SourceFlux; sourceId: string }
  | { type: "seuil"; indicateur: IndicateurSeuil; comparateur: Comparateur; valeur: number }
  | { type: "apres_evenement"; source: SourceFlux; sourceId: string; decalageMois: number };

/** Condition du moteur : les lignes sont désignées par leur clé. */
export type ConditionMoteur =
  | { type: "evenement"; parentCle: string }
  | { type: "seuil"; indicateur: IndicateurSeuil; comparateur: Comparateur; valeur: number }
  | { type: "apres_evenement"; parentCle: string; decalageMois: number };

export const DECALAGE_MOIS_MAX = 24;

export function parentDeCondition(c: ConditionMoteur | null): string | null {
  return c && c.type !== "seuil" ? c.parentCle : null;
}

// ---------------------------------------------------------------------------------------------
// Dimensions et valeurs par défaut selon le type de ligne
// ---------------------------------------------------------------------------------------------

export interface DimensionsLigne {
  montant: boolean; // le montant peut varier
  date: "echeance" | "debut"; // incertitude échéance par échéance, ou sur le début de la série
  // Ligne sans hypothèse fiable dans les données : « À renseigner » tant que l'utilisateur ne l'a
  // pas renseignée (ou validée telle quelle).
  aRenseignerParDefaut: boolean;
}

export const DIMENSIONS: Record<SourceFlux, DimensionsLigne> = {
  // Une facture émise existe et son montant est connu : seule sa date d'encaissement est incertaine.
  facture_client: { montant: false, date: "echeance", aRenseignerParDefaut: false },
  facture_fournisseur: { montant: false, date: "echeance", aRenseignerParDefaut: false },
  // Montant récurrent connu ; la date de début peut être rendue incertaine.
  charge_fixe: { montant: false, date: "debut", aRenseignerParDefaut: false },
  rentree_reguliere: { montant: true, date: "debut", aRenseignerParDefaut: true },
  financement: { montant: true, date: "echeance", aRenseignerParDefaut: true },
  autre_depense: { montant: true, date: "echeance", aRenseignerParDefaut: true },
};

/**
 * Valeurs simulées sans saisie. Factures clients : certaines, date selon les habitudes de paiement
 * du compte (« Approximative » = comportement observé). Tout le reste : tel que saisi dans Futur
 * (certain, à sa date) — y compris une ligne « À renseigner », signalée comme telle.
 */
export function hypotheseParDefaut(source: SourceFlux): {
  probabilite: ProbabiliteSaisie;
  fiabiliteDate: FiabiliteDate;
  fiabiliteMontant: FiabiliteMontant;
} {
  return { probabilite: 100, fiabiliteDate: source === "facture_client" ? 50 : 100, fiabiliteMontant: 100 };
}

// ---------------------------------------------------------------------------------------------
// Hypothèse stockée, ligne et événement du moteur
// ---------------------------------------------------------------------------------------------

/** Hypothèse saisie sur une ligne de Futur (table forecast_event_assumptions). */
export interface HypotheseLigne {
  source: SourceFlux;
  sourceId: string;
  probabilite: ProbabiliteSaisie;
  fiabiliteDate: FiabiliteDate;
  fiabiliteMontant: FiabiliteMontant | null; // null : montant certain / sans objet
  montantCible: number | null; // rentrée régulière à montant fixe : valeur cible par échéance
  condition: ConditionSaisie | null;
}

export interface LigneProbabiliste {
  cle: string; // `${source}:${sourceId}`
  probabilite: number; // 0..100 (l'interface ne propose que 25 / 50 / 75 / 100)
  condition: ConditionMoteur | null;
  fiabiliteMontant: FiabiliteMontant;
  modeDate: "echeance" | "debut";
  aRenseigner: boolean; // simulée telle que saisie, signalée
}

export interface EvenementTresorerie {
  id: string;
  cleLigne: string;
  libelle: string;
  montant: number; // > 0, valeur cible
  sens: Sens;
  datePrevue: string; // YYYY-MM-DD
  // Échéance contractuelle (factures) : point de départ des retards tirés de l'historique.
  dateEcheance: string | null;
  fiabiliteDate: FiabiliteDate;
  tiers: string | null; // client ou fournisseur, pour son historique propre
  // Étage P&L (encaissements : "revenue") : sert aux conditions sur le CA et la marge brute.
  etage: EtagePnl | null;
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

export function estIndicateurSeuil(v: unknown): v is IndicateurSeuil {
  return typeof v === "string" && (INDICATEURS_SEUIL as readonly string[]).includes(v);
}

/** Lit une condition (stockée ou reçue) ; toute forme douteuse est refusée (null). */
export function lireConditionSaisie(brut: unknown): ConditionSaisie | null {
  if (!brut || typeof brut !== "object") return null;
  const c = brut as Record<string, unknown>;
  const idValide = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 100;
  if (c.type === "evenement" && estSourceFlux(c.source) && idValide(c.sourceId)) return { type: "evenement", source: c.source, sourceId: c.sourceId };
  if (c.type === "seuil" && estIndicateurSeuil(c.indicateur) && (c.comparateur === ">" || c.comparateur === "<") && typeof c.valeur === "number" && Number.isFinite(c.valeur)) {
    return { type: "seuil", indicateur: c.indicateur, comparateur: c.comparateur, valeur: c.valeur };
  }
  if (
    c.type === "apres_evenement" &&
    estSourceFlux(c.source) &&
    idValide(c.sourceId) &&
    Number.isInteger(c.decalageMois) &&
    (c.decalageMois as number) >= 0 &&
    (c.decalageMois as number) <= DECALAGE_MOIS_MAX
  ) {
    return { type: "apres_evenement", source: c.source, sourceId: c.sourceId, decalageMois: c.decalageMois as number };
  }
  return null;
}

export function conditionVersMoteur(c: ConditionSaisie | null): ConditionMoteur | null {
  if (c === null) return null;
  if (c.type === "seuil") return c;
  if (c.type === "evenement") return { type: "evenement", parentCle: cleLigne(c.source, c.sourceId) };
  return { type: "apres_evenement", parentCle: cleLigne(c.source, c.sourceId), decalageMois: c.decalageMois };
}

/** La ligne doit-elle encore être renseignée ? */
export function estARenseigner(source: SourceFlux, hypothese: HypotheseLigne | undefined): boolean {
  return DIMENSIONS[source].aRenseignerParDefaut && hypothese === undefined;
}

export interface DonneesLignes {
  facturesClients: Pick<FactureClient, "id" | "client" | "dateEcheance">[];
  facturesFournisseurs: Pick<FactureFournisseur, "id" | "fournisseur" | "dateEcheance">[];
  rentreesRegulieres?: Pick<RentreeReguliere, "id" | "modeMontant">[];
}

export interface EvenementsConstruits {
  lignes: LigneProbabiliste[];
  evenements: EvenementTresorerie[];
}

/**
 * Flux de la projection déterministe (mêmes règles d'inclusion, lib/cash-engine.ts) + hypothèses
 * -> lignes et événements du moteur. Un flux nul est ignoré. `etageDe` donne l'étage P&L de la ligne
 * (classement existant de Futur) ; sans lui, les encaissements de factures et de rentrées sont du CA.
 */
export function construireEvenements(
  flux: FluxProjete[],
  donnees: DonneesLignes,
  hypotheses: HypotheseLigne[],
  etageDe?: (source: SourceFlux, sourceId: string) => EtagePnl | null
): EvenementsConstruits {
  const parCle = new Map(hypotheses.map((h) => [cleLigne(h.source, h.sourceId), h]));
  const clients = new Map(donnees.facturesClients.map((f) => [f.id, f]));
  const fournisseurs = new Map(donnees.facturesFournisseurs.map((f) => [f.id, f]));
  const rentrees = new Map((donnees.rentreesRegulieres ?? []).map((r) => [r.id, r]));
  const lignes = new Map<string, LigneProbabiliste>();
  const evenements: EvenementTresorerie[] = [];
  const compteurs = new Map<string, number>();
  const etageParDefaut = (source: SourceFlux): EtagePnl | null =>
    source === "facture_client" || source === "rentree_reguliere" ? "revenue" : source === "financement" ? "financing" : null;

  for (const f of flux) {
    if (f.montant === 0) continue;
    const cle = cleLigne(f.source, f.sourceId);
    const h = parCle.get(cle);
    const dims = DIMENSIONS[f.source];
    const defaut = hypotheseParDefaut(f.source);
    if (!lignes.has(cle)) {
      lignes.set(cle, {
        cle,
        probabilite: h?.probabilite ?? defaut.probabilite,
        condition: conditionVersMoteur(h?.condition ?? null),
        fiabiliteMontant: dims.montant ? (h?.fiabiliteMontant ?? defaut.fiabiliteMontant) : 100,
        modeDate: dims.date,
        aRenseigner: estARenseigner(f.source, h),
      });
    }
    let tiers: string | null = null;
    let dateEcheance: string | null = null;
    let montant = Math.abs(f.montant);
    if (f.source === "facture_client") {
      const facture = clients.get(f.sourceId);
      tiers = facture?.client ?? null;
      dateEcheance = facture?.dateEcheance || null;
    } else if (f.source === "facture_fournisseur") {
      const facture = fournisseurs.get(f.sourceId);
      tiers = facture?.fournisseur ?? null;
      dateEcheance = facture?.dateEcheance || null;
    } else if (f.source === "rentree_reguliere" && h?.montantCible != null && rentrees.get(f.sourceId)?.modeMontant === "fixe") {
      // Valeur cible saisie : elle remplace le montant de chaque échéance (mode fixe seulement).
      montant = h.montantCible;
    }
    if (!(montant > 0)) continue;
    const rang = compteurs.get(cle) ?? 0;
    compteurs.set(cle, rang + 1);
    evenements.push({
      id: `${cle}#${rang}`,
      cleLigne: cle,
      libelle: f.libelle,
      montant,
      sens: f.montant > 0 ? "encaissement" : "decaissement",
      datePrevue: f.date,
      dateEcheance,
      fiabiliteDate: h?.fiabiliteDate ?? defaut.fiabiliteDate,
      tiers,
      etage: etageDe ? etageDe(f.source, f.sourceId) : etageParDefaut(f.source),
    });
  }
  return { lignes: Array.from(lignes.values()), evenements };
}

export interface OrdreLignes {
  ordre: LigneProbabiliste[]; // parents avant enfants
  // Dépendances ignorées (ligne absente de l'horizon, boucle) : la ligne devient indépendante.
  dependancesIgnorees: { cle: string; raison: "parent_absent" | "cycle" }[];
}

/** Ordre topologique des lignes ; une dépendance invalide est ignorée et signalée, jamais bloquante. */
export function ordonnerLignes(lignes: LigneProbabiliste[]): OrdreLignes {
  const parCle = new Map(lignes.map((l) => [l.cle, { ...l }]));
  const dependancesIgnorees: OrdreLignes["dependancesIgnorees"] = [];
  const parent = (l: LigneProbabiliste) => parentDeCondition(l.condition);
  parCle.forEach((l) => {
    const p = parent(l);
    if (p !== null && (!parCle.has(p) || p === l.cle)) {
      dependancesIgnorees.push({ cle: l.cle, raison: p === l.cle ? "cycle" : "parent_absent" });
      l.condition = null;
    }
  });
  parCle.forEach((l) => {
    const vus = new Set<string>([l.cle]);
    let courant = parent(l);
    while (courant !== null) {
      if (vus.has(courant)) {
        dependancesIgnorees.push({ cle: l.cle, raison: "cycle" });
        l.condition = null;
        break;
      }
      vus.add(courant);
      const suivant = parCle.get(courant);
      courant = suivant ? parent(suivant) : null;
    }
  });
  const ordre: LigneProbabiliste[] = [];
  const places = new Set<string>();
  const placer = (l: LigneProbabiliste) => {
    if (places.has(l.cle)) return;
    const p = parent(l);
    if (p !== null) placer(parCle.get(p)!);
    places.add(l.cle);
    ordre.push(l);
  };
  parCle.forEach(placer);
  return { ordre, dependancesIgnorees };
}

/** Lignes qui dépendent (directement ou non) de `cle` : on ne peut pas les choisir comme parent. */
export function descendants(lignes: { cle: string; parentCle: string | null }[], cle: string): Set<string> {
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
