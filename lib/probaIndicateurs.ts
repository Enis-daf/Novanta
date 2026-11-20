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
