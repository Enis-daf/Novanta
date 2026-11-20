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
  // Budget des réévaluations complètes (cas avec conditions dépendantes) : nombre et durée.
  budgetEvaluations?: number;
  budgetMs?: number;
  echantillonsPlausibilite?: number;
}

export const BUDGET_EVALUATIONS_PAR_DEFAUT = 500_000;
export const BUDGET_MS_PAR_DEFAUT = 8_000;
// Taille de la réponse : alertes détaillées par groupe, courbes par groupe, combinaisons listées.
export const LIMITES_AFFICHAGE = { alertesParGroupe: 10, courbesParGroupe: 3, autresParGroupe: 200 } as const;
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
export function mesurer(soldes: Float64Array, reference: Float64Array): { mesures: Mesures; nature: NatureImpact } {
  let minimum = Infinity;
  let jourMinimum = 0;
  for (let j = 0; j < soldes.length; j++) {
    if (soldes[j] < minimum) {
      minimum = soldes[j];
      jourMinimum = j;
    }
  }
  const eps = episodes(soldes);
  const nouveau = eps.find(([d, f]) => {
    for (let j = d; j <= f; j++) if (reference[j] < 0) return false;
    return true;
  });
  const retenu = nouveau ?? eps[0] ?? null;
  const mesures: Mesures = {
    premierNegatif: eps.length > 0 ? eps[0][0] : null,
    minimum,
    jourMinimum,
    episodeDebut: retenu ? retenu[0] : null,
    episodeFin: retenu ? retenu[1] : null,
    retourPositif: retenu ? retenu[1] < soldes.length - 1 : true,
    dureeJours: retenu ? retenu[1] - retenu[0] + 1 : 0,
    deficitMax: minimum < 0 ? -minimum : 0,
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
  dateTestee: string | null; // null : au-delà de l'horizon
  retardJours: number; // par rapport à la date de référence
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
  factures: FactureDansAlerte[];
  retardJours: number;
  mesures: Mesures; // scénario testé
  // Décaissements prévus le jour du premier passage sous zéro du scénario (contexte, pas la cause).
  decaissementsDuJour: { libelle: string; montant: number }[];
  memeClient: boolean;
  situations: Situation[]; // référence, scénario(s) : pour « Voir l'impact sur la courbe »
}

export interface GroupeAlertes {
  id: string;
  type: "seule" | "seules_multiples" | "duo" | "aggravation";
  dateTension: string; // premier passage sous zéro (ou début de la tension aggravée)
  alertes: AlerteRisque[]; // priorisées ; courbes (situations) pour les premières seulement
  nombreTotal: number;
  // Autres combinaisons de la même tension, au-delà des alertes détaillées (factures et retard testé).
  autres: { factures: { cleLigne: string; numero: string | null; client: string }[]; retardJours: number; deficitMax: number }[];
}

export interface CouvertureAnalyse {
  facturesAnalysees: number;
  pairesPossibles: number;
  pairesEvaluees: number;
  pairesEcarteesSansRisque: number; // écartées par la borne exacte
  partielle: boolean;
  methode: "exacte_rapide" | "reevaluation_complete";
}

export interface ResultatRisques {
  dates: string[];
  reference: { soldes: number[]; mesures: Mesures };
  groupes: GroupeAlertes[];
  couverture: CouvertureAnalyse;
}

const arrondiCentime = (x: number) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------------------------
// Plausibilité
// ---------------------------------------------------------------------------------------------

export function plausibiliteRetard(
  modele: ModeleRetards,
  facture: { tiers: string | null; montant: number; jourReference: number; jourEcheance: number | null },
  jourTeste: number,
  echantillons = 4_000
): Plausibilite {
  if (modele.confiance.niveau === "peu_calibre") return { estimee: false, raison: "peu_calibre" };
  const ech = echantillonneurPour(modele, facture.tiers, facture.montant);
  if (ech.poids.defaut >= 0.5) return { estimee: false, raison: "hypotheses_par_defaut" };
  // Reproductible : même facture, même date testée -> même valeur.
  const alea = creerAlea(Math.round(facture.montant * 100) ^ (jourTeste * 7919) ^ (facture.jourReference * 104729));
  const base = facture.jourEcheance !== null ? Math.min(facture.jourEcheance, facture.jourReference) : facture.jourReference;
  let valides = 0;
  let tardifs = 0;
  for (let i = 0; i < echantillons; i++) {
    const paiement = base + Math.round(ech.tirer(alea));
    // Facture déjà échue : un paiement antérieur à aujourd'hui est incompatible avec une facture ouverte.
    if (paiement < 0) continue;
    valides++;
    if (Math.max(facture.jourReference, paiement) >= jourTeste) tardifs++;
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
}

export function analyserRisques(params: ParametresRisques, modeleClients: ModeleRetards): ResultatRisques {
  const prep = preparerSimulation(params);
  const evaluer = creerEvaluateur(prep);
  const { jours, dates } = prep;
  const referenceTraj = evaluer();
  const reference = referenceTraj.soldes;
  const refMesures = mesurer(reference, reference).mesures;
  // Jours de référence tels que la référence les place (« à partir du mois suivant » compris).
  const jourRef = referenceTraj.jours;

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
    });
  });

  // Calcul exact rapide possible ? (aucune condition dont le résultat dépend d'une date d'encaissement)
  const clesCandidates = new Set(candidats.map((c) => c.facture.cleLigne));
  const lineaire =
    prep.phase2.length === 0 &&
    !prep.lignes.some((l) => l.condition?.type === "apres_evenement" && l.parent >= 0 && clesCandidates.has(prep.lignes[l.parent].source.cle));

  const budget = params.budgetEvaluations ?? BUDGET_EVALUATIONS_PAR_DEFAUT;
  const finBudget = Date.now() + (params.budgetMs ?? BUDGET_MS_PAR_DEFAUT);
  let evaluations = 0;
  let partielle = false;
  const budgetAtteint = () => !lineaire && (evaluations >= budget || (evaluations % 256 === 0 && Date.now() > finBudget));

  const forcesPour = (cs: Candidat[], k: number) => {
    const m = new Map<number, number>();
    for (const c of cs) for (const e of c.evenements) m.set(e, Math.min(jourRef[e] + k, jours));
    return m;
  };
  const tampon = new Float64Array(jours);
  const scenario = (cs: Candidat[], k: number): Float64Array => {
    if (!lineaire) {
      evaluations++;
      return evaluer(forcesPour(cs, k)).soldes;
    }
    tampon.set(reference);
    for (const c of cs) {
      for (const e of c.evenements) {
        const m = prep.evenements[e].montantSigne;
        const de = jourRef[e];
        const a = Math.min(de + k, jours);
        for (let j = de; j < a; j++) tampon[j] -= m;
      }
    }
    return Float64Array.from(tampon);
  };
  const kMax = (cs: Candidat[]) => Math.max(...cs.map((c) => jours - c.jourReference)); // k où tout est au-delà de l'horizon

  // Minimum de la référence à partir de chaque jour : borne exacte pour écarter une facture ou une
  // paire qui ne peut pas passer sous zéro, même encaissée après l'horizon (cas linéaire).
  const minApres = new Float64Array(jours + 1).fill(Infinity);
  for (let j = jours - 1; j >= 0; j--) minApres[j] = Math.min(reference[j], minApres[j + 1]);
  const peutPasserSousZero = (cs: Candidat[]) => !lineaire || minApres[Math.min(...cs.map((c) => c.jourReference))] - cs.reduce((s, c) => s + c.montant, 0) < 0;

  // 1. Factures seules : nature pour chaque k (balayage complet).
  const naturesSeules: NatureImpact[][] = candidats.map((c) => {
    const n: NatureImpact[] = new Array(kMax([c]) + 1).fill("aucun");
    if (!peutPasserSousZero([c]) && refMesures.premierNegatif === null) return n;
    for (let k = 1; k <= kMax([c]); k++) {
      if (budgetAtteint()) {
        partielle = true;
        break;
      }
      n[k] = mesurer(scenario([c], k), reference).nature;
    }
    return n;
  });
  const declencheSeule = (i: number, k: number) => (naturesSeules[i][Math.min(k, naturesSeules[i].length - 1)] ?? "aucun") === "declenchement";

  // 2. Paires.
  let pairesEvaluees = 0;
  let pairesEcartees = 0;
  const duos: { a: number; b: number; k: number }[] = [];
  for (let a = 0; a < candidats.length; a++) {
    for (let b = a + 1; b < candidats.length; b++) {
      const paire = [candidats[a], candidats[b]];
      if (!peutPasserSousZero(paire)) {
        pairesEcartees++;
        continue;
      }
      if (budgetAtteint()) {
        partielle = true;
        continue;
      }
      pairesEvaluees++;
      for (let k = 1; k <= kMax(paire); k++) {
        if (declencheSeule(a, k) || declencheSeule(b, k)) continue; // paire redondante à ce retard
        if (budgetAtteint()) {
          partielle = true;
          break;
        }
        if (mesurer(scenario(paire, k), reference).nature === "declenchement") {
          duos.push({ a, b, k });
          break;
        }
      }
    }
  }

  // 3. Construction des alertes.
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
      dateTestee: jourTeste < jours ? dates[jourTeste] : null,
      retardJours: k,
      dateCertaine: c.dateCertaine,
      plausibilite: plausibiliteRetard(
        modeleClients,
        {
          tiers: c.tiers,
          montant: c.montant,
          jourReference: c.jourReference,
          jourEcheance: c.facture.dateEcheance ? joursEntre(dates[0], c.facture.dateEcheance) : null,
        },
        jourTeste,
        params.echantillonsPlausibilite
      ),
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
  const situation = (libelle: string, soldes: Float64Array): Situation => ({
    libelle,
    soldes: Array.from(soldes, arrondiCentime),
    mesures: mesurer(soldes, reference).mesures,
  });
  const nomFacture = (c: Candidat) => c.facture.numero ?? c.facture.client;

  const alertes: AlerteRisque[] = [];
  candidats.forEach((c, i) => {
    const kDecl = naturesSeules[i].indexOf("declenchement");
    const kAggr = kDecl < 0 ? naturesSeules[i].indexOf("aggravation") : -1;
    const k = kDecl >= 0 ? kDecl : kAggr;
    if (k < 1) return;
    const soldes = scenario([c], k);
    const { mesures } = mesurer(soldes, reference);
    alertes.push({
      id: `${kDecl >= 0 ? "seule" : "aggravation"}:${c.facture.cleLigne}`,
      type: kDecl >= 0 ? "seule" : "aggravation",
      factures: [enFacture(c, k)],
      retardJours: k,
      mesures,
      decaissementsDuJour: decaissementsDuJour(kDecl >= 0 ? mesures.premierNegatif : mesures.jourMinimum),
      memeClient: false,
      situations: [situation("Référence", reference), situation(`${nomFacture(c)} retardée`, soldes)],
    });
  });
  for (const { a, b, k } of duos) {
    const A = candidats[a];
    const B = candidats[b];
    const ensemble = scenario([A, B], k);
    const { mesures } = mesurer(ensemble, reference);
    alertes.push({
      id: `duo:${A.facture.cleLigne}|${B.facture.cleLigne}`,
      type: "duo",
      factures: [enFacture(A, k), enFacture(B, k)],
      retardJours: k,
      mesures,
      decaissementsDuJour: decaissementsDuJour(mesures.premierNegatif),
      memeClient: A.tiers !== null && B.tiers !== null && cleTiers(A.tiers) === cleTiers(B.tiers),
      situations: [
        situation("Référence", reference),
        situation(`${nomFacture(A)} seule retardée`, scenario([A], k)),
        situation(`${nomFacture(B)} seule retardée`, scenario([B], k)),
        situation("Les deux retardées", ensemble),
      ],
    });
  }

  return {
    dates,
    reference: { soldes: Array.from(reference, arrondiCentime), mesures: refMesures },
    groupes: grouperAlertes(alertes, dates),
    couverture: {
      facturesAnalysees: candidats.length,
      pairesPossibles: (candidats.length * (candidats.length - 1)) / 2,
      pairesEvaluees,
      pairesEcarteesSansRisque: pairesEcartees,
      partielle,
      methode: lineaire ? "exacte_rapide" : "reevaluation_complete",
    },
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
      groupe.alertes.push(groupe.alertes.length < LIMITES_AFFICHAGE.courbesParGroupe ? a : { ...a, situations: [] });
    } else if (groupe.autres.length < LIMITES_AFFICHAGE.autresParGroupe) {
      groupe.autres.push({
        factures: a.factures.map((f) => ({ cleLigne: f.cleLigne, numero: f.numero, client: f.client })),
        retardJours: a.retardJours,
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
