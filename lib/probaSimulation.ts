import { Alea, creerAlea, GRAINE_PAR_DEFAUT } from "./probaAlea";
import { Echantillonneur, echantillonneurPour, ModeleRetards } from "./probaCalibration";
import {
  ConditionMoteur,
  ECARTS_MONTANT,
  EvenementTresorerie,
  FACTEURS_FIABILITE,
  LigneProbabiliste,
  ordonnerLignes,
  OrdreLignes,
  parentDeCondition,
} from "./probaEvenements";
import { joursEntre } from "./pastBfrDelais";
import { ajouterJours, parseDateISO, toISODate } from "./dates";

/**
 * Prévision probabiliste — 4. Moteur de simulation. Fonction pure, sans interface ni base :
 * testable seule.
 *
 * Pour chaque simulation :
 *  1. on part de la trésorerie initiale ;
 *  2. les lignes certaines et sans condition sont toujours présentes ;
 *  3. chaque autre ligne est tirée selon sa probabilité (une fois par ligne) ;
 *  4. les conditions « Dépend de » sont évaluées : une ligne dont le parent n'existe pas n'existe
 *     pas ; une ligne à seuil n'existe que si l'indicateur, calculé DANS cette simulation au jour où
 *     elle démarrerait, satisfait le seuil ;
 *  5. les montants variables reçoivent un facteur (une fois par ligne), jamais négatif ;
 *  6. les dates sont simulées :
 *       - échéance par échéance (factures, financements, autres dépenses) :
 *           date = max(date prévue, base + facteur(fiabilité) × retard tiré de l'historique),
 *         base = l'échéance si la date prévue est postérieure (retard déjà anticipé), sinon la date
 *         prévue ; une facture déjà échue n'est jamais simulée comme réglée dans le passé ;
 *       - début de série (charges fixes, rentrées régulières) : toute la série est décalée d'un même
 *         retard ; « à partir du mois suivant » une autre ligne repousse aussi le début ;
 *  7. chaque flux est posé à sa date simulée — au-delà de l'horizon, il sort de la prévision ;
 *  8. la trésorerie est recalculée jour par jour sur tout l'horizon.
 *
 * Ordre d'évaluation des conditions à seuil : les lignes sans condition à seuil (ni ancêtre qui en a
 * une) sont posées d'abord ; les lignes conditionnelles le sont ensuite, de la plus précoce à la plus
 * tardive (un parent toujours avant ses enfants), chacune voyant les lignes déjà activées.
 *
 * Reproductible : même graine -> mêmes résultats.
 */

export const NOMBRE_SIMULATIONS_PAR_DEFAUT = 10_000;
const ESSAIS_CONDITIONNELS = 32;
const Z_90 = 1.2815515655446004; // quantile 90 % de la loi normale centrée réduite

export interface ParametresSimulation {
  soldeInitial: number;
  dateDepart: string; // YYYY-MM-DD, jour 0
  horizonJours: number;
  lignes: LigneProbabiliste[];
  evenements: EvenementTresorerie[];
  modeles: { client: ModeleRetards; fournisseur: ModeleRetards };
  nombreSimulations?: number;
  graine?: number;
}

export interface SimulationBrute {
  nombre: number;
  jours: number; // horizonJours + 1 (jour 0 inclus)
  dates: string[];
  // Soldes de fin de journée, par colonne de jour : soldes[jour * nombre + simulation].
  soldes: Float64Array;
  minimums: Float64Array;
  jourDuMinimum: Int32Array;
  premierJourNegatif: Int32Array; // -1 : jamais sous zéro
  // Part des simulations où chaque ligne existe (contrôle et explication).
  partPresence: Map<string, number>;
  dependancesIgnorees: OrdreLignes["dependancesIgnorees"];
}

interface EvenementPrepare {
  ligne: number;
  montantSigne: number;
  jourPrevu: number;
  // Date la plus tôt possible : la date prévue, ou aujourd'hui pour une date estimée (médiane).
  plancher: number;
  jourBase: number;
  facteur: number;
  echantillonneur: Echantillonneur | null;
  ca: boolean; // encaissement classé en CA
  coutDirect: boolean; // décaissement classé en coûts directs
}

interface LignePreparee {
  source: LigneProbabiliste;
  parent: number; // -1 : aucun
  condition: ConditionMoteur | null;
  phase2: boolean; // condition à seuil (ou ancêtre conditionnel)
  evenements: number[];
  ecartMontant: number;
  // Début de série : retard commun tiré de l'échantillonneur de la première échéance.
  facteurDebut: number;
  echantillonneurDebut: Echantillonneur | null;
  premierJourPrevu: number;
}

/** Jour simulé d'une échéance (peut dépasser l'horizon). */
export function simulerJour(e: Pick<EvenementPrepare, "jourPrevu" | "jourBase" | "facteur" | "echantillonneur"> & { plancher?: number }, alea: Alea): number {
  const plancher = Math.max(e.plancher ?? e.jourPrevu, 0);
  if (e.facteur <= 0 || e.echantillonneur === null) return plancher;
  const requis = -e.jourBase;
  for (let essai = 0; essai < ESSAIS_CONDITIONNELS; essai++) {
    const retard = Math.round(e.facteur * e.echantillonneur.tirer(alea));
    if (retard >= requis) return Math.max(plancher, e.jourBase + retard);
  }
  return plancher;
}

/**
 * Facteur de montant : loi normale de moyenne 1 tronquée à des valeurs positives, dont 8 cas sur 10
 * tombent à ± écart de la cible. Jamais négatif, jamais nul.
 */
export function tirerFacteurMontant(ecart: number, alea: Alea): number {
  if (ecart <= 0) return 1;
  const dispersion = ecart / Z_90;
  for (let essai = 0; essai < 64; essai++) {
    const f = 1 + dispersion * alea.normale();
    if (f > 0) return f;
  }
  return 1;
}

/** Index (relatif au départ) du 1er jour du mois `decalage` mois après celui du jour `jour`. */
function debutMoisApres(depart: Date, jour: number, decalage: number): number {
  const d = ajouterJours(depart, jour);
  const cible = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + decalage, 1));
  return Math.round((cible.getTime() - Date.UTC(depart.getUTCFullYear(), depart.getUTCMonth(), depart.getUTCDate())) / 86_400_000);
}

/**
 * Préparation commune au tirage Monte Carlo et aux trajectoires déterministes (tests de sensibilité,
 * lib/probaRisques.ts) : mêmes lignes, mêmes échéances, mêmes conditions « Dépend de ».
 */
export interface PreparationSimulation {
  soldeInitial: number;
  jours: number;
  dates: string[];
  depart: Date;
  moisPrecedent: (readonly [number, number])[];
  lignes: LignePreparee[];
  evenements: EvenementPrepare[];
  // Échéance d'origine de chaque événement préparé (même index que `evenements`).
  sources: EvenementTresorerie[];
  phase2: number[];
  dependancesIgnorees: OrdreLignes["dependancesIgnorees"];
}

export function preparerSimulation(params: Omit<ParametresSimulation, "nombreSimulations" | "graine">): PreparationSimulation {
  const horizon = Math.max(0, Math.floor(params.horizonJours));
  const jours = horizon + 1;
  const debut = parseDateISO(params.dateDepart);
  const depart = new Date(Date.UTC(debut.getFullYear(), debut.getMonth(), debut.getDate()));
  const dates = Array.from({ length: jours }, (_, i) => toISODate(ajouterJours(debut, i)));
  // Bornes du mois précédent, pour chaque jour de l'horizon : [début, fin] en index (peuvent être < 0).
  const moisPrecedent = Array.from({ length: jours }, (_, j) => [debutMoisApres(depart, j, -1), debutMoisApres(depart, j, 0) - 1] as const);

  const { ordre, dependancesIgnorees } = ordonnerLignes(params.lignes);
  const indexLigne = new Map(ordre.map((l, i) => [l.cle, i]));
  const lignes: LignePreparee[] = ordre.map((l) => {
    const parentCle = parentDeCondition(l.condition);
    return {
      source: l,
      parent: parentCle !== null ? indexLigne.get(parentCle) ?? -1 : -1,
      condition: l.condition,
      phase2: false,
      evenements: [],
      ecartMontant: ECARTS_MONTANT[l.fiabiliteMontant] ?? 0,
      facteurDebut: 0,
      echantillonneurDebut: null,
      premierJourPrevu: Infinity,
    };
  });
  // Ordre topologique : le parent est déjà marqué quand on arrive à l'enfant.
  for (const l of lignes) l.phase2 = l.condition?.type === "seuil" || (l.parent >= 0 && lignes[l.parent].phase2);

  const evenements: EvenementPrepare[] = [];
  const sources: EvenementTresorerie[] = [];
  for (const e of params.evenements) {
    const i = indexLigne.get(e.cleLigne);
    if (i === undefined || !(e.montant > 0)) continue;
    const ligne = lignes[i];
    const jourPrevu = joursEntre(params.dateDepart, e.datePrevue);
    const facteur = FACTEURS_FIABILITE[e.fiabiliteDate] ?? 0;
    const modele = e.sens === "encaissement" ? params.modeles.client : params.modeles.fournisseur;
    const echantillonneur = facteur > 0 ? echantillonneurPour(modele, e.tiers, e.montant) : null;
    if (ligne.source.modeDate === "debut" && jourPrevu < ligne.premierJourPrevu) {
      ligne.facteurDebut = facteur;
      ligne.echantillonneurDebut = echantillonneur;
    }
    ligne.premierJourPrevu = Math.min(ligne.premierJourPrevu, jourPrevu);
    ligne.evenements.push(evenements.length);
    sources.push(e);
    evenements.push({
      ligne: i,
      montantSigne: e.sens === "encaissement" ? e.montant : -e.montant,
      jourPrevu,
      plancher: e.dateEstimee ? 0 : Math.max(jourPrevu, 0),
      jourBase: e.dateEcheance ? Math.min(joursEntre(params.dateDepart, e.dateEcheance), jourPrevu) : jourPrevu,
      facteur: ligne.source.modeDate === "debut" ? 0 : facteur,
      echantillonneur: ligne.source.modeDate === "debut" ? null : echantillonneur,
      ca: e.sens === "encaissement" && e.etage === "revenue",
      coutDirect: e.sens === "decaissement" && e.etage === "gross_margin",
    });
  }
  const phase2 = lignes.map((l, i) => (l.phase2 ? i : -1)).filter((i) => i >= 0);
  return { soldeInitial: params.soldeInitial, jours, dates, depart, moisPrecedent, lignes, evenements, sources, phase2, dependancesIgnorees };
}

/** Tampons d'une passe : réutilisés d'une simulation (ou d'un test) à l'autre. */
interface Tampons {
  variations: Float64Array;
  ca: Float64Array;
  coutsDirects: Float64Array;
  tirage: Uint8Array;
  etat: Uint8Array; // 0 à traiter, 1 présente, 2 absente
  facteurMontant: Float64Array;
  premierJour: Float64Array;
  jourEvenement: Int32Array; // jour de l'encaissement / décaissement (jours = hors horizon)
  jourCA: Int32Array; // jour où l'encaissement compte dans le CA (= jourEvenement en Monte Carlo)
}

function creerTampons(prep: PreparationSimulation): Tampons {
  return {
    variations: new Float64Array(prep.jours),
    ca: new Float64Array(prep.jours),
    coutsDirects: new Float64Array(prep.jours),
    tirage: new Uint8Array(prep.lignes.length),
    etat: new Uint8Array(prep.lignes.length),
    facteurMontant: new Float64Array(prep.lignes.length),
    premierJour: new Float64Array(prep.lignes.length),
    jourEvenement: new Int32Array(prep.evenements.length),
    jourCA: new Int32Array(prep.evenements.length),
  };
}

/**
 * Pose les lignes présentes dans `t.variations` à partir des tirages, facteurs et jours déjà
 * fixés : existence (parent présent), puis conditions à seuil évaluées dans l'ordre des
 * démarrages. SEULE définition de la placement : Monte Carlo et tests de sensibilité la partagent.
 */
function placerLignes(prep: PreparationSimulation, t: Tampons): void {
  const { jours, lignes, evenements, moisPrecedent } = prep;
  t.variations.fill(0);
  t.ca.fill(0);
  t.coutsDirects.fill(0);
  t.etat.fill(0);
  const somme = (tab: Float64Array, de: number, a: number) => {
    let s = 0;
    for (let j = Math.max(0, de); j <= Math.min(a, jours - 1); j++) s += tab[j];
    return s;
  };
  const conditionSatisfaite = (c: ConditionMoteur & { type: "seuil" }, jour: number): boolean => {
    if (jour >= jours) return false; // démarrerait après l'horizon : sans effet sur la prévision
    let valeur: number;
    if (c.indicateur === "tresorerie") {
      valeur = prep.soldeInitial + somme(t.variations, 0, jour - 1);
    } else {
      const [de, a] = moisPrecedent[Math.max(0, jour)];
      const chiffre = somme(t.ca, de, a);
      if (c.indicateur === "ca_mois_precedent") valeur = chiffre;
      else {
        if (chiffre <= 0) return false; // marge indéfinie sans CA : condition non remplie
        valeur = ((chiffre - somme(t.coutsDirects, de, a)) / chiffre) * 100;
      }
    }
    return c.comparateur === ">" ? valeur > c.valeur : valeur < c.valeur;
  };
  const poser = (i: number) => {
    const f = t.facteurMontant[i];
    for (const k of lignes[i].evenements) {
      const e = evenements[k];
      const m = e.montantSigne * f;
      const j = t.jourEvenement[k];
      if (j < jours) t.variations[j] += m;
      const jca = t.jourCA[k];
      if (jca < jours) {
        if (e.ca) t.ca[jca] += m;
        if (e.coutDirect) t.coutsDirects[jca] -= m;
      }
    }
  };
  const traiterPhase2 = (i: number) => {
    if (t.etat[i] !== 0) return;
    const l = lignes[i];
    if (l.parent >= 0) traiterPhase2(l.parent);
    const parentOk = l.parent < 0 || t.etat[l.parent] === 1;
    const ok = t.tirage[i] === 1 && parentOk && (l.condition?.type !== "seuil" || conditionSatisfaite(l.condition, t.premierJour[i]));
    t.etat[i] = ok ? 1 : 2;
    if (ok) poser(i);
  };
  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i];
    if (!l.phase2) t.etat[i] = t.tirage[i] === 1 && (l.parent < 0 || t.etat[l.parent] === 1) ? 1 : 2;
  }
  for (let i = 0; i < lignes.length; i++) if (!lignes[i].phase2 && t.etat[i] === 1) poser(i);
  if (prep.phase2.length > 0) {
    const ordrePhase2 = [...prep.phase2].sort((a, b) => t.premierJour[a] - t.premierJour[b]);
    for (const i of ordrePhase2) traiterPhase2(i);
  }
}

/** Premier jour autorisé par « à partir du mois suivant » une autre ligne (-∞ sans condition). */
function debutAutoriseDe(prep: PreparationSimulation, t: Tampons, i: number): number {
  const l = prep.lignes[i];
  if (l.condition?.type !== "apres_evenement" || l.parent < 0) return -Infinity;
  const jourParent = t.premierJour[l.parent];
  return jourParent >= prep.jours ? Infinity : debutMoisApres(prep.depart, jourParent, 1 + l.condition.decalageMois);
}

/**
 * Trajectoire déterministe : toutes les lignes prévues, à leurs montants et dates de référence,
 * conditions « Dépend de » évaluées — sauf les échéances dont le jour est imposé par `forces`
 * (index d'événement -> jour, `jours` ou plus = au-delà de l'horizon). Un jour imposé ne change que
 * la date de l'encaissement : le CA reste compté à sa date de référence (un retard de paiement ne
 * décale pas le chiffre d'affaires). Rien n'est enregistré nulle part.
 */
export interface Trajectoire {
  soldes: Float64Array; // solde de fin de journée
  presentes: Uint8Array; // 1 : ligne présente dans ce scénario
  jours: Int32Array; // jour retenu pour chaque événement préparé (jours = au-delà de l'horizon)
}

export function creerEvaluateur(prep: PreparationSimulation): (forces?: ReadonlyMap<number, number>) => Trajectoire {
  const t = creerTampons(prep);
  const { lignes, evenements, jours } = prep;
  return (forces) => {
    for (let i = 0; i < lignes.length; i++) {
      const l = lignes[i];
      t.tirage[i] = 1;
      t.facteurMontant[i] = 1;
      const debutAutorise = debutAutoriseDe(prep, t, i);
      const decalage = l.source.modeDate === "debut" && debutAutorise > l.premierJourPrevu ? debutAutorise - l.premierJourPrevu : 0;
      let premier = Infinity;
      for (const k of l.evenements) {
        const reference = Math.max(evenements[k].jourPrevu, 0);
        const jourRef = l.source.modeDate === "debut" ? reference + decalage : Math.max(reference, debutAutorise);
        const force = forces?.get(k);
        const jour = force !== undefined ? Math.max(force, jourRef) : jourRef;
        t.jourEvenement[k] = jour >= jours ? jours : jour;
        t.jourCA[k] = jourRef >= jours ? jours : jourRef;
        if (jour < premier) premier = jour;
      }
      t.premierJour[i] = premier;
    }
    placerLignes(prep, t);
    const soldes = new Float64Array(jours);
    let solde = prep.soldeInitial;
    for (let j = 0; j < jours; j++) {
      solde += t.variations[j];
      soldes[j] = solde;
    }
    return { soldes, presentes: Uint8Array.from(t.etat, (e) => (e === 1 ? 1 : 0)), jours: Int32Array.from(t.jourEvenement) };
  };
}

export function simuler(params: ParametresSimulation): SimulationBrute {
  const nombre = Math.max(1, Math.floor(params.nombreSimulations ?? NOMBRE_SIMULATIONS_PAR_DEFAUT));
  const alea = creerAlea(params.graine ?? GRAINE_PAR_DEFAUT);
  const prep = preparerSimulation(params);
  const { jours, dates, lignes, evenements, dependancesIgnorees } = prep;
  const t = creerTampons(prep);

  const soldes = new Float64Array(jours * nombre);
  const minimums = new Float64Array(nombre);
  const jourDuMinimum = new Int32Array(nombre);
  const premierJourNegatif = new Int32Array(nombre);
  const presences = new Uint32Array(lignes.length);

  for (let s = 0; s < nombre; s++) {
    // Existence (tirage par ligne), montants, dates — dans l'ordre topologique.
    for (let i = 0; i < lignes.length; i++) {
      const l = lignes[i];
      const p = l.source.probabilite;
      t.tirage[i] = p >= 100 ? 1 : p <= 0 ? 0 : alea.uniforme() < p / 100 ? 1 : 0;
      t.facteurMontant[i] = tirerFacteurMontant(l.ecartMontant, alea);
      const debutAutorise = debutAutoriseDe(prep, t, i);
      let premier = Infinity;
      if (l.source.modeDate === "debut") {
        // Toute la série glisse d'un même décalage : retard tiré, puis début autorisé.
        let decalage = l.facteurDebut > 0 && l.echantillonneurDebut ? Math.max(0, Math.round(l.facteurDebut * l.echantillonneurDebut.tirer(alea))) : 0;
        if (debutAutorise > l.premierJourPrevu + decalage) decalage = debutAutorise - l.premierJourPrevu;
        for (const k of l.evenements) {
          const jour = Math.max(evenements[k].jourPrevu, 0) + decalage;
          t.jourEvenement[k] = jour >= jours ? jours : jour;
          if (jour < premier) premier = jour;
        }
      } else {
        for (const k of l.evenements) {
          const jour = Math.max(simulerJour(evenements[k], alea), debutAutorise);
          t.jourEvenement[k] = jour >= jours ? jours : jour;
          if (jour < premier) premier = jour;
        }
      }
      t.premierJour[i] = premier;
    }
    t.jourCA.set(t.jourEvenement);
    placerLignes(prep, t);
    for (let i = 0; i < lignes.length; i++) if (t.etat[i] === 1) presences[i]++;

    let solde = params.soldeInitial;
    let minimum = Infinity;
    let jourMin = 0;
    let negatif = -1;
    for (let j = 0; j < jours; j++) {
      solde += t.variations[j];
      soldes[j * nombre + s] = solde;
      if (solde < minimum) {
        minimum = solde;
        jourMin = j;
      }
      if (negatif < 0 && solde < 0) negatif = j;
    }
    minimums[s] = minimum;
    jourDuMinimum[s] = jourMin;
    premierJourNegatif[s] = negatif;
  }

  const partPresence = new Map(lignes.map((l, i) => [l.source.cle, presences[i] / nombre]));
  return { nombre, jours, dates, soldes, minimums, jourDuMinimum, premierJourNegatif, partPresence, dependancesIgnorees };
}
