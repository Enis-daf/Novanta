import { quantileTrie } from "./probaCalibration";
import { SimulationBrute } from "./probaSimulation";

/**
 * Prévision probabiliste — 5. Agrégation des percentiles et 6. indicateurs de risque. Fonctions
 * pures sur le résultat brut du moteur.
 *
 * Les P10 / P50 / P90 de chaque jour sont des percentiles PONCTUELS : la ligne P10 relie les
 * 10e centiles de chaque jour, elle ne correspond à aucune simulation particulière et ne doit
 * jamais être présentée comme une trajectoire.
 */

export const NIVEAUX_COUVERTURE = [0.9, 0.95, 0.99] as const;
// Un jour est « en tension » quand la trésorerie y est négative dans au moins 10 % des simulations.
export const SEUIL_TENSION = 0.1;

export interface PointProbabiliste {
  date: string;
  p10: number;
  p50: number;
  p90: number;
  probaNegatif: number; // part des simulations sous zéro CE jour-là
  probaNegatifAvant: number; // part des simulations passées sous zéro à cette date ou avant
  // Trésorerie supplémentaire pour rester ≥ 0 jusqu'à cette date avec 90 / 95 / 99 % de probabilité.
  besoin90: number;
  besoin95: number;
  besoin99: number;
}

export interface PeriodeTension {
  debut: string;
  fin: string;
  probaMax: number;
  dateProbaMax: string;
}

/**
 * Semaine de l'horizon (lundi -> dimanche, bornée à l'horizon). `probaNegatif` : part des
 * simulations dont le solde est sous 0 € AU MOINS UN JOUR de la semaine — une simulation négative
 * trois jours de la semaine n'est comptée qu'une fois. À ne pas confondre avec la probabilité d'être
 * sous 0 € un jour donné (PointProbabiliste.probaNegatif) ni avec celle de passer sous 0 € au moins
 * une fois sur tout l'horizon (probaNegatifHorizon).
 */
export interface SemaineRisque {
  debut: string; // lundi, ou premier jour de l'horizon
  fin: string; // dimanche, ou dernier jour de l'horizon
  debutIndex: number;
  finIndex: number;
  simulationsNegatives: number;
  probaNegatif: number;
}

/** Semaines lundi -> dimanche couvrant l'horizon (première et dernière éventuellement partielles). */
export function semainesDeLHorizon(dates: string[]): { debut: string; fin: string; debutIndex: number; finIndex: number }[] {
  const semaines: { debut: string; fin: string; debutIndex: number; finIndex: number }[] = [];
  for (let j = 0; j < dates.length; j++) {
    const jourSemaine = new Date(`${dates[j]}T00:00:00Z`).getUTCDay(); // 0 = dimanche
    if (j === 0 || jourSemaine === 1) semaines.push({ debut: dates[j], fin: dates[j], debutIndex: j, finIndex: j });
    const courante = semaines[semaines.length - 1];
    courante.fin = dates[j];
    courante.finIndex = j;
  }
  return semaines;
}

export interface IndicateursRisque {
  nombreSimulations: number;
  serie: PointProbabiliste[];
  probaNegatifHorizon: number;
  minimum: { p10: number; p50: number; p90: number };
  // Jour où la probabilité d'être sous zéro est la plus forte (null : jamais sous zéro).
  dateProbaNegatifMax: string | null;
  probaNegatifMax: number;
  // Jours où le P10 et le P50 quotidiens atteignent leur minimum.
  dateMinimumP10: string;
  dateMinimumP50: string;
  periodesTension: PeriodeTension[];
  semaines: SemaineRisque[];
}

/** Plus petite valeur A ≥ 0 telle qu'une part ≥ niveau des besoins triés soit ≤ A (rang supérieur). */
export function quantileConservateur(trie: ArrayLike<number>, niveau: number): number {
  const rang = Math.min(trie.length, Math.max(1, Math.ceil(niveau * trie.length - 1e-9)));
  return Math.max(0, trie[rang - 1]);
}

const arrondiEuro = (x: number) => Math.round(x);

export function calculerIndicateurs(sim: SimulationBrute, seuilTension: number = SEUIL_TENSION): IndicateursRisque {
  const { nombre, jours, dates, soldes } = sim;
  const colonne = new Float64Array(nombre);
  const minJusqua = new Float64Array(nombre).fill(Infinity);
  const besoins = new Float64Array(nombre);

  // Première date sous zéro -> cumul « déjà passé sous zéro à cette date ».
  const premiersNegatifs = new Int32Array(jours);
  for (let s = 0; s < nombre; s++) if (sim.premierJourNegatif[s] >= 0) premiersNegatifs[sim.premierJourNegatif[s]]++;

  const serie: PointProbabiliste[] = [];
  let cumulNegatifs = 0;
  for (let j = 0; j < jours; j++) {
    let negatifs = 0;
    for (let s = 0; s < nombre; s++) {
      const v = soldes[j * nombre + s];
      colonne[s] = v;
      if (v < 0) negatifs++;
      if (v < minJusqua[s]) minJusqua[s] = v;
      besoins[s] = -minJusqua[s];
    }
    colonne.sort();
    besoins.sort();
    cumulNegatifs += premiersNegatifs[j];
    serie.push({
      date: dates[j],
      p10: arrondiEuro(quantileTrie(colonne, 0.1)),
      p50: arrondiEuro(quantileTrie(colonne, 0.5)),
      p90: arrondiEuro(quantileTrie(colonne, 0.9)),
      probaNegatif: negatifs / nombre,
      probaNegatifAvant: cumulNegatifs / nombre,
      besoin90: arrondiEuro(quantileConservateur(besoins, 0.9)),
      besoin95: arrondiEuro(quantileConservateur(besoins, 0.95)),
      besoin99: arrondiEuro(quantileConservateur(besoins, 0.99)),
    });
  }

  const minimums = Float64Array.from(sim.minimums).sort();
  let indexProbaMax = -1;
  let indexP10 = 0;
  let indexP50 = 0;
  serie.forEach((p, j) => {
    if (p.probaNegatif > 0 && (indexProbaMax < 0 || p.probaNegatif > serie[indexProbaMax].probaNegatif)) indexProbaMax = j;
    if (p.p10 < serie[indexP10].p10) indexP10 = j;
    if (p.p50 < serie[indexP50].p50) indexP50 = j;
  });

  return {
    nombreSimulations: nombre,
    serie,
    probaNegatifHorizon: serie[serie.length - 1].probaNegatifAvant,
    minimum: {
      p10: arrondiEuro(quantileTrie(minimums, 0.1)),
      p50: arrondiEuro(quantileTrie(minimums, 0.5)),
      p90: arrondiEuro(quantileTrie(minimums, 0.9)),
    },
    dateProbaNegatifMax: indexProbaMax >= 0 ? serie[indexProbaMax].date : null,
    probaNegatifMax: indexProbaMax >= 0 ? serie[indexProbaMax].probaNegatif : 0,
    dateMinimumP10: serie[indexP10].date,
    dateMinimumP50: serie[indexP50].date,
    periodesTension: periodesDeTension(serie, seuilTension),
    semaines: semainesDeLHorizon(dates).map((w) => {
      let negatives = 0;
      for (let s = 0; s < nombre; s++) {
        for (let j = w.debutIndex; j <= w.finIndex; j++) {
          if (soldes[j * nombre + s] < 0) {
            negatives++;
            break;
          }
        }
      }
      return { ...w, simulationsNegatives: negatives, probaNegatif: negatives / nombre };
    }),
  };
}

/** Plages de jours consécutifs où la probabilité d'être sous zéro atteint le seuil, les plus fortes d'abord. */
export function periodesDeTension(serie: PointProbabiliste[], seuil: number = SEUIL_TENSION, maximum = 3): PeriodeTension[] {
  const periodes: PeriodeTension[] = [];
  let courante: PeriodeTension | null = null;
  for (const p of serie) {
    if (p.probaNegatif >= seuil && p.probaNegatif > 0) {
      if (!courante) courante = { debut: p.date, fin: p.date, probaMax: p.probaNegatif, dateProbaMax: p.date };
      courante.fin = p.date;
      if (p.probaNegatif > courante.probaMax) {
        courante.probaMax = p.probaNegatif;
        courante.dateProbaMax = p.date;
      }
    } else if (courante) {
      periodes.push(courante);
      courante = null;
    }
  }
  if (courante) periodes.push(courante);
  return periodes.sort((a, b) => b.probaMax - a.probaMax).slice(0, maximum);
}
