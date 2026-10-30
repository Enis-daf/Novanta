import { RegleCorrespondance } from "./comptaCorrespondance";
import { ExerciceComptable, lectureProvisoire, LectureProvisoire, moisEntre, perimetresStock } from "./comptaExercices";
import { calculerPnlComptable, periodeEnMoisEntiers, PnlComptable, SoldeCompte, soldesDeLaPeriode } from "./comptaPnl";
import type { CompteConnu, ExecutionSynchro } from "./comptaRepository";
import { ChoixSource, ConflitSource, ImportFec, regrouperConflits, resoudreSources, SoldeProvenance, SourceBalance } from "./comptaSources";
import { AjustementComptable, arbitrageParMois, ChoixStock, DecisionAmortissement, deciderAmortissements, DecisionStockExercice, deciderStockParExercice, trierAjustements } from "./comptaStocks";
import { ajustementsDeLaPeriode, ajustementsDepuisStocks, AjustementGestion, StockFinDeMois } from "./pastAdjustments";
import { Periode } from "./pastTransactions";

/**
 * Vue du P&L comptable d'une période, côté serveur : assemble balance, sources, stocks et arbitrages. Un seul
 * moteur, quelle que soit l'origine des soldes. Les décisions se prennent sur l'exercice entier, même pour un mois
 * affiché : une écriture annuelle de décembre doit se voir depuis janvier.
 */
export interface VueComptable {
  pnl: PnlComptable;
  regles: RegleCorrespondance[];
  comptes: CompteConnu[];
  soldes: SoldeCompte[];
  moisEntiers: Periode;
  exercices: ExerciceComptable[];
  provisoire: LectureProvisoire;
  imports: ImportFec[];
  sourceParMois: Record<string, SourceBalance>;
  conflitsSource: ConflitSource[];
  decisionsStock: DecisionStockExercice[];
  decisionsAmortissement: DecisionAmortissement[];
  // Décision par mois, à appliquer tel quel par Action. Sérialisable.
  arbitrageStock: Record<string, "pennylane" | "novanta" | "aucune">;
  lignesEcarteesParMois: Record<string, string[]>;
  variationsStock: AjustementGestion[];
  ajustements: AjustementComptable[];
  ajustementsEcartes: AjustementComptable[];
  ajustementsAVerifier: AjustementComptable[];
  derniereSynchro: ExecutionSynchro | null;
  derniereSynchroReussie: ExecutionSynchro | null;
  premiereEcriture: string | null;
}

/**
 * Exercices lus : ceux de Pennylane, et ceux des FEC actifs. Un FEC n'est dit clôturé que si l'utilisateur l'a
 * déclaré. Si les deux décrivent un même exercice, celui de la source retenue fait foi. Cette liste sert à la lecture
 * et aux arbitrages, jamais au périmètre de la synchronisation Pennylane.
 */
export function exercicesDeLecture(pennylane: ExerciceComptable[], imports: ImportFec[], sourceParMois: ReadonlyMap<string, SourceBalance>): ExerciceComptable[] {
  const parDebut = new Map(pennylane.map((e) => [e.debut, e]));
  for (const i of imports) {
    if (i.statut !== "active") continue;
    const duFec: ExerciceComptable = { idSource: `fec:${i.id}`, debut: i.debut, fin: i.fin, statut: i.cloture ? "closed" : "open" };
    const connu = parDebut.get(i.debut);
    if (!connu || moisEntre(i.debut, i.fin).some((m) => sourceParMois.get(m) === "fec")) parDebut.set(i.debut, duFec);
  }
  return [...parDebut.values()].sort((a, b) => a.debut.localeCompare(b.debut));
}

export interface DonneesVueComptable {
  exercicesPennylane: ExerciceComptable[];
  imports: ImportFec[];
  choixSources: ChoixSource[];
  regles: RegleCorrespondance[];
  comptes: CompteConnu[];
  stocks: StockFinDeMois[];
  choixStock: ReadonlyMap<string, ChoixStock>;
  choixAmortissement: ReadonlyMap<string, ChoixStock>;
  ajustementsSaisis: AjustementComptable[];
  synchros: { derniere: ExecutionSynchro | null; derniereReussie: ExecutionSynchro | null };
  premiereEcriture: string | null;
}

/** Bornes à lire pour une période : les exercices entiers qu'elle recoupe. */
export function periodeALire(periode: Periode, exercicesPennylane: ExerciceComptable[], imports: ImportFec[]): Periode {
  const moisEntiers = periodeEnMoisEntiers(periode);
  const perimetres = perimetresStock(moisEntiers, exercicesDeLecture(exercicesPennylane, imports, new Map()));
  return {
    debut: perimetres.reduce((min, p) => (p.debut < min ? p.debut : min), moisEntiers.debut),
    fin: perimetres.reduce((max, p) => (p.fin > max ? p.fin : max), moisEntiers.fin),
  };
}

/** Assemblage pur : le même, avec les données de la base ou celles de la démonstration. */
export function assemblerVueComptable(d: DonneesVueComptable, lus: SoldeProvenance[], periode: Periode): VueComptable {
  const moisEntiers = periodeEnMoisEntiers(periode);
  const resolution = resoudreSources(lus, d.choixSources);
  const exercices = exercicesDeLecture(d.exercicesPennylane, d.imports, resolution.sourceParMois);
  const perimetres = perimetresStock(moisEntiers, exercices);

  const variationsStock = ajustementsDepuisStocks(d.stocks);
  const decisionsStock = deciderStockParExercice({ perimetres, soldes: resolution.soldes, regles: d.regles, variationsNovanta: variationsStock, choix: d.choixStock });
  const parMois = arbitrageParMois(decisionsStock);
  const decisionsAmortissement = deciderAmortissements({ perimetres, soldes: resolution.soldes, regles: d.regles, ajustements: d.ajustementsSaisis, choix: d.choixAmortissement });
  const periodesCloturees = exercices.filter((e) => e.statut === "closed").map((e) => ({ debut: e.debut, fin: e.fin }));
  const tri = trierAjustements({ ajustements: d.ajustementsSaisis, decisionsAmortissement, periodesCloturees });
  const dansLaPeriode = (a: AjustementComptable) => a.date >= moisEntiers.debut && a.date <= moisEntiers.fin;

  const soldes = soldesDeLaPeriode(resolution.soldes, moisEntiers);
  const moisDeLaPeriode = new Set(moisEntre(moisEntiers.debut, moisEntiers.fin));
  const conflitsSource = regrouperConflits(resolution.moisEnConflit.filter((m) => moisDeLaPeriode.has(m)), d.imports);
  const pnl = calculerPnlComptable({
    soldes,
    regles: d.regles,
    libellesComptes: new Map(d.comptes.map((c) => [c.numero, c.libelle])),
    variationsStockNovanta: ajustementsDeLaPeriode(variationsStock, moisEntiers),
    arbitrageStockParMois: parMois,
    conflitStock: decisionsStock.some((x) => x.conflit),
    ajustements: tri.appliques.filter(dansLaPeriode),
    lignesEcarteesParMois: tri.lignesEcarteesParMois,
  });
  // Un mois sans source tranchée sort du calcul : le résultat ne se présente pas comme complet.
  if (conflitsSource.length > 0) pnl.complet = false;

  return {
    pnl,
    regles: d.regles,
    comptes: d.comptes,
    soldes,
    moisEntiers,
    exercices,
    provisoire: lectureProvisoire(moisEntiers, exercices),
    imports: d.imports,
    sourceParMois: Object.fromEntries([...resolution.sourceParMois].filter(([m]) => moisDeLaPeriode.has(m))),
    conflitsSource,
    decisionsStock,
    decisionsAmortissement,
    arbitrageStock: Object.fromEntries(parMois),
    lignesEcarteesParMois: Object.fromEntries([...tri.lignesEcarteesParMois].map(([m, l]) => [m, [...l]])),
    variationsStock,
    ajustements: tri.appliques,
    ajustementsEcartes: tri.ecartes.filter(dansLaPeriode),
    ajustementsAVerifier: tri.aVerifier.filter(dansLaPeriode),
    derniereSynchro: d.synchros.derniere,
    derniereSynchroReussie: d.synchros.derniereReussie,
    premiereEcriture: d.premiereEcriture,
  };
}
