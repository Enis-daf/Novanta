import { creerAlea } from "./probaAlea";
import { echantillonneurPour, ModeleRetards } from "./probaCalibration";
import { cleTiers } from "./probaHistorique";
import { joursEntre } from "./pastBfrDelais";
import { creerEvaluateur, ParametresSimulation, preparerSimulation } from "./probaSimulation";

/**
 * Gestion des risques — Encaissements critiques. Fonctions pures, sans interface ni base.
 *
 * Question : quels encaissements doivent arriver à temps pour que la trésorerie reste ≥ 0, et
 * quelle marge de retard peut-on absorber ?
 *
 * RÉFÉRENCE. Une trajectoire déterministe unique et reconstructible (lib/probaSimulation.ts::
 * creerEvaluateur) : solde initial et horizon de Futur, toutes les lignes prévues de la projection
 * (mêmes règles d'inclusion que la courbe « Flux de tréso »), à leurs montants et dates de
 * référence, conditions « Dépend de » évaluées. Jamais la courbe P50 : les percentiles quotidiens ne
 * forment pas une trajectoire.
 *
 * SCÉNARIO DE STRESS. Le seul changement est la date d'encaissement des factures testées, décalée
 * de k jours (granularité journalière du moteur) ; tout le reste est identique et les conditions
 * dépendant de la trésorerie sont réévaluées. Le chiffre d'affaires reste compté à sa date de
 * référence (un retard de paiement ne décale pas le CA). Une facture décalée au-delà de l'horizon
 * est encaissée après l'horizon : jamais supprimée. Rien n'est enregistré.
 *
 * FRANCHISSEMENT. Solde de fin de journée strictement négatif (un solde nul n'est pas négatif).
 *
 * DÉTECTION — balayage complet de k (aucune hypothèse de monotonie : une dépense conditionnelle
 * peut rendre un retard plus long moins grave) :
 *  - facture seule : premier k pour lequel le retard crée un épisode négatif absent de la référence ;
 *  - duo (A, B) au même retard k : A seule ne crée rien, B seule ne crée rien, A et B ensemble
 *    créent un épisode (comparaison des quatre situations) ; une paire contenant une facture déjà
 *    critique seule AU MÊME k n'est pas un duo ;
 *  - aggravation : facture jamais critique seule, dont le retard rend une tension déjà prévue plus
 *    profonde, plus précoce ou plus longue.
 *
 * Calcul exact rapide sans condition dépendante : sans condition à seuil ni « à partir du mois
 * suivant » rattachée à une facture testée, décaler un encaissement retire son montant du solde
 * entre sa date de référence et sa date testée (vérifié contre l'évaluation complète dans les
 * tests). Une paire est écartée sans calcul seulement si elle ne peut pas passer sous zéro même
 * avec ses deux montants retirés (borne exacte) : aucune petite paire n'est oubliée. Avec des
 * conditions dépendantes, chaque scénario est réévalué complètement, dans un budget ; s'il est
 * atteint, l'analyse est signalée partielle avec son périmètre.
 *
 * PLAUSIBILITÉ. Part des paiements qui, selon l'historique du compte (client d'abord, puis
 * segment, compte), arriveraient à la date testée ou après — sachant que la facture n'est pas
 * réglée aujourd'hui. Non estimée quand le modèle est peu calibré ou repose surtout sur les
 * hypothèses par défaut. Jamais de probabilité conjointe pour un duo (deux factures d'un même
 * client ne sont pas indépendantes).
 */

export interface FactureAnalysee {
  cleLigne: string;
  type: "facture_client" | "facture_previsionnelle";
  numero: string | null;
  client: string;
  dateEcheance: string | null;
}

export interface ParametresRisques extends Omit<ParametresSimulation, "nombreSimulations" | "graine"> {
  factures: FactureAnalysee[];
  perimetre?: PerimetreFactures;
  // Budget des réévaluations complètes (cas avec conditions dépendantes) : nombre et durée.
  budgetEvaluations?: number;
  budgetMs?: number;
  echantillonsPlausibilite?: number;
}

/**
 * Paramètres de l'analyse (seul endroit où ils se règlent).
 *  - budgetMs / budgetEvaluations : ne bornent QUE la réévaluation complète (conditions dépendant
 *    de la trésorerie) ; la méthode exacte sans condition n'a pas de budget. Atteint : arrêt
 *    déclaré (couverture.arret), jamais silencieux ;
 *  - limitesAffichage : taille de la RÉPONSE seulement (le calcul est complet) — alertes détaillées
 *    et courbes par tension, combinaisons listées en plus ; le total calculé est toujours renvoyé.
 */
export const CONFIG_ANALYSE_RISQUES = {
  budgetMs: 8_000,
  budgetEvaluations: 500_000,
  limitesAffichage: { alertesParGroupe: 10, courbesParGroupe: 3, autresParGroupe: 200 },
} as const;
const LIMITES_AFFICHAGE = CONFIG_ANALYSE_RISQUES.limitesAffichage;
const TOLERANCE = 0.005; // un centime : en deçà, deux soldes sont égaux

export interface Mesures {
  premierNegatif: number | null; // jour (index) du premier solde < 0
  minimum: number;
  jourMinimum: number;
  // Épisode négatif concerné (le premier nouvel épisode, sinon le premier épisode).
  episodeDebut: number | null;
  episodeFin: number | null; // dernier jour négatif de l'épisode
  retourPositif: boolean; // false : toujours négatif à la fin de l'horizon
  dureeJours: number;
  deficitMax: number; // ≥ 0 : montant à couvrir pour rester ≥ 0 dans ce scénario
}

export type NatureImpact = "declenchement" | "aggravation" | "aucun";

function episodes(soldes: Float64Array): [number, number][] {
  const liste: [number, number][] = [];
  let debut = -1;
  for (let j = 0; j < soldes.length; j++) {
    if (soldes[j] < 0) {
      if (debut < 0) debut = j;
    } else if (debut >= 0) {
      liste.push([debut, j - 1]);
      debut = -1;
    }
  }
  if (debut >= 0) liste.push([debut, soldes.length - 1]);
  return liste;
}

/** Mesures d'une trajectoire, et nature de son écart avec la référence. */
export function mesurer(soldes: Float64Array, reference: Float64Array, jourCible?: number): { mesures: Mesures; nature: NatureImpact } {
  let minimum = Infinity;
  let jourMinimum = 0;
  for (let j = 0; j < soldes.length; j++) {
    if (soldes[j] < minimum) {
      minimum = soldes[j];
      jourMinimum = j;
    }
  }
  const eps = episodes(soldes);
  const estNouveau = ([d, f]: [number, number]) => {
    for (let j = d; j <= f; j++) if (reference[j] < 0) return false;
    return true;
  };
  // Plusieurs épisodes : celui qui contient le jour visé, sinon le premier nouvel épisode.
  const cible = jourCible !== undefined ? eps.find(([d, f]) => d <= jourCible && jourCible <= f) : undefined;
  const nouveau = cible && estNouveau(cible) ? cible : jourCible === undefined ? eps.find(estNouveau) : undefined;
  const retenu = nouveau ?? cible ?? eps[0] ?? null;
  let minEpisode = 0;
  if (retenu) for (let j = retenu[0]; j <= retenu[1]; j++) minEpisode = Math.min(minEpisode, soldes[j]);
  const mesures: Mesures = {
    premierNegatif: eps.length > 0 ? eps[0][0] : null,
    minimum,
    jourMinimum,
    episodeDebut: retenu ? retenu[0] : null,
    episodeFin: retenu ? retenu[1] : null,
    retourPositif: retenu ? retenu[1] < soldes.length - 1 : true,
    dureeJours: retenu ? retenu[1] - retenu[0] + 1 : 0,
    // Déficit de l'épisode retenu : chaque épisode est attribué séparément.
    deficitMax: -minEpisode,
  };
  if (nouveau) return { mesures, nature: "declenchement" };
  if (eps.length === 0) return { mesures, nature: "aucun" };
  const refEps = episodes(reference);
  let refMin = Infinity;
  for (let j = 0; j < reference.length; j++) refMin = Math.min(refMin, reference[j]);
  const joursNegatifs = (eps_: [number, number][]) => eps_.reduce((s, [d, f]) => s + f - d + 1, 0);
  const pire =
    minimum < refMin - TOLERANCE ||
    (refEps.length > 0 && eps[0][0] < refEps[0][0]) ||
    joursNegatifs(eps) > joursNegatifs(refEps);
  return { mesures, nature: pire ? "aggravation" : "aucun" };
}

// ---------------------------------------------------------------------------------------------
// Résultats
// ---------------------------------------------------------------------------------------------

export interface FactureDansAlerte {
  cleLigne: string;
  type: FactureAnalysee["type"];
  numero: string | null;
  client: string;
  montantRestant: number; // reste à encaisser retenu par la projection
  dateEcheance: string | null;
  dateReference: string; // date d'encaissement retenue dans la référence
  dateReferenceEstimee: boolean; // facture en retard : date estimée par l'historique
  dateTestee: string | null; // null : au-delà de l'horizon
  retardJours: number; // retard supplémentaire testé pour CETTE facture, depuis sa date de référence
  dateCertaine: boolean; // fiabilité « Ferme » saisie : le stress est hypothétique
  plausibilite: Plausibilite;
}

export type Plausibilite =
  | { estimee: true; part: number; source: "client" | "compte" }
  | { estimee: false; raison: "peu_calibre" | "hypotheses_par_defaut" };

export interface Situation {
  libelle: string;
  soldes: number[]; // arrondis au centime
  mesures: Mesures;
}

export interface AlerteRisque {
  id: string;
  type: "seule" | "duo" | "aggravation";
  factures: FactureDansAlerte[]; // chacune avec SA date testée
  mesures: Mesures; // scénario testé (épisode attribué)
  // Décaissements prévus le jour du premier passage sous zéro du scénario (contexte, pas la cause).
  decaissementsDuJour: { libelle: string; montant: number }[];
  memeClient: boolean;
  situations: Situation[]; // référence, scénario(s) : pour « Voir l'impact sur la courbe »
}

export interface GroupeAlertes {
  id: string;
  type: "seule" | "seules_multiples" | "duo" | "aggravation";
  dateTension: string; // début de l'épisode de tension concerné
  alertes: AlerteRisque[]; // priorisées ; courbes (situations) pour les premières seulement
  nombreTotal: number;
  // Autres combinaisons de la même tension, au-delà des alertes détaillées.
  autres: { factures: { cleLigne: string; numero: string | null; client: string; retardJours: number }[]; deficitMax: number }[];
}

/** Créance que l'analyse ne peut pas positionner dans le temps : suivie, signalée, non testée. */
export interface FactureNonPositionnee {
  cleLigne: string;
  numero: string | null;
  client: string;
  montant: number;
  raison: string;
}

/** Périmètre des créances, tel que connu du navigateur (préparation commune des données). */
export interface PerimetreFactures {
  enRetardEstimees: number; // factures en retard positionnées à une date estimée
  aActualiser: FactureNonPositionnee[]; // factures en retard sans estimation défendable
  litigieusesExclues: number; // politique existante : une facture litigieuse n'est pas projetée
  horsHorizon: number; // encaissement de référence au-delà de l'horizon : aucun retard à tester
}

/**
 * Couverture de l'analyse, en quatre limites distinctes :
 *  - donnees  : créances non exploitables (à actualiser) — l'analyse ne les a pas testées ;
 *  - methode  : combinaisons de dates non explorées par construction (restriction déclarée) ;
 *  - calcul   : arrêt avant la fin du périmètre (budget), avec sa cause ;
 *  - affichage: tout est calculé, seul le détail affiché est condensé.
 * `partielle` vaut true dès que l'une des trois premières limite le résultat.
 */
export interface CouvertureAnalyse {
  facturesAnalysees: number;
  perimetre: PerimetreFactures;
  methode: "exacte" | "retards_minimaux";
  restrictionMethode: string | null;
  pairesPossibles: number;
  pairesEcarteesSansRisque: number; // écartées par une borne exacte : aucun scénario possible
  pairesExplorees: number;
  pairesNonExplorees: number; // non atteintes avant l'arrêt du calcul
  facturesSeulesIncompletes: number; // factures dont tous les retards n'ont pas été testés (arrêt)
  arret: null | { cause: "budget_temps" | "budget_evaluations"; evaluations: number };
  affichage: { alertesCalculees: number; alertesDetaillees: number; combinaisonsListees: number; combinaisonsNonListees: number };
  partielle: boolean;
}

export interface ResultatRisques {
  dates: string[];
  reference: { soldes: number[]; mesures: Mesures; fluxIncertains: number; financementsIncertains: number; hypothesesARenseigner: number };
  groupes: GroupeAlertes[];
  couverture: CouvertureAnalyse;
  durees: { preparationMs: number; analyseMs: number };
}

const arrondiCentime = (x: number) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------------------------
// Plausibilité
// ---------------------------------------------------------------------------------------------

export function plausibiliteRetard(
  modele: ModeleRetards,
  facture: { tiers: string | null; montant: number; jourReference: number; jourEcheance: number | null; plancher?: number },
  jourTeste: number,
  echantillons = 4_000
): Plausibilite {
  if (modele.confiance.niveau === "peu_calibre") return { estimee: false, raison: "peu_calibre" };
  const ech = echantillonneurPour(modele, facture.tiers, facture.montant);
  if (ech.poids.defaut >= 0.5) return { estimee: false, raison: "hypotheses_par_defaut" };
  // Reproductible : même facture, même date testée -> même valeur.
  const alea = creerAlea(Math.round(facture.montant * 100) ^ (jourTeste * 7919) ^ (facture.jourReference * 104729));
  const base = facture.jourEcheance !== null ? Math.min(facture.jourEcheance, facture.jourReference) : facture.jourReference;
  const plancher = facture.plancher ?? facture.jourReference;
  let valides = 0;
  let tardifs = 0;
  for (let i = 0; i < echantillons; i++) {
    const paiement = base + Math.round(ech.tirer(alea));
    // Facture déjà échue : un paiement antérieur à aujourd'hui est incompatible avec une facture ouverte.
    if (paiement < 0) continue;
    valides++;
    if (Math.max(plancher, paiement) >= jourTeste) tardifs++;
  }
  if (valides === 0) return { estimee: false, raison: "hypotheses_par_defaut" };
  return { estimee: true, part: tardifs / valides, source: ech.poids.client >= 0.5 ? "client" : "compte" };
}

// ---------------------------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------------------------

interface Candidat {
  facture: FactureAnalysee;
  evenements: number[]; // index d'événements préparés (encaissements de la facture)
  jourReference: number; // premier jour de référence
  montant: number;
  tiers: string | null;
  dateCertaine: boolean;
  dateEstimee: boolean;
}

const PERIMETRE_VIDE: PerimetreFactures = { enRetardEstimees: 0, aActualiser: [], litigieusesExclues: 0, horsHorizon: 0 };

export function analyserRisques(params: ParametresRisques, modeleClients: ModeleRetards): ResultatRisques {
  const t0 = Date.now();
  const prep = preparerSimulation(params);
  const evaluer = creerEvaluateur(prep);
  const { jours, dates } = prep;
  const referenceTraj = evaluer();
  const reference = referenceTraj.soldes;
  const refMesures = mesurer(reference, reference).mesures;
  // Jours de référence tels que la référence les place (« à partir du mois suivant » compris).
  const jourRef = referenceTraj.jours;
  const perimetre = params.perimetre ?? PERIMETRE_VIDE;

  // Candidats : factures à encaisser présentes dans la référence.
  const parCle = new Map(params.factures.map((f) => [f.cleLigne, f]));
  const candidats: Candidat[] = [];
  prep.lignes.forEach((l, i) => {
    const facture = parCle.get(l.source.cle);
    if (!facture || referenceTraj.presentes[i] !== 1) return;
    const evts = l.evenements.filter((k) => prep.evenements[k].montantSigne > 0 && jourRef[k] < jours);
    if (evts.length === 0) return;
    const src = prep.sources[evts[0]];
    candidats.push({
      facture,
      evenements: evts,
      jourReference: Math.min(...evts.map((k) => jourRef[k])),
      montant: evts.reduce((s, k) => s + prep.evenements[k].montantSigne, 0),
      tiers: src.tiers,
      dateCertaine: evts.every((k) => prep.sources[k].fiabiliteDate === 100),
      dateEstimee: evts.some((k) => prep.sources[k].dateEstimee === true),
    });
  });
  const preparationMs = Date.now() - t0;

  // Calcul exact rapide possible ? (aucune condition dont le résultat dépend d'une date d'encaissement)
  const clesCandidates = new Set(candidats.map((c) => c.facture.cleLigne));
  const lineaire =
    prep.phase2.length === 0 &&
    !prep.lignes.some((l) => l.condition?.type === "apres_evenement" && l.parent >= 0 && clesCandidates.has(prep.lignes[l.parent].source.cle));

  const budget = params.budgetEvaluations ?? CONFIG_ANALYSE_RISQUES.budgetEvaluations;
  const finBudget = Date.now() + (params.budgetMs ?? CONFIG_ANALYSE_RISQUES.budgetMs);
  let evaluations = 0;
  let arret: CouvertureAnalyse["arret"] = null;
  const budgetAtteint = () => {
    if (lineaire) return false;
    if (arret) return true;
    if (evaluations >= budget) arret = { cause: "budget_evaluations", evaluations };
    else if (evaluations % 256 === 0 && Date.now() > finBudget) arret = { cause: "budget_temps", evaluations };
    return arret !== null;
  };

  const tampon = new Float64Array(jours);
  /** Scénario : chaque facture déplacée de SON retard (k jours après sa date de référence). */
  const scenario = (deplacees: [Candidat, number][]): Float64Array => {
    if (!lineaire) {
      evaluations++;
      const forces = new Map<number, number>();
      for (const [c, k] of deplacees) for (const e of c.evenements) forces.set(e, Math.min(jourRef[e] + k, jours));
      return evaluer(forces).soldes;
    }
    tampon.set(reference);
    for (const [c, k] of deplacees) {
      for (const e of c.evenements) {
        const m = prep.evenements[e].montantSigne;
        const de = jourRef[e];
        const a = Math.min(de + k, jours);
        for (let j = de; j < a; j++) tampon[j] -= m;
      }
    }
    return Float64Array.from(tampon);
  };
  const kMax = (c: Candidat) => jours - c.jourReference; // k où l'encaissement passe au-delà de l'horizon

  // Minimum de la référence à partir de chaque jour : borne exacte pour écarter une facture ou une
  // paire qui ne peut pas passer sous zéro, même encaissée après l'horizon (cas linéaire).
  const minApres = new Float64Array(jours + 1).fill(Infinity);
  for (let j = jours - 1; j >= 0; j--) minApres[j] = Math.min(reference[j], minApres[j + 1]);
  const peutPasserSousZero = (cs: Candidat[]) => !lineaire || minApres[Math.min(...cs.map((c) => c.jourReference))] - cs.reduce((s, c) => s + c.montant, 0) < 0;

  // 1. Factures seules : nature pour chaque retard k (balayage complet, sans hypothèse de monotonie).
  let facturesSeulesIncompletes = 0;
  const naturesSeules: NatureImpact[][] = candidats.map((c) => {
    const n: NatureImpact[] = new Array(kMax(c) + 1).fill("aucun");
    if (!peutPasserSousZero([c]) && refMesures.premierNegatif === null) return n;
    for (let k = 1; k <= kMax(c); k++) {
      if (budgetAtteint()) {
        facturesSeulesIncompletes++;
        break;
      }
      n[k] = mesurer(scenario([[c, k]]), reference).nature;
    }
    return n;
  });
  const declencheSeule = (i: number, k: number) => naturesSeules[i][Math.min(k, naturesSeules[i].length - 1)] === "declenchement";

  // 2. Paires, retards DIFFÉRENTS pour A et B. Pour chaque jour de tension possible t, on teste le
  //    scénario minimal : A et B encaissées juste après t (kA = t − pA + 1, kB = t − pB + 1).
  //    Sans condition dépendante, un retard plus long ne fait que retirer du cash plus longtemps :
  //    si un duo crée une tension au jour t, ce scénario minimal le montre aussi (méthode exacte,
  //    vérifiée contre une exploration exhaustive des couples de dates dans les tests). Avec des
  //    conditions dépendantes, cette propriété ne tient plus : la méthode est déclarée restreinte.
  //    Un duo n'est retenu que si A seule (à kA) et B seule (à kB) ne créent pas la tension : une
  //    facture critique seule sous un stress plus sévère reste analysée à ses retards plus courts.
  let pairesExplorees = 0;
  let pairesEcartees = 0;
  let pairesNonExplorees = 0;
  const duos: { a: number; b: number; ka: number; kb: number; jour: number }[] = [];
  for (let a = 0; a < candidats.length; a++) {
    for (let b = a + 1; b < candidats.length; b++) {
      const A = candidats[a];
      const B = candidats[b];
      if (!peutPasserSousZero([A, B])) {
        pairesEcartees++;
        continue;
      }
      if (budgetAtteint()) {
        pairesNonExplorees++;
        continue;
      }
      let complete = true;
      // Un duo par épisode de tension (le scénario minimal qui le crée) : un retard plus long qui ne
      // fait qu'allonger le même épisode n'est pas une nouvelle alerte ; un autre épisode, si.
      const episodesVus = new Set<number>();
      for (let t = Math.max(A.jourReference, B.jourReference); t < jours; t++) {
        if (reference[t] < 0) continue; // tension déjà prévue ce jour-là : pas un déclenchement
        if (lineaire && reference[t] - A.montant - B.montant >= 0) continue; // impossible ce jour-là
        const ka = t - A.jourReference + 1;
        const kb = t - B.jourReference + 1;
        if (declencheSeule(a, ka) || declencheSeule(b, kb)) continue; // l'une suffit seule à ces retards
        if (budgetAtteint()) {
          complete = false;
          break;
        }
        const { mesures, nature } = mesurer(scenario([[A, ka], [B, kb]]), reference, t);
        if (nature === "declenchement" && mesures.episodeDebut !== null && !episodesVus.has(mesures.episodeDebut)) {
          episodesVus.add(mesures.episodeDebut);
          duos.push({ a, b, ka, kb, jour: t });
        }
      }
      if (complete) pairesExplorees++;
      else pairesNonExplorees++;
    }
  }

  // 3. Construction des alertes.
  // Plausibilité mise en cache par (facture, retard) : les duos partagent souvent les mêmes tests.
  const cachePlausibilite = new Map<string, Plausibilite>();
  const plausibiliteDe = (c: Candidat, jourTeste: number): Plausibilite => {
    const cle = `${c.facture.cleLigne}|${jourTeste}`;
    let p = cachePlausibilite.get(cle);
    if (!p) {
      p = plausibiliteRetard(
        modeleClients,
        {
          tiers: c.tiers,
          montant: c.montant,
          jourReference: c.jourReference,
          jourEcheance: c.facture.dateEcheance ? joursEntre(dates[0], c.facture.dateEcheance) : null,
          plancher: c.dateEstimee ? 0 : c.jourReference,
        },
        jourTeste,
        params.echantillonsPlausibilite
      );
      cachePlausibilite.set(cle, p);
    }
    return p;
  };
  const enFacture = (c: Candidat, k: number): FactureDansAlerte => {
    const jourTeste = c.jourReference + k;
    return {
      cleLigne: c.facture.cleLigne,
      type: c.facture.type,
      numero: c.facture.numero,
      client: c.facture.client,
      montantRestant: arrondiCentime(c.montant),
      dateEcheance: c.facture.dateEcheance,
      dateReference: dates[c.jourReference],
      dateReferenceEstimee: c.dateEstimee,
      dateTestee: jourTeste < jours ? dates[jourTeste] : null,
      retardJours: k,
      dateCertaine: c.dateCertaine,
      plausibilite: plausibiliteDe(c, jourTeste),
    };
  };
  const decaissementsDuJour = (jour: number | null) =>
    jour === null
      ? []
      : prep.evenements
          .map((e, k) => ({ e, k }))
          .filter(({ e, k }) => e.montantSigne < 0 && jourRef[k] === jour)
          .map(({ e, k }) => ({ libelle: prep.sources[k].libelle, montant: arrondiCentime(-e.montantSigne) }))
          .sort((x, y) => y.montant - x.montant)
          .slice(0, 3);
  const situation = (libelle: string, soldes: Float64Array, jour?: number): Situation => ({
    libelle,
    soldes: Array.from(soldes, arrondiCentime),
    mesures: mesurer(soldes, reference, jour).mesures,
  });
  const nomFacture = (c: Candidat) => c.facture.numero ?? c.facture.client;

  const alertes: AlerteRisque[] = [];
  // Courbes construites seulement pour les alertes affichées avec courbe (voir grouperAlertes).
  const courbes = new Map<string, () => Situation[]>();
  candidats.forEach((c, i) => {
    const kDecl = naturesSeules[i].indexOf("declenchement");
    const kAggr = kDecl < 0 ? naturesSeules[i].indexOf("aggravation") : -1;
    const k = kDecl >= 0 ? kDecl : kAggr;
    if (k < 1) return;
    const { mesures } = mesurer(scenario([[c, k]]), reference);
    const id = `${kDecl >= 0 ? "seule" : "aggravation"}:${c.facture.cleLigne}`;
    alertes.push({
      id,
      type: kDecl >= 0 ? "seule" : "aggravation",
      factures: [enFacture(c, k)],
      mesures,
      decaissementsDuJour: decaissementsDuJour(kDecl >= 0 ? mesures.episodeDebut : mesures.jourMinimum),
      memeClient: false,
      situations: [],
    });
    courbes.set(id, () => [situation("Référence", reference), situation(`${nomFacture(c)} retardée`, scenario([[c, k]]))]);
  });
  for (const { a, b, ka, kb, jour } of duos) {
    const A = candidats[a];
    const B = candidats[b];
    const { mesures } = mesurer(scenario([[A, ka], [B, kb]]), reference, jour);
    const id = `duo:${A.facture.cleLigne}|${B.facture.cleLigne}:${mesures.episodeDebut}`;
    alertes.push({
      id,
      type: "duo",
      factures: [enFacture(A, ka), enFacture(B, kb)],
      mesures,
      decaissementsDuJour: decaissementsDuJour(mesures.episodeDebut),
      memeClient: A.tiers !== null && B.tiers !== null && cleTiers(A.tiers) === cleTiers(B.tiers),
      situations: [],
    });
    courbes.set(id, () => [
      situation("Référence", reference),
      situation(`${nomFacture(A)} seule retardée`, scenario([[A, ka]])),
      situation(`${nomFacture(B)} seule retardée`, scenario([[B, kb]])),
      situation("Les deux retardées", scenario([[A, ka], [B, kb]]), jour),
    ]);
  }

  const groupes = grouperAlertes(alertes, dates);
  for (const g of groupes) for (const a of g.alertes.slice(0, LIMITES_AFFICHAGE.courbesParGroupe)) a.situations = courbes.get(a.id)?.() ?? [];
  const detaillees = groupes.reduce((s, g) => s + g.alertes.length, 0);
  const listees = groupes.reduce((s, g) => s + g.autres.length, 0);
  const restrictionMethode = lineaire
    ? null
    : "Des conditions dépendent de la trésorerie : pour chaque jour de tension, seuls les retards minimaux des deux factures sont testés ; des retards plus longs, qui pourraient changer ces conditions, ne sont pas explorés.";
  return {
    dates,
    reference: {
      soldes: Array.from(reference, arrondiCentime),
      mesures: refMesures,
      fluxIncertains: prep.lignes.filter((l, i) => referenceTraj.presentes[i] === 1 && l.source.probabilite < 100).length,
      financementsIncertains: prep.lignes.filter((l, i) => referenceTraj.presentes[i] === 1 && l.source.probabilite < 100 && l.source.cle.startsWith("financement:")).length,
      hypothesesARenseigner: prep.lignes.filter((l) => l.source.aRenseigner).length,
    },
    groupes,
    couverture: {
      facturesAnalysees: candidats.length,
      perimetre,
      methode: lineaire ? "exacte" : "retards_minimaux",
      restrictionMethode,
      pairesPossibles: (candidats.length * (candidats.length - 1)) / 2,
      pairesEcarteesSansRisque: pairesEcartees,
      pairesExplorees,
      pairesNonExplorees,
      facturesSeulesIncompletes,
      arret,
      affichage: { alertesCalculees: alertes.length, alertesDetaillees: detaillees, combinaisonsListees: listees, combinaisonsNonListees: alertes.length - detaillees - listees },
      partielle: perimetre.aActualiser.length > 0 || restrictionMethode !== null || arret !== null,
    },
    durees: { preparationMs, analyseMs: Date.now() - t0 - preparationMs },
  };
}

// ---------------------------------------------------------------------------------------------
// Priorisation et regroupement
// ---------------------------------------------------------------------------------------------

/** Plausibilité estimée la plus forte d'une alerte (0 si non estimée). */
function plausibiliteMax(a: AlerteRisque): number {
  return Math.max(0, ...a.factures.map((f) => (f.plausibilite.estimee ? f.plausibilite.part : 0)));
}

/** Proximité de la tension, puis profondeur du déficit, puis plausibilité — jamais le montant facturé. */
export function comparerAlertes(a: AlerteRisque, b: AlerteRisque): number {
  const jour = (x: AlerteRisque) => x.mesures.episodeDebut ?? x.mesures.premierNegatif ?? Infinity;
  return jour(a) - jour(b) || b.mesures.deficitMax - a.mesures.deficitMax || plausibiliteMax(b) - plausibiliteMax(a);
}

/**
 * Regroupe les alertes d'une même tension : factures critiques seules (une ou plusieurs), duos,
 * aggravations d'une tension déjà prévue. Chaque groupe garde toutes ses alertes.
 */
export function grouperAlertes(alertes: AlerteRisque[], dates: string[]): GroupeAlertes[] {
  const groupes = new Map<string, GroupeAlertes>();
  for (const a of [...alertes].sort(comparerAlertes)) {
    const jour = a.mesures.episodeDebut ?? a.mesures.premierNegatif ?? a.mesures.jourMinimum;
    const famille = a.type === "seule" ? "seules" : a.type;
    const cle = `${famille}:${jour}`;
    const groupe: GroupeAlertes = groupes.get(cle) ?? { id: cle, type: a.type, dateTension: dates[jour], alertes: [], nombreTotal: 0, autres: [] };
    groupe.nombreTotal++;
    if (groupe.alertes.length < LIMITES_AFFICHAGE.alertesParGroupe) {
      groupe.alertes.push(a);
    } else if (groupe.autres.length < LIMITES_AFFICHAGE.autresParGroupe) {
      groupe.autres.push({
        factures: a.factures.map((f) => ({ cleLigne: f.cleLigne, numero: f.numero, client: f.client, retardJours: f.retardJours })),
        deficitMax: a.mesures.deficitMax,
      });
    }
    if (a.type === "seule" && groupe.nombreTotal > 1) groupe.type = "seules_multiples";
    groupes.set(cle, groupe);
  }
  const rang = { seule: 0, seules_multiples: 0, duo: 1, aggravation: 2 } as const;
  return Array.from(groupes.values()).sort(
    (x, y) => x.dateTension.localeCompare(y.dateTension) || rang[x.type] - rang[y.type] || comparerAlertes(x.alertes[0], y.alertes[0])
  );
}
