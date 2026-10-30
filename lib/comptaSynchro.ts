import { CompteSource, LectureBalance, SoldeSource, SourceComptable } from "./comptaSource";
import { Declencheur, ExerciceComptable, LIMITE_EXERCICES_INDISPONIBLES, perimetreExceptionnel, perimetreSynchro } from "./comptaExercices";

/**
 * Synchronisation comptable d'une société : lit, contrôle, remplace. Sans dépendance à la base ni au réseau
 * (tout passe par la source et le dépôt), donc testable en entier.
 *
 * Chaque mois est lu en entier et contrôlé AVANT d'être écrit, puis remplacé d'un bloc. Un mois en échec garde
 * ses données précédentes et le bilan le nomme. La reprise n'a pas d'état à gérer : la lecture suivante relit
 * le périmètre, et remplacer deux fois donne le même résultat.
 */

export type RaisonEchecMois = "troncature" | "desequilibre" | "balance_vide_suspecte" | "format" | "lecture" | "ecriture" | "non_lu";

export interface EchecMois {
  mois: string;
  raison: RaisonEchecMois;
}

export type StatutSynchro = "success" | "partial" | "error";

export interface BilanSynchro {
  statut: StatutSynchro;
  moisDemandes: number;
  moisActualises: number;
  moisEnEchec: EchecMois[];
  nouveauxComptes: number;
  comptesIllisibles: number;
  limites: string[];
  codeErreur: string | null;
}

export interface DepotSynchro {
  // null : une synchronisation est déjà en cours pour cette société.
  commencer(declencheur: Declencheur): Promise<string | null>;
  terminer(idExecution: string, bilan: BilanSynchro): Promise<void>;
  enregistrerExercices(exercices: ExerciceComptable[]): Promise<void>;
  exercicesConnus(): Promise<ExerciceComptable[]>;
  enregistrerComptes(comptes: CompteSource[]): Promise<number>;
  moisDejaRempli(mois: string): Promise<boolean>;
  // Une transaction : tout le mois, ou rien. Renvoie le nombre de numéros illisibles écartés.
  remplacerMois(mois: string, soldes: SoldeSource[], idExecution: string): Promise<number>;
}

export interface DemandeSynchro {
  declencheur: Declencheur;
  // Exceptionnel seulement : l'exercice désigné, même clôturé.
  idExercice?: string;
  aujourdhui: string;
  // Sous le plafond de l'API, avant chaque lecture de mois. Les 429 restent gérés par le client HTTP.
  reserver?: () => Promise<void>;
}

const centimes = (montant: number) => Math.round(montant * 100);

/** Une balance reçue n'est retenue que si elle est complète et équilibrée. */
export function controlerBalance(lecture: LectureBalance): "troncature" | "desequilibre" | null {
  if (!lecture.complete) return "troncature";
  const debit = lecture.soldes.reduce((t, s) => t + centimes(s.debit), 0);
  const credit = lecture.soldes.reduce((t, s) => t + centimes(s.credit), 0);
  return debit === credit ? null : "desequilibre";
}

function raisonDeLErreur(erreur: unknown): string {
  const reason = (erreur as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" ? reason : "inconnu";
}

// Inutile de continuer : les mois suivants échoueraient de la même façon.
const ERREURS_BLOQUANTES = new Set(["invalid_token", "insufficient_scope", "rate_limited"]);

export type ResultatSynchro = { lancee: false; raison: "deja_en_cours" | "exercice_inconnu" } | { lancee: true; idExecution: string; bilan: BilanSynchro };

export async function synchroniserSociete(source: SourceComptable, depot: DepotSynchro, demande: DemandeSynchro): Promise<ResultatSynchro> {
  const { declencheur, aujourdhui } = demande;
  const reserver = demande.reserver ?? (async () => undefined);
  const idExecution = await depot.commencer(declencheur);
  if (idExecution === null) return { lancee: false, raison: "deja_en_cours" };

  const bilan: BilanSynchro = { statut: "success", moisDemandes: 0, moisActualises: 0, moisEnEchec: [], nouveauxComptes: 0, comptesIllisibles: 0, limites: [], codeErreur: null };

  try {
    // Exercices : ceux de Pennylane si possible, sinon les derniers connus. Sans aucun, le périmètre se limite
    // aux deux mois récents, et le bilan le dit : on ne suppose rien.
    let exercices: ExerciceComptable[] | null = null;
    try {
      await reserver();
      exercices = await source.lireExercices();
      await depot.enregistrerExercices(exercices);
    } catch (erreur) {
      bilan.limites.push(LIMITE_EXERCICES_INDISPONIBLES);
      if (ERREURS_BLOQUANTES.has(raisonDeLErreur(erreur)) && raisonDeLErreur(erreur) !== "insufficient_scope") throw erreur;
      const connus = await depot.exercicesConnus();
      exercices = connus.length > 0 ? connus : null;
    }

    let mois: string[];
    if (declencheur === "exceptionnel") {
      const exercice = exercices?.find((e) => e.idSource === demande.idExercice);
      if (!exercice) {
        await depot.terminer(idExecution, { ...bilan, statut: "error", codeErreur: "exercice_inconnu" });
        return { lancee: false, raison: "exercice_inconnu" };
      }
      mois = perimetreExceptionnel(exercice, aujourdhui).mois;
    } else {
      const perimetre = perimetreSynchro(declencheur, exercices, aujourdhui);
      mois = perimetre.mois;
      for (const limite of perimetre.limites) if (!bilan.limites.includes(limite)) bilan.limites.push(limite);
    }
    bilan.moisDemandes = mois.length;

    // Le plan de comptes sert aux libellés et à signaler les nouveaux comptes. Une lecture quotidienne ne le
    // relit pas ; son échec n'empêche pas de lire la balance, qui porte numéros et libellés.
    if (declencheur !== "quotidien") {
      try {
        await reserver();
        bilan.nouveauxComptes = await depot.enregistrerComptes(await source.lireComptes());
      } catch (erreur) {
        if (raisonDeLErreur(erreur) === "invalid_token" || raisonDeLErreur(erreur) === "rate_limited") throw erreur;
        bilan.limites.push("plan_de_comptes_indisponible");
      }
    }

    let arret = false;
    for (const unMois of mois) {
      if (arret) {
        bilan.moisEnEchec.push({ mois: unMois, raison: "non_lu" });
        continue;
      }
      let lecture: LectureBalance;
      try {
        await reserver();
        lecture = await source.lireBalanceDuMois(unMois);
      } catch (erreur) {
        const raison = raisonDeLErreur(erreur);
        bilan.moisEnEchec.push({ mois: unMois, raison: (erreur as Error)?.name === "FormatComptableInattendu" ? "format" : "lecture" });
        bilan.codeErreur = raison;
        if (ERREURS_BLOQUANTES.has(raison)) arret = true;
        continue;
      }
      const controle = controlerBalance(lecture);
      if (controle) {
        bilan.moisEnEchec.push({ mois: unMois, raison: controle });
        continue;
      }
      // Un mois qui avait des comptes et n'en a soudain plus aucun ressemble davantage à une réponse anormale
      // qu'à une comptabilité vidée : les données sont gardées, et le bilan le signale.
      if (lecture.soldes.length === 0 && (await depot.moisDejaRempli(unMois))) {
        bilan.moisEnEchec.push({ mois: unMois, raison: "balance_vide_suspecte" });
        continue;
      }
      try {
        bilan.comptesIllisibles += await depot.remplacerMois(unMois, lecture.soldes, idExecution);
        bilan.moisActualises += 1;
      } catch {
        bilan.moisEnEchec.push({ mois: unMois, raison: "ecriture" });
      }
    }

    if (bilan.moisDemandes > 0 && bilan.moisActualises === 0) bilan.statut = "error";
    else if (bilan.moisEnEchec.length > 0 || bilan.limites.includes(LIMITE_EXERCICES_INDISPONIBLES) || bilan.comptesIllisibles > 0) bilan.statut = "partial";
  } catch (erreur) {
    bilan.statut = "error";
    bilan.codeErreur = raisonDeLErreur(erreur);
  }

  await depot.terminer(idExecution, bilan);
  return { lancee: true, idExecution, bilan };
}
