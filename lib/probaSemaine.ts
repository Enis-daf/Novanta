import { GRAINE_PAR_DEFAUT } from "./probaAlea";
import {
  creerEvaluateur,
  etatDeSimulation,
  NOMBRE_SIMULATIONS_PAR_DEFAUT,
  ParametresSimulation,
  preparerSimulation,
  PreparationSimulation,
  rejouerTirages,
  simuler,
  tiragesDeSimulation,
  TiragesSimulation,
} from "./probaSimulation";
import type { FactureAnalysee, PerimetreFactures } from "./probaRisques";

/**
 * Encaissements à sécuriser — expliquer le risque Monte Carlo d'UNE semaine par les encaissements
 * qui y contribuent. Fonctions pures, sans base ni interface.
 *
 * 1. Les 10 000 simulations sont celles de la prévision affichée (mêmes paramètres, même graine) :
 *    le risque de la semaine et les simulations analysées sont exactement ceux des pourcentages.
 * 2. Simulations retenues : celles dont le solde est sous 0 € au moins un jour de la semaine.
 *    Chacune garde son histoire complète depuis J0 : un retard survenu des semaines avant reste
 *    visible ; le solde n'est jamais réinitialisé au début de la semaine.
 * 3. Factures candidates : TOUTES les factures (et prévisionnelles) à encaisser de la projection,
 *    quelle que soit leur échéance — y compris échue bien avant l'horizon et placée à une date
 *    estimée. Aucune fenêtre rétrospective : une facture est examinée dès qu'elle est encaissée,
 *    dans la simulation, après sa date de référence.
 * 4. Contribution vérifiée (et non simple corrélation) : la simulation est REJOUÉE avec ses propres
 *    tirages, en ne remettant que cette facture à sa date de référence. Tout le reste est identique,
 *    sauf les conséquences métier recalculées (conditions « Dépend de », CA du mois). Effets :
 *    « évite » (plus aucun jour sous 0 € dans la semaine), « réduit » (déficit maximal de la semaine
 *    plus faible), « aucun ».
 * 5. Combinaisons : si plusieurs factures retardées l'évitent chacune seule, leur retard simultané
 *    crée le déficit (corriger l'une suffit). Si aucune facture seule n'évite le déficit, les paires des factures retardées
 *    les plus contributives sont rejouées ensemble (retards différents, chacun ramené à sa date de
 *    référence) ; sinon toutes les factures retardées ensemble (« plusieurs encaissements ») ; si
 *    même cela ne suffit pas, le déficit tient à d'autres facteurs.
 * 6. Autres facteurs : financement ou encaissement non obtenu, montant inférieur à la cible, dépense
 *    supérieure, encaissement non facturé décalé, dépense conditionnelle déclenchée — chacun rejoué
 *    seul. Jamais attribué d'office aux factures.
 * 7. Date limite : dans le scénario présenté, dernier jour d'encaissement tel que tout paiement de la
 *    date de référence jusqu'à ce jour évite le déficit de la semaine — calculée jour par jour, sans
 *    supposer qu'un retard plus long aggrave toujours le résultat.
 * 8. Factures à date « Ferme » : jamais retardées dans les tirages, donc jamais présentées comme
 *    cause ; leur vulnérabilité à un retard exceptionnel est un test de sensibilité à part.
 */

export const CONFIG_ANALYSE_SEMAINE = {
  // Au-delà, échantillon déterministe et régulier des simulations négatives (couverture affichée).
  simulationsMax: 400,
  // Factures retardées les plus contributives d'une simulation testées par paires (au plus 15 paires).
  facturesParPaires: 6,
  budgetMs: 8_000,
  // En deçà (€), une correction ne réduit pas le déficit.
  reductionMinimale: 1,
  // Factures pour lesquelles un scénario (trajectoires, date limite) est construit.
  scenariosDetailles: 8,
} as const;

export interface ParametresSemaine extends ParametresSimulation {
  factures: FactureAnalysee[];
  perimetre?: PerimetreFactures;
  semaine: { debut: string; fin: string };
}

export type EffetCorrection = "evite" | "reduit" | "aucun";

export interface ScenarioFacture {
  simulation: number;
  dateSimulee: string | null; // null : encaissée après l'horizon dans cette simulation
  retardJours: number; // par rapport à la date de référence
  datePassageSousZero: string; // début de l'épisode négatif qui touche la semaine
  dejaNegativeALOuverture: boolean;
  deficitMaxSemaine: number;
  effet: EffetCorrection;
  deficitApresCorrection: number;
  dateLimite: string | null; // null : la correction seule n'évite pas ce creux
  trajectoires: { simulee: number[]; corrigee: number[]; reference: number[] };
}

export interface FactureASecuriser {
  cleLigne: string;
  type: FactureAnalysee["type"];
  numero: string | null;
  client: string;
  montantRestant: number;
  dateEcheance: string | null;
  dateReference: string;
  dateReferenceEstimee: boolean;
  // Comptages sur les simulations négatives ANALYSÉES (pas des probabilités causales) :
  retardee: number; // encaissée après sa date de référence
  evite: number; // sa seule correction supprime tout solde négatif de la semaine
  reduit: number; // sa seule correction réduit le déficit sans le supprimer
  dansUnDuo: number; // nécessaire avec une autre facture (aucune des deux ne suffit seule)
  reductionMoyenne: number; // moyenne, sur `retardee`, de la baisse du déficit maximal de la semaine
  scenario: ScenarioFacture | null;
}

/**
 * Deux factures dont les retards se combinent :
 *  - « une_suffit » : leur retard simultané crée le déficit ; encaisser l'une des deux à sa date de
 *    référence suffit à l'éviter ;
 *  - « les_deux » : aucune correction seule ne suffit ; il faut les deux.
 */
export interface DuoASecuriser {
  factures: [string, string];
  nature: "une_suffit" | "les_deux";
  simulations: number;
}

export type NatureAutreFacteur = "non_obtenu" | "montant_inferieur" | "montant_superieur" | "encaissement_decale" | "depense_declenchee";

export interface AutreFacteur {
  cleLigne: string;
  libelle: string;
  nature: NatureAutreFacteur;
  constate: number; // simulations négatives analysées où ce facteur est défavorable
  evite: number;
  reduit: number;
}

export interface VulnerabiliteCertaine {
  cleLigne: string;
  numero: string | null;
  client: string;
  montantRestant: number;
  dateReference: string;
  retardJours: number;
  dateTestee: string | null;
  datePassageSousZero: string;
  deficit: number;
}

export interface ResultatSemaine {
  dates: string[];
  semaine: { debut: string; fin: string; debutIndex: number; finIndex: number };
  nombreSimulations: number;
  simulationsNegatives: number;
  probaNegatifSemaine: number;
  analysees: number;
  echantillon: boolean;
  dejaNegativesALOuverture: number;
  // Répartition des simulations analysées selon ce qui supprime le déficit de la semaine :
  //  facture   : une seule facture dont la correction, seule, l'évite (d'autres retards peuvent exister) ;
  //  simultane : plusieurs factures retardées dont la correction d'UNE seule, n'importe laquelle, suffit ;
  //  duo       : aucune correction seule ne suffit, celle de deux factures oui ;
  //  plusieurs : il faut corriger plus de deux factures ;
  //  autres    : corriger toutes les factures retardées ne suffit pas (autres facteurs).
  repartition: { facture: number; simultane: number; duo: number; plusieurs: number; autres: number };
  factures: FactureASecuriser[];
  duos: DuoASecuriser[];
  autresFacteurs: AutreFacteur[];
  vulnerabilites: VulnerabiliteCertaine[];
  couverture: {
    facturesCandidates: number;
    facturesNonExploitables: PerimetreFactures["aActualiser"];
    pairesTestees: number;
    facturesParPaires: number;
    arret: null | { cause: "budget_temps"; analysees: number };
    simulationsNonExpliquees: number; // ni factures ni autre facteur seul
  };
  reference: number[];
  durees: { simulationMs: number; analyseMs: number };
}

interface Candidat {
  facture: FactureAnalysee;
  ligne: number;
  evenements: number[];
  jourReference: number;
  montant: number;
  certaine: boolean;
  estimee: boolean;
}

const arrondi = (x: number) => Math.round(x * 100) / 100;

function deficitSemaine(soldes: Float64Array, a: number, b: number): number {
  let min = 0;
  for (let j = a; j <= b; j++) if (soldes[j] < min) min = soldes[j];
  return min < 0 ? -min : 0;
}

/** Début de l'épisode négatif qui touche la semaine (peut précéder la semaine). */
function debutEpisode(soldes: Float64Array, a: number, b: number): number {
  let j = a;
  while (j <= b && soldes[j] >= 0) j++;
  while (j > 0 && soldes[j - 1] < 0) j--;
  return j;
}

function candidatsDe(prep: PreparationSimulation, factures: FactureAnalysee[], jourRef: Int32Array, presentesRef: Uint8Array): Candidat[] {
  const parCle = new Map(factures.map((f) => [f.cleLigne, f]));
  const candidats: Candidat[] = [];
  prep.lignes.forEach((l, i) => {
    const facture = parCle.get(l.source.cle);
    if (!facture || presentesRef[i] !== 1) return;
    const evts = l.evenements.filter((k) => prep.evenements[k].montantSigne > 0);
    if (evts.length === 0) return;
    candidats.push({
      facture,
      ligne: i,
      evenements: evts,
      jourReference: Math.min(...evts.map((k) => jourRef[k])),
      montant: evts.reduce((s, k) => s + prep.evenements[k].montantSigne, 0),
      certaine: evts.every((k) => prep.sources[k].fiabiliteDate === 100),
      estimee: evts.some((k) => prep.sources[k].dateEstimee === true),
    });
  });
  return candidats;
}

export function analyserSemaine(params: ParametresSemaine): ResultatSemaine {
  const t0 = Date.now();
  const nombre = params.nombreSimulations ?? NOMBRE_SIMULATIONS_PAR_DEFAUT;
  const graine = params.graine ?? GRAINE_PAR_DEFAUT;
  const prep = preparerSimulation(params);
  const sim = simuler({ ...params, nombreSimulations: nombre, graine, capturer: true });
  const simulationMs = Date.now() - t0;
  const { dates, jours } = sim;
  const a = Math.max(0, dates.indexOf(params.semaine.debut));
  const bBrut = dates.indexOf(params.semaine.fin);
  const b = bBrut < 0 ? jours - 1 : bBrut;

  // Simulations négatives au moins un jour de la semaine (comptées une fois).
  const negatives: number[] = [];
  for (let s = 0; s < sim.nombre; s++) {
    for (let j = a; j <= b; j++) {
      if (sim.soldes[j * sim.nombre + s] < 0) {
        negatives.push(s);
        break;
      }
    }
  }
  const echantillon = negatives.length > CONFIG_ANALYSE_SEMAINE.simulationsMax;
  const retenues = echantillon
    ? Array.from({ length: CONFIG_ANALYSE_SEMAINE.simulationsMax }, (_, i) => negatives[Math.floor((i * negatives.length) / CONFIG_ANALYSE_SEMAINE.simulationsMax)])
    : negatives;

  const evaluer = creerEvaluateur(prep);
  const reference = evaluer();
  const jourRef = reference.jours;
  const candidats = candidatsDe(prep, params.factures, jourRef, reference.presentes);
  const estCandidat = new Set(candidats.map((c) => c.ligne));

  const corriger = (cs: Candidat[]) => {
    const m = new Map<number, number>();
    for (const c of cs) for (const k of c.evenements) m.set(k, jourRef[k]);
    return m;
  };
  const stats = new Map<string, { retardee: number; evite: number; reduit: number; duo: number; reduction: number; cas: { s: number; deficit: number; effet: EffetCorrection; reduction: number }[] }>();
  for (const c of candidats) stats.set(c.facture.cleLigne, { retardee: 0, evite: 0, reduit: 0, duo: 0, reduction: 0, cas: [] });
  const duos = new Map<string, number>();
  const autres = new Map<string, AutreFacteur>();
  const repartition = { facture: 0, simultane: 0, duo: 0, plusieurs: 0, autres: 0 };
  const compterDuo = (x: Candidat, y: Candidat, nature: DuoASecuriser["nature"]) => {
    const cle = `${[x.facture.cleLigne, y.facture.cleLigne].sort().join("|")}|${nature}`;
    duos.set(cle, (duos.get(cle) ?? 0) + 1);
  };
  let dejaNegatives = 0;
  let pairesTestees = 0;
  let nonExpliquees = 0;
  let arret: ResultatSemaine["couverture"]["arret"] = null;
  let analysees = 0;
  const finBudget = t0 + CONFIG_ANALYSE_SEMAINE.budgetMs;
  const tiragesParSimulation = new Map<number, TiragesSimulation>();

  for (const s of retenues) {
    if (Date.now() > finBudget) {
      arret = { cause: "budget_temps", analysees };
      break;
    }
    analysees++;
    const tir = tiragesDeSimulation(prep, etatDeSimulation(sim.etats!, s));
    const base = rejouerTirages(prep, tir);
    const deficit0 = deficitSemaine(base.soldes, a, b);
    if (a > 0 && base.soldes[a - 1] < 0) dejaNegatives++;

    // Factures retardées dans CETTE simulation (tirages réellement autorisés par les hypothèses).
    const retardees = candidats.filter((c) => base.presentes[c.ligne] === 1 && c.evenements.some((k) => base.jourEvenement[k] > jourRef[k]));
    const effets: { c: Candidat; effet: EffetCorrection; reduction: number }[] = retardees.map((c) => {
      const d1 = deficitSemaine(rejouerTirages(prep, tir, { jours: corriger([c]) }).soldes, a, b);
      const reduction = Math.max(0, deficit0 - d1);
      const effet: EffetCorrection = d1 === 0 ? "evite" : reduction >= CONFIG_ANALYSE_SEMAINE.reductionMinimale ? "reduit" : "aucun";
      const st = stats.get(c.facture.cleLigne)!;
      st.retardee++;
      st.reduction += reduction;
      if (effet === "evite") st.evite++;
      if (effet === "reduit") st.reduit++;
      st.cas.push({ s, deficit: deficit0, effet, reduction });
      return { c, effet, reduction };
    });

    let classe: keyof typeof repartition;
    const suffisantes = effets.filter((e) => e.effet === "evite");
    if (suffisantes.length === 1) classe = "facture";
    else if (suffisantes.length > 1) {
      classe = "simultane";
      for (let i = 0; i < suffisantes.length; i++) for (let j = i + 1; j < suffisantes.length; j++) compterDuo(suffisantes[i].c, suffisantes[j].c, "une_suffit");
    } else {
      const testees = [...effets].sort((x, y) => y.reduction - x.reduction).slice(0, CONFIG_ANALYSE_SEMAINE.facturesParPaires);
      let duoTrouve = false;
      for (let i = 0; i < testees.length; i++) {
        for (let j = i + 1; j < testees.length; j++) {
          pairesTestees++;
          const d = deficitSemaine(rejouerTirages(prep, tir, { jours: corriger([testees[i].c, testees[j].c]) }).soldes, a, b);
          if (d === 0) {
            duoTrouve = true;
            compterDuo(testees[i].c, testees[j].c, "les_deux");
            stats.get(testees[i].c.facture.cleLigne)!.duo++;
            stats.get(testees[j].c.facture.cleLigne)!.duo++;
          }
        }
      }
      if (duoTrouve) classe = "duo";
      else if (retardees.length > 0 && deficitSemaine(rejouerTirages(prep, tir, { jours: corriger(retardees) }).soldes, a, b) === 0) classe = "plusieurs";
      else classe = "autres";
    }
    repartition[classe]++;

    // Autres facteurs défavorables de cette simulation, rejoués un par un.
    if (classe !== "facture" && classe !== "simultane") {
      let unFacteurEvite = false;
      prep.lignes.forEach((l, i) => {
        if (estCandidat.has(i)) return;
        const evts = l.evenements;
        if (evts.length === 0) return;
        const encaissement = prep.evenements[evts[0]].montantSigne > 0;
        const tests: { nature: NatureAutreFacteur; modifs: Parameters<typeof rejouerTirages>[2] }[] = [];
        if (encaissement && tir.tirage[i] === 0 && l.source.probabilite > 0) tests.push({ nature: "non_obtenu", modifs: { presence: new Map([[i, 1]]) } });
        if (base.presentes[i] === 1 && encaissement && tir.facteurMontant[i] < 1 - 1e-9) tests.push({ nature: "montant_inferieur", modifs: { facteurs: new Map([[i, 1]]) } });
        if (base.presentes[i] === 1 && !encaissement && tir.facteurMontant[i] > 1 + 1e-9) tests.push({ nature: "montant_superieur", modifs: { facteurs: new Map([[i, 1]]) } });
        if (base.presentes[i] === 1 && encaissement && evts.some((k) => base.jourEvenement[k] > jourRef[k])) {
          tests.push({ nature: "encaissement_decale", modifs: { jours: new Map(evts.map((k) => [k, jourRef[k]])) } });
        }
        if (!encaissement && base.presentes[i] === 1 && reference.presentes[i] === 0) tests.push({ nature: "depense_declenchee", modifs: { presence: new Map([[i, 0]]) } });
        for (const test of tests) {
          const d = deficitSemaine(rejouerTirages(prep, tir, test.modifs).soldes, a, b);
          const cle = `${l.source.cle}|${test.nature}`;
          const af = autres.get(cle) ?? { cleLigne: l.source.cle, libelle: prep.sources[evts[0]].libelle, nature: test.nature, constate: 0, evite: 0, reduit: 0 };
          af.constate++;
          if (d === 0) {
            af.evite++;
            unFacteurEvite = true;
          } else if (deficit0 - d >= CONFIG_ANALYSE_SEMAINE.reductionMinimale) af.reduit++;
          autres.set(cle, af);
        }
      });
      if (classe === "autres" && !unFacteurEvite) nonExpliquees++;
    }
    if (tiragesParSimulation.size < 64) tiragesParSimulation.set(s, tir);
  }

  // Classement : ce que la correction évite d'abord (pas le montant).
  const classees = candidats
    .map((c) => ({ c, st: stats.get(c.facture.cleLigne)! }))
    // Une facture seulement retardée, sans effet mesuré sur le déficit de la semaine, n'est pas listée :
    // un retard fréquent n'est pas une responsabilité dans le déficit.
    .filter(({ st }) => st.retardee > 0 && st.evite + st.reduit + st.duo > 0)
    .sort((x, y) => y.st.evite - x.st.evite || y.st.duo - x.st.duo || y.st.reduit - x.st.reduit || y.st.reduction / y.st.retardee - x.st.reduction / x.st.retardee);

  const factures: FactureASecuriser[] = classees.map(({ c, st }, rang) => ({
    cleLigne: c.facture.cleLigne,
    type: c.facture.type,
    numero: c.facture.numero,
    client: c.facture.client,
    montantRestant: arrondi(c.montant),
    dateEcheance: c.facture.dateEcheance,
    dateReference: dates[Math.min(c.jourReference, jours - 1)],
    dateReferenceEstimee: c.estimee,
    retardee: st.retardee,
    evite: st.evite,
    reduit: st.reduit,
    dansUnDuo: st.duo,
    reductionMoyenne: arrondi(st.reduction / st.retardee),
    scenario: rang < CONFIG_ANALYSE_SEMAINE.scenariosDetailles ? scenarioDe(c, st.cas) : null,
  }));

  function scenarioDe(c: Candidat, cas: { s: number; deficit: number; effet: EffetCorrection; reduction: number }[]): ScenarioFacture | null {
    // Représentatif : parmi les cas où la correction évite le déficit, le déficit médian ; sinon la
    // plus forte réduction.
    const evites = cas.filter((x) => x.effet === "evite").sort((x, y) => x.deficit - y.deficit);
    const choisi = evites.length > 0 ? evites[Math.floor(evites.length / 2)] : [...cas].sort((x, y) => y.reduction - x.reduction)[0];
    if (!choisi) return null;
    const tir = tiragesParSimulation.get(choisi.s) ?? tiragesDeSimulation(prep, etatDeSimulation(sim.etats!, choisi.s));
    const base = rejouerTirages(prep, tir);
    const corrigee = rejouerTirages(prep, tir, { jours: corriger([c]) });
    const k0 = c.evenements[0];
    const jourSimule = base.jourEvenement[k0];
    const deficit0 = deficitSemaine(base.soldes, a, b);
    const deficit1 = deficitSemaine(corrigee.soldes, a, b);
    // Date limite : paiements de la date de référence jusqu'à ce jour, tous sans déficit dans la semaine.
    let dateLimite: string | null = null;
    if (deficit1 === 0) {
      let d = c.jourReference;
      while (d < jourSimule && d < jours) {
        const essai = rejouerTirages(prep, tir, { jours: new Map(c.evenements.map((k) => [k, d])) });
        if (deficitSemaine(essai.soldes, a, b) > 0) break;
        d++;
      }
      dateLimite = d - 1 >= c.jourReference ? dates[Math.min(d - 1, jours - 1)] : null;
    }
    const debut = debutEpisode(base.soldes, a, b);
    return {
      simulation: choisi.s,
      dateSimulee: jourSimule < jours ? dates[jourSimule] : null,
      retardJours: jourSimule - c.jourReference,
      datePassageSousZero: dates[debut],
      dejaNegativeALOuverture: debut < a,
      deficitMaxSemaine: arrondi(deficit0),
      effet: deficit1 === 0 ? "evite" : deficit0 - deficit1 >= CONFIG_ANALYSE_SEMAINE.reductionMinimale ? "reduit" : "aucun",
      deficitApresCorrection: arrondi(deficit1),
      dateLimite,
      trajectoires: { simulee: Array.from(base.soldes, arrondi), corrigee: Array.from(corrigee.soldes, arrondi), reference: Array.from(reference.soldes, arrondi) },
    };
  }

  // Vulnérabilités : factures à date « Ferme », jamais retardées dans les tirages. Test séparé sur la
  // référence : premier retard qui ferait passer la semaine sous 0 €.
  const vulnerabilites: VulnerabiliteCertaine[] = [];
  if (deficitSemaine(reference.soldes, a, b) === 0) {
    for (const c of candidats.filter((x) => x.certaine)) {
      for (let k = 1; c.jourReference + k <= Math.max(b + 1, c.jourReference + 1) && c.jourReference + k <= jours; k++) {
        const soldes = evaluer(new Map(c.evenements.map((e) => [e, Math.min(jourRef[e] + k, jours)]))).soldes;
        const d = deficitSemaine(soldes, a, b);
        if (d > 0) {
          vulnerabilites.push({
            cleLigne: c.facture.cleLigne,
            numero: c.facture.numero,
            client: c.facture.client,
            montantRestant: arrondi(c.montant),
            dateReference: dates[c.jourReference],
            retardJours: k,
            dateTestee: c.jourReference + k < jours ? dates[c.jourReference + k] : null,
            datePassageSousZero: dates[debutEpisode(soldes, a, b)],
            deficit: arrondi(d),
          });
          break;
        }
      }
    }
  }

  return {
    dates,
    semaine: { debut: dates[a], fin: dates[b], debutIndex: a, finIndex: b },
    nombreSimulations: sim.nombre,
    simulationsNegatives: negatives.length,
    probaNegatifSemaine: negatives.length / sim.nombre,
    analysees,
    echantillon,
    dejaNegativesALOuverture: dejaNegatives,
    repartition,
    factures,
    duos: [...duos.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 10)
      .map(([cle, n]) => {
        const [x, y, nature] = cle.split("|");
        return { factures: [x, y] as [string, string], nature: nature as DuoASecuriser["nature"], simulations: n };
      }),
    autresFacteurs: [...autres.values()].filter((x) => x.evite > 0 || x.reduit > 0).sort((x, y) => y.evite - x.evite || y.reduit - x.reduit),
    vulnerabilites,
    couverture: {
      facturesCandidates: candidats.length,
      facturesNonExploitables: params.perimetre?.aActualiser ?? [],
      pairesTestees,
      facturesParPaires: CONFIG_ANALYSE_SEMAINE.facturesParPaires,
      arret,
      simulationsNonExpliquees: nonExpliquees,
    },
    reference: Array.from(reference.soldes, arrondi),
    durees: { simulationMs, analyseMs: Date.now() - t0 - simulationMs },
  };
}

/**
 * Tester un décalage : la simulation `s` rejouée avec la facture encaissée le jour `jour`, tout le
 * reste identique. Le générateur est ramené au début de `s` en rejouant les seuls tirages des
 * simulations précédentes (aucun nouveau hasard). Rien n'est enregistré.
 */
export function testerDecalage(params: ParametresSimulation, s: number, cleLigne: string, date: string, semaine: { debut: string; fin: string }) {
  const prep: PreparationSimulation = preparerSimulation(params);
  // Mêmes graine et tirages que la prévision : l'état du générateur au début de la simulation s.
  const etats = simuler({ ...params, graine: params.graine ?? GRAINE_PAR_DEFAUT, nombreSimulations: s + 1, capturer: true }).etats!;
  const tir = tiragesDeSimulation(prep, etatDeSimulation(etats, s));
  const ligne = prep.lignes.findIndex((l) => l.source.cle === cleLigne);
  if (ligne < 0) throw new Error("Facture absente de la prévision.");
  const jour = Math.max(0, prep.dates.indexOf(date) >= 0 ? prep.dates.indexOf(date) : date > prep.dates[prep.jours - 1] ? prep.jours : 0);
  const testee = rejouerTirages(prep, tir, { jours: new Map(prep.lignes[ligne].evenements.map((k) => [k, jour])) });
  const a = Math.max(0, prep.dates.indexOf(semaine.debut));
  const b = prep.dates.indexOf(semaine.fin) < 0 ? prep.jours - 1 : prep.dates.indexOf(semaine.fin);
  const d = deficitSemaine(testee.soldes, a, b);
  return {
    soldes: Array.from(testee.soldes, arrondi),
    deficitSemaine: arrondi(d),
    datePassageSousZero: d > 0 ? prep.dates[debutEpisode(testee.soldes, a, b)] : null,
  };
}
