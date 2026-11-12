import { Alea, creerAlea, GRAINE_PAR_DEFAUT } from "./probaAlea";
import { Echantillonneur, echantillonneurPour, ModeleRetards } from "./probaCalibration";
import { EvenementTresorerie, FACTEURS_FIABILITE, LigneProbabiliste, ordonnerLignes, OrdreLignes } from "./probaEvenements";
import { joursEntre } from "./pastBfrDelais";
import { ajouterJours, parseDateISO, toISODate } from "./dates";

/**
 * Prévision probabiliste — 4. Moteur de simulation. Fonction pure, sans interface ni base :
 * testable seule.
 *
 * Pour chaque simulation :
 *  1. on part de la trésorerie initiale ;
 *  2. les lignes certaines (100 %) sont toujours présentes ;
 *  3. chaque autre ligne survient avec sa probabilité (tirage oui / non), seulement si sa ligne
 *     parente est survenue ;
 *  4. la date de chaque échéance non « Ferme » est simulée :
 *       date simulée = max(date prévue, base + facteur(fiabilité) × retard tiré)
 *     base = l'échéance si la date prévue est postérieure (retard déjà anticipé), sinon la date prévue,
 *     où le retard est tiré de la distribution du compte (client -> segment -> compte -> défaut,
 *     lib/probaCalibration.ts), côté clients pour un encaissement, côté fournisseurs pour un
 *     décaissement. La date prévue reste un plancher : si l'utilisateur a déjà anticipé un retard,
 *     seuls les tirages plus longs la décalent. Pour une facture déjà échue, le retard est tiré
 *     sachant qu'elle n'est pas encore réglée (jamais une date passée) ;
 *  5. chaque flux est posé à sa date simulée — au-delà de l'horizon, il sort de la prévision ;
 *  6. la trésorerie est recalculée jour par jour sur tout l'horizon.
 *
 * Reproductible : même graine -> mêmes résultats.
 */

export const NOMBRE_SIMULATIONS_PAR_DEFAUT = 10_000;
// Tirages conditionnels (facture échue) : au-delà, on garde la date prévue.
const ESSAIS_CONDITIONNELS = 32;

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
  minimums: Float64Array; // point bas de chaque simulation
  jourDuMinimum: Int32Array;
  premierJourNegatif: Int32Array; // -1 : jamais sous zéro
  dependancesIgnorees: OrdreLignes["dependancesIgnorees"];
}

interface EvenementPrepare {
  ligne: number; // index dans l'ordre des lignes
  montantSigne: number;
  jourPrevu: number;
  jourBase: number; // échéance si connue, sinon date prévue
  facteur: number;
  echantillonneur: Echantillonneur | null;
}

/** Jour simulé d'une échéance (peut dépasser l'horizon). */
export function simulerJour(e: Pick<EvenementPrepare, "jourPrevu" | "jourBase" | "facteur" | "echantillonneur">, alea: Alea): number {
  const plancher = Math.max(e.jourPrevu, 0);
  if (e.facteur <= 0 || e.echantillonneur === null) return plancher;
  // Facture déjà échue et non réglée : seuls les retards qui la mènent à aujourd'hui ou après sont possibles.
  const requis = -e.jourBase;
  for (let essai = 0; essai < ESSAIS_CONDITIONNELS; essai++) {
    const retard = Math.round(e.facteur * e.echantillonneur.tirer(alea));
    if (retard >= requis) return Math.max(plancher, e.jourBase + retard);
  }
  return plancher;
}

/** Survenue de chaque ligne (dans l'ordre topologique) pour une simulation. */
export function tirerSurvenues(ordre: LigneProbabiliste[], indexParent: Int32Array, survenues: Uint8Array, alea: Alea): void {
  for (let i = 0; i < ordre.length; i++) {
    const parent = indexParent[i];
    if (parent >= 0 && survenues[parent] === 0) {
      survenues[i] = 0;
      continue;
    }
    const p = ordre[i].probabilite;
    survenues[i] = p >= 100 ? 1 : p <= 0 ? 0 : alea.uniforme() < p / 100 ? 1 : 0;
  }
}

export function simuler(params: ParametresSimulation): SimulationBrute {
  const nombre = Math.max(1, Math.floor(params.nombreSimulations ?? NOMBRE_SIMULATIONS_PAR_DEFAUT));
  const horizon = Math.max(0, Math.floor(params.horizonJours));
  const jours = horizon + 1;
  const alea = creerAlea(params.graine ?? GRAINE_PAR_DEFAUT);
  const debut = parseDateISO(params.dateDepart);
  const dates = Array.from({ length: jours }, (_, i) => toISODate(ajouterJours(debut, i)));

  const { ordre, dependancesIgnorees } = ordonnerLignes(params.lignes);
  const indexLigne = new Map(ordre.map((l, i) => [l.cle, i]));
  const indexParent = new Int32Array(ordre.length).map((_, i) => (ordre[i].parentCle !== null ? indexLigne.get(ordre[i].parentCle!) ?? -1 : -1));

  const evenements: EvenementPrepare[] = [];
  for (const e of params.evenements) {
    const ligne = indexLigne.get(e.cleLigne);
    if (ligne === undefined || !(e.montant > 0)) continue;
    const jourPrevu = joursEntre(params.dateDepart, e.datePrevue);
    const facteur = FACTEURS_FIABILITE[e.fiabiliteDate] ?? 0;
    const modele = e.sens === "encaissement" ? params.modeles.client : params.modeles.fournisseur;
    evenements.push({
      ligne,
      montantSigne: e.sens === "encaissement" ? e.montant : -e.montant,
      jourPrevu,
      // Date prévue avant l'échéance (paiement anticipé attendu) : les retards partent de la date prévue.
      jourBase: e.dateEcheance ? Math.min(joursEntre(params.dateDepart, e.dateEcheance), jourPrevu) : jourPrevu,
      facteur,
      echantillonneur: facteur > 0 ? echantillonneurPour(modele, e.tiers, e.montant) : null,
    });
  }

  const soldes = new Float64Array(jours * nombre);
  const minimums = new Float64Array(nombre);
  const jourDuMinimum = new Int32Array(nombre);
  const premierJourNegatif = new Int32Array(nombre);
  const variations = new Float64Array(jours);
  const survenues = new Uint8Array(ordre.length);

  for (let s = 0; s < nombre; s++) {
    variations.fill(0);
    tirerSurvenues(ordre, indexParent, survenues, alea);
    for (const e of evenements) {
      if (survenues[e.ligne] === 0) continue;
      const jour = simulerJour(e, alea);
      if (jour < jours) variations[jour] += e.montantSigne;
    }
    let solde = params.soldeInitial;
    let minimum = Infinity;
    let jourMin = 0;
    let negatif = -1;
    for (let j = 0; j < jours; j++) {
      solde += variations[j];
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

  return { nombre, jours, dates, soldes, minimums, jourDuMinimum, premierJourNegatif, dependancesIgnorees };
}
