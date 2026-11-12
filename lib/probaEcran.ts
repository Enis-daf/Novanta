import type { FluxProjete, SourceFlux } from "./cash-engine";
import { formatMontant } from "./format";
import { normaliserRecherche } from "./recherche";
import { GROUPES_ETAGE, GroupeEtage, LIBELLE_A_CLASSER } from "./futurPnl";
import { LIBELLE_ENCAISSEMENTS } from "./pastCategoryMapping";
import {
  cleLigne,
  ConditionSaisie,
  DIMENSIONS,
  estARenseigner,
  FiabiliteDate,
  FiabiliteMontant,
  hypotheseParDefaut,
  HypotheseLigne,
  ProbabiliteSaisie,
} from "./probaEvenements";

/**
 * Prévision probabiliste — écran des hypothèses. Fonctions pures (testées sans interface).
 *
 * Un écran de pilotage, pas une liste de transactions : les lignes de Futur sont regroupées par
 * étage P&L (taxonomie existante de Futur, lib/futurPnl.ts : Encaissements, puis GROUPES_ETAGE,
 * « À classer » en dernier), triées par impact décroissant dans chaque étage, et chaque étage
 * se résume en une phrase (nombre d'hypothèses, impact, à renseigner).
 *
 * Matérialité. Novanta n'a pas encore de notion de matérialité (aucun seuil existant dans le
 * code) : on retient l'approche la plus prudente, paramétrée ici seulement. Une ligne est
 * IMPORTANTE si son impact (somme de ses montants sur l'horizon) atteint `partDesFlux` du total
 * des flux de l'horizon (encaissements + décaissements, en valeur absolue). Une ligne importante à
 * renseigner bloque la prévision probabiliste ; une ligne secondaire à renseigner la laisse
 * calculer, avec un avertissement.
 */

export const CONFIG_MATERIALITE = {
  partDesFlux: 0.05,
} as const;

/** Groupe d'affichage : encaissements, un groupe d'étage de dépense, ou « À classer ». */
export type CleGroupeHypotheses = "revenue" | GroupeEtage | "a_classer";

export const ORDRE_GROUPES: readonly { cle: CleGroupeHypotheses; libelle: string }[] = [
  { cle: "revenue", libelle: LIBELLE_ENCAISSEMENTS },
  ...GROUPES_ETAGE,
  { cle: "a_classer", libelle: LIBELLE_A_CLASSER },
];

export interface HypotheseEffective {
  probabilite: ProbabiliteSaisie;
  fiabiliteDate: FiabiliteDate;
  fiabiliteMontant: FiabiliteMontant;
  montantCible: number | null;
  condition: ConditionSaisie | null;
}

export const LIBELLES_SOURCE: Record<SourceFlux, string> = {
  facture_client: "Facture client",
  facture_fournisseur: "Facture fournisseur",
  financement: "Financement",
  charge_fixe: "Charge fixe",
  autre_depense: "Autre dépense",
  rentree_reguliere: "Rentrée régulière",
};

export interface LigneHypothese {
  cle: string;
  source: SourceFlux;
  sourceId: string;
  libelle: string;
  encaissement: boolean;
  impact: number; // somme des montants de l'horizon retenus par le moteur, en valeur absolue
  // Montant de référence de chaque échéance, tel que le moteur le simule ; null si les échéances
  // n'ont pas toutes le même montant (saisonnalité, montant calculé).
  montantParEcheance: number | null;
  premiereDate: string; // date prévue de la première échéance : plancher de la date simulée
  dateEcheance: string | null; // échéance contractuelle (factures) : point de départ des retards
  echeances: number;
  groupe: CleGroupeHypotheses;
  hypothese: HypotheseEffective;
  aRenseigner: boolean;
  importante: boolean;
}

/**
 * Lignes de l'écran depuis les flux de la projection. `groupeDe` donne le groupe P&L de la ligne
 * (classement existant de Futur) ; une ligne sans flux sur l'horizon n'apparaît pas.
 */
export function construireLignesHypotheses(
  flux: FluxProjete[],
  hypotheses: ReadonlyMap<string, HypotheseLigne>,
  groupeDe: (source: SourceFlux, sourceId: string) => CleGroupeHypotheses,
  // Mêmes règles que lib/probaEvenements.ts::construireEvenements : la valeur cible enregistrée
  // remplace le montant des rentrées régulières à montant fixe ; l'échéance des factures.
  options: { rentreesFixes?: ReadonlySet<string>; echeanceDe?: (source: SourceFlux, sourceId: string) => string | null } = {}
): LigneHypothese[] {
  const parCle = new Map<string, LigneHypothese>();
  for (const f of flux) {
    if (f.montant === 0) continue;
    const cle = cleLigne(f.source, f.sourceId);
    const h = hypotheses.get(cle);
    const cible = f.source === "rentree_reguliere" && options.rentreesFixes?.has(cle) && h?.montantCible ? h.montantCible : null;
    const montant = cible ?? Math.abs(f.montant);
    const existante = parCle.get(cle);
    if (existante) {
      existante.impact += montant;
      existante.echeances++;
      if (existante.montantParEcheance !== null && Math.abs(existante.montantParEcheance - montant) > 0.005) existante.montantParEcheance = null;
      if (f.date < existante.premiereDate) existante.premiereDate = f.date;
      continue;
    }
    const defaut = hypotheseParDefaut(f.source);
    parCle.set(cle, {
      cle,
      source: f.source,
      sourceId: f.sourceId,
      libelle: f.libelle,
      encaissement: f.montant > 0,
      impact: montant,
      montantParEcheance: montant,
      premiereDate: f.date,
      dateEcheance: options.echeanceDe?.(f.source, f.sourceId) || null,
      echeances: 1,
      groupe: groupeDe(f.source, f.sourceId),
      hypothese: {
        probabilite: h?.probabilite ?? defaut.probabilite,
        fiabiliteDate: h?.fiabiliteDate ?? defaut.fiabiliteDate,
        fiabiliteMontant: DIMENSIONS[f.source].montant ? (h?.fiabiliteMontant ?? defaut.fiabiliteMontant) : 100,
        montantCible: h?.montantCible ?? null,
        condition: h?.condition ?? null,
      },
      aRenseigner: estARenseigner(f.source, h),
      importante: false,
    });
  }
  const lignes = Array.from(parCle.values());
  const total = lignes.reduce((s, l) => s + l.impact, 0);
  const seuil = total * CONFIG_MATERIALITE.partDesFlux;
  for (const l of lignes) l.importante = total > 0 && l.impact >= seuil;
  return lignes;
}

// ---------------------------------------------------------------------------------------------
// Complétude
// ---------------------------------------------------------------------------------------------

export interface Completude {
  aRenseigner: number;
  importantesARenseigner: number;
  secondairesARenseigner: number;
  incertaines: number; // probabilité < 100 %
  bloquee: boolean; // au moins une hypothèse importante à renseigner
}

export function completude(lignes: LigneHypothese[]): Completude {
  const aRenseigner = lignes.filter((l) => l.aRenseigner);
  const importantes = aRenseigner.filter((l) => l.importante).length;
  return {
    aRenseigner: aRenseigner.length,
    importantesARenseigner: importantes,
    secondairesARenseigner: aRenseigner.length - importantes,
    incertaines: lignes.filter((l) => !l.aRenseigner && l.hypothese.probabilite < 100).length,
    bloquee: importantes > 0,
  };
}

const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? "s" : ""}`;

/** Phrase de la cartouche « À renseigner » ; null quand tout est renseigné. */
export function phraseARenseigner(c: Completude): string | null {
  return c.aRenseigner === 0 ? null : `${pluriel(c.aRenseigner, "hypothèse")} à renseigner`;
}

/** Message d'état de la prévision selon la complétude ; null quand elle est complète. */
export function messageCompletude(c: Completude): string | null {
  if (c.bloquee) {
    return `Prévision probabiliste indisponible — ${pluriel(c.importantesARenseigner, "hypothèse")} importante${c.importantesARenseigner > 1 ? "s" : ""} ${c.importantesARenseigner > 1 ? "doivent" : "doit"} être renseignée${c.importantesARenseigner > 1 ? "s" : ""}.`;
  }
  if (c.secondairesARenseigner > 0) {
    return `Prévision calculée avec ${pluriel(c.secondairesARenseigner, "hypothèse")} secondaire${c.secondairesARenseigner > 1 ? "s" : ""} non renseignée${c.secondairesARenseigner > 1 ? "s" : ""}, prise${c.secondairesARenseigner > 1 ? "s" : ""} telle${c.secondairesARenseigner > 1 ? "s" : ""} que saisie${c.secondairesARenseigner > 1 ? "s" : ""} dans Futur.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Filtres et regroupement
// ---------------------------------------------------------------------------------------------

export type FiltreHypotheses = "toutes" | "a_renseigner" | ProbabiliteSaisie;

export const FILTRES_HYPOTHESES: readonly { cle: FiltreHypotheses; libelle: string }[] = [
  { cle: "toutes", libelle: "Toutes" },
  { cle: "a_renseigner", libelle: "À renseigner" },
  { cle: 100, libelle: "100 %" },
  { cle: 75, libelle: "75 %" },
  { cle: 50, libelle: "50 %" },
  { cle: 25, libelle: "25 %" },
];

/** Une ligne à renseigner n'a pas encore de probabilité choisie : elle n'est que sous « À renseigner ». */
export function correspondAuFiltre(l: LigneHypothese, filtre: FiltreHypotheses): boolean {
  if (filtre === "toutes") return true;
  if (filtre === "a_renseigner") return l.aRenseigner;
  return !l.aRenseigner && l.hypothese.probabilite === filtre;
}

/**
 * Recherche dans l'écran : libellé (n° de facture et tiers compris), type de ligne, étage P&L,
 * montant (« 25 000 », « 25000 »). Insensible à la casse et aux accents (lib/recherche.ts).
 */
export function correspondALaRecherche(l: LigneHypothese, recherche: string): boolean {
  const terme = normaliserRecherche(recherche);
  if (!terme) return true;
  const groupe = ORDRE_GROUPES.find((g) => g.cle === l.groupe)?.libelle ?? "";
  const champs = [l.libelle, LIBELLES_SOURCE[l.source], groupe, formatMontant(l.impact), String(Math.round(l.impact))];
  if (l.montantParEcheance !== null && l.echeances > 1) champs.push(formatMontant(l.montantParEcheance), String(Math.round(l.montantParEcheance)));
  // Espaces fines des montants formatés : « 25 000 » doit trouver « 25 000 € ».
  const espaces = (t: string) => normaliserRecherche(t).replace(/[\s\u202f\u00a0]/g, " ");
  return champs.some((c) => espaces(c).includes(espaces(terme)));
}

export interface GroupeHypotheses {
  cle: CleGroupeHypotheses;
  libelle: string;
  lignes: LigneHypothese[]; // impact décroissant
  nombre: number;
  impact: number;
  aRenseigner: number;
}

/**
 * Groupes non vides, dans l'ordre de la taxonomie ; lignes triées par impact décroissant. Filtre
 * et recherche se combinent ; un groupe sans résultat n'apparaît pas.
 */
export function grouperHypotheses(lignes: LigneHypothese[], filtre: FiltreHypotheses = "toutes", recherche = ""): GroupeHypotheses[] {
  const retenues = lignes.filter((l) => correspondAuFiltre(l, filtre) && correspondALaRecherche(l, recherche));
  return ORDRE_GROUPES.map(({ cle, libelle }) => {
    const dedans = retenues.filter((l) => l.groupe === cle).sort((a, b) => b.impact - a.impact || a.libelle.localeCompare(b.libelle));
    return {
      cle,
      libelle,
      lignes: dedans,
      nombre: dedans.length,
      impact: dedans.reduce((s, l) => s + l.impact, 0),
      aRenseigner: dedans.filter((l) => l.aRenseigner).length,
    };
  }).filter((g) => g.nombre > 0);
}

const formatK = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

/** « Coûts de structure — 14 hypothèses — 182 k€ d'impact — 3 à renseigner ». */
export function resumeGroupe(g: GroupeHypotheses): string {
  const impact = g.impact >= 1_000 ? `${formatK.format(Math.round(g.impact / 1_000))} k€` : `${formatK.format(Math.round(g.impact))} €`;
  const parties = [g.libelle, pluriel(g.nombre, "hypothèse"), `${impact} d'impact`];
  if (g.aRenseigner > 0) parties.push(`${g.aRenseigner} à renseigner`);
  return parties.join(" — ");
}

/**
 * Même règle de complétude, côté moteur (route serveur) : à partir des lignes et échéances reçues.
 * Le serveur refuse de calculer une prévision bloquée, quel que soit le navigateur.
 */
export function completudeMoteur(
  lignes: { cle: string; aRenseigner: boolean }[],
  evenements: { cleLigne: string; montant: number; datePrevue: string }[],
  horizonFin: string
): Pick<Completude, "aRenseigner" | "importantesARenseigner" | "secondairesARenseigner" | "bloquee"> {
  const impact = new Map<string, number>();
  let total = 0;
  for (const e of evenements) {
    if (e.datePrevue > horizonFin) continue;
    impact.set(e.cleLigne, (impact.get(e.cleLigne) ?? 0) + e.montant);
    total += e.montant;
  }
  const seuil = total * CONFIG_MATERIALITE.partDesFlux;
  const aRenseigner = lignes.filter((l) => l.aRenseigner);
  const importantes = aRenseigner.filter((l) => total > 0 && (impact.get(l.cle) ?? 0) >= seuil).length;
  return { aRenseigner: aRenseigner.length, importantesARenseigner: importantes, secondairesARenseigner: aRenseigner.length - importantes, bloquee: importantes > 0 };
}
