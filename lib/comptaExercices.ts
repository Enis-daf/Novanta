import { Periode } from "./pastTransactions";

/**
 * Exercices comptables et périmètre d'une synchronisation — pur, sans effet de bord.
 *
 * Pennylane renvoie un statut par exercice : `open`, `reopen`, `closed`, `frozen`, sans en définir le sens.
 * Seul `closed` vaut clôture. Tout le reste continue d'être lu : relire un exercice en trop ne coûte rien,
 * alors que croire à tort qu'il est clôturé figerait de faux chiffres. L'âge d'un exercice ne dit rien : un
 * exercice ancien mais `open` reste non clôturé.
 */

export interface ExerciceComptable {
  idSource: string;
  debut: string; // YYYY-MM-DD
  fin: string; // YYYY-MM-DD
  statut: string | null;
}

export type EtatExercice = "cloture" | "non_cloture" | "ambigu";

export function etatExercice(statut: string | null): EtatExercice {
  if (statut === "closed") return "cloture";
  if (statut === "open" || statut === "reopen") return "non_cloture";
  return "ambigu";
}

export const DECLENCHEURS = ["quotidien", "hebdomadaire", "manuel", "exceptionnel"] as const;
export type Declencheur = (typeof DECLENCHEURS)[number];

function moisSuivant(mois: string): string {
  const [annee, numero] = mois.split("-").map(Number);
  return new Date(Date.UTC(annee, numero, 1)).toISOString().slice(0, 7);
}

function moisPrecedent(mois: string): string {
  const [annee, numero] = mois.split("-").map(Number);
  return new Date(Date.UTC(annee, numero - 2, 1)).toISOString().slice(0, 7);
}

/** Mois (YYYY-MM) recoupant l'intervalle de dates, bornes incluses. */
export function moisEntre(debut: string, fin: string): string[] {
  const mois: string[] = [];
  for (let m = debut.slice(0, 7); m <= fin.slice(0, 7); m = moisSuivant(m)) mois.push(m);
  return mois;
}

/** Exercice commencé : jamais de lecture d'un exercice à venir. */
export function estCommence(exercice: ExerciceComptable, aujourdhui: string): boolean {
  return exercice.debut <= aujourdhui;
}

function exercicesDuMois(exercices: ExerciceComptable[], mois: string): ExerciceComptable[] {
  return exercices.filter((e) => e.debut.slice(0, 7) <= mois && e.fin.slice(0, 7) >= mois);
}

/** Mois protégé : tous les exercices qui le couvrent sont clôturés. Sans exercice connu, rien ne le protège. */
function estProtege(exercices: ExerciceComptable[], mois: string): boolean {
  const couvrants = exercicesDuMois(exercices, mois);
  return couvrants.length > 0 && couvrants.every((e) => etatExercice(e.statut) === "cloture");
}

export interface PerimetreSynchro {
  mois: string[];
  // Ce qu'il faut signaler : statut ambigu, exercices illisibles. Jamais une déduction silencieuse.
  limites: string[];
}

export const LIMITE_STATUT_AMBIGU = "statut_exercice_ambigu";
export const LIMITE_EXERCICES_INDISPONIBLES = "exercices_indisponibles";

/**
 * - quotidien : mois en cours et mois précédent ;
 * - hebdomadaire et manuel : tous les exercices non clôturés et commencés, de leur début à aujourd'hui, car
 *   une écriture peut modifier un mois vieux de plus de quatre mois ;
 * - exceptionnel : l'exercice désigné, même clôturé (voir perimetreExceptionnel).
 * Jamais un mois à venir ; jamais un mois entièrement couvert par des exercices clôturés.
 */
export function perimetreSynchro(declencheur: Exclude<Declencheur, "exceptionnel">, exercices: ExerciceComptable[] | null, aujourdhui: string): PerimetreSynchro {
  const courant = aujourdhui.slice(0, 7);
  const recents = [moisPrecedent(courant), courant];
  if (exercices === null) return { mois: recents, limites: [LIMITE_EXERCICES_INDISPONIBLES] };

  const lus = new Set(recents.filter((m) => !estProtege(exercices, m)));
  const commences = exercices.filter((e) => estCommence(e, aujourdhui));
  if (declencheur !== "quotidien") {
    for (const exercice of commences) {
      if (etatExercice(exercice.statut) === "cloture") continue;
      for (const m of moisEntre(exercice.debut, exercice.fin)) if (m <= courant) lus.add(m);
    }
  }
  const ambigu = commences.some((e) => etatExercice(e.statut) === "ambigu");
  return { mois: [...lus].sort(), limites: ambigu ? [LIMITE_STATUT_AMBIGU] : [] };
}

/** Resynchronisation exceptionnelle et explicite d'un exercice, même clôturé : jamais ses mois à venir. */
export function perimetreExceptionnel(exercice: ExerciceComptable, aujourdhui: string): PerimetreSynchro {
  const courant = aujourdhui.slice(0, 7);
  return { mois: moisEntre(exercice.debut, exercice.fin).filter((m) => m <= courant), limites: [] };
}

const SEPT_JOURS_MS = 7 * 86_400_000;

/**
 * Passage planifié : hebdomadaire si la dernière lecture complète réussie date de plus de 7 jours, sinon
 * quotidien. La cadence ne dépend pas du jour de la semaine : un passage hebdomadaire manqué ou en échec se
 * rattrape dès le lendemain, et une société nouvellement connectée est lue en entier.
 */
export function declencheurPlanifie(derniereLectureComplete: string | null, maintenant: Date): "quotidien" | "hebdomadaire" {
  if (!derniereLectureComplete) return "hebdomadaire";
  return maintenant.getTime() - new Date(derniereLectureComplete).getTime() >= SEPT_JOURS_MS ? "hebdomadaire" : "quotidien";
}

export interface LectureProvisoire {
  provisoire: boolean;
  // Aucun exercice connu, ou statut non documenté : on le dit, sans conclure à une clôture.
  ambigu: boolean;
}

/** Comptabilité provisoire : au moins un mois de la période n'appartient pas à un exercice clôturé. */
export function lectureProvisoire(periode: Periode, exercices: ExerciceComptable[]): LectureProvisoire {
  let provisoire = false;
  let ambigu = false;
  for (const mois of moisEntre(periode.debut, periode.fin)) {
    const couvrants = exercicesDuMois(exercices, mois);
    if (couvrants.length === 0) {
      provisoire = true;
      ambigu = true;
    } else if (!couvrants.every((e) => etatExercice(e.statut) === "cloture")) {
      provisoire = true;
      if (couvrants.some((e) => etatExercice(e.statut) === "ambigu")) ambigu = true;
    }
  }
  return { provisoire, ambigu };
}

export interface PerimetreStock {
  cle: string; // début du périmètre : clé de l'arbitrage enregistré
  debut: string;
  fin: string;
  exercice: boolean; // false : aucun exercice connu, année civile par défaut
}

/**
 * Périmètres de décision de la variation de stocks pour une période : l'exercice entier, car une écriture
 * annuelle de décembre peut couvrir douze saisies mensuelles. Un mois sans exercice connu relève de son année
 * civile. Une période à cheval donne plusieurs périmètres, décidés séparément.
 */
export function perimetresStock(periode: Periode, exercices: ExerciceComptable[]): PerimetreStock[] {
  const parCle = new Map<string, PerimetreStock>();
  for (const mois of moisEntre(periode.debut, periode.fin)) {
    const couvrants = exercicesDuMois(exercices, mois);
    if (couvrants.length > 0) {
      for (const e of couvrants) parCle.set(e.debut, { cle: e.debut, debut: e.debut, fin: e.fin, exercice: true });
    } else {
      const annee = mois.slice(0, 4);
      const cle = `${annee}-01-01`;
      if (!parCle.has(cle)) parCle.set(cle, { cle, debut: cle, fin: `${annee}-12-31`, exercice: false });
    }
  }
  return [...parCle.values()].sort((a, b) => a.debut.localeCompare(b.debut));
}
