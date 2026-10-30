import type { SupabaseClient } from "@supabase/supabase-js";
import { RegleCorrespondance } from "./comptaCorrespondance";
import { ExerciceComptable, lectureProvisoire, LectureProvisoire, perimetresStock } from "./comptaExercices";
import { calculerPnlComptable, periodeEnMoisEntiers, PnlComptable, SoldeCompte, soldesDeLaPeriode } from "./comptaPnl";
import {
  chargerAjustementsComptables,
  chargerChoixStock,
  chargerComptes,
  chargerDernieresSynchros,
  chargerExercices,
  chargerPremierMoisDeBalance,
  chargerRegles,
  chargerSoldes,
  CompteConnu,
  ExecutionSynchro,
} from "./comptaRepository";
import { AjustementComptable, arbitrageParMois, DecisionStockExercice, deciderStockParExercice, trierAjustements } from "./comptaStocks";
import { ajustementsDeLaPeriode, ajustementsDepuisStocks, AjustementGestion } from "./pastAdjustments";
import { Periode } from "./pastTransactions";
import { chargerStocks } from "./pastTransactionsRepository";

/**
 * Vue du P&L comptable d'une période, côté serveur : assemble balance, stocks et arbitrages. Les décisions de
 * stock se prennent sur l'exercice entier, même pour un mois affiché : une écriture annuelle de décembre doit
 * se voir depuis janvier.
 */
export interface VueComptable {
  pnl: PnlComptable;
  regles: RegleCorrespondance[];
  comptes: CompteConnu[];
  soldes: SoldeCompte[];
  moisEntiers: Periode;
  exercices: ExerciceComptable[];
  provisoire: LectureProvisoire;
  decisionsStock: DecisionStockExercice[];
  // Décision par mois, à appliquer tel quel par Action. Sérialisable.
  arbitrageStock: Record<string, "pennylane" | "novanta" | "aucune">;
  variationsStock: AjustementGestion[];
  ajustements: AjustementComptable[];
  ajustementsEcartes: AjustementComptable[];
  derniereSynchro: ExecutionSynchro | null;
  derniereSynchroReussie: ExecutionSynchro | null;
  premiereEcriture: string | null;
}

export async function chargerVueComptable(admin: SupabaseClient, organizationId: string, periode: Periode): Promise<VueComptable> {
  const moisEntiers = periodeEnMoisEntiers(periode);
  const [exercices, regles, comptes, stocks, choix, ajustementsSaisis, synchros, premiereEcriture] = await Promise.all([
    chargerExercices(admin, organizationId),
    chargerRegles(admin, organizationId),
    chargerComptes(admin, organizationId),
    chargerStocks(admin, organizationId),
    chargerChoixStock(admin, organizationId),
    chargerAjustementsComptables(admin, organizationId),
    chargerDernieresSynchros(admin, organizationId),
    chargerPremierMoisDeBalance(admin, organizationId),
  ]);
  const perimetres = perimetresStock(moisEntiers, exercices);
  const large: Periode = {
    debut: perimetres.reduce((min, p) => (p.debut < min ? p.debut : min), moisEntiers.debut),
    fin: perimetres.reduce((max, p) => (p.fin > max ? p.fin : max), moisEntiers.fin),
  };
  const soldesLarges = await chargerSoldes(admin, organizationId, large);
  const variationsStock = ajustementsDepuisStocks(stocks);
  const decisionsStock = deciderStockParExercice({ perimetres, soldes: soldesLarges, regles, variationsNovanta: variationsStock, choix });
  const parMois = arbitrageParMois(decisionsStock);
  const { appliques, ecartes } = trierAjustements({ ajustements: ajustementsSaisis, perimetres, soldes: soldesLarges, regles });
  const dansLaPeriode = (a: AjustementComptable) => a.date >= moisEntiers.debut && a.date <= moisEntiers.fin;
  const soldes = soldesDeLaPeriode(soldesLarges, moisEntiers);
  const pnl = calculerPnlComptable({
    soldes,
    regles,
    libellesComptes: new Map(comptes.map((c) => [c.numero, c.libelle])),
    variationsStockNovanta: ajustementsDeLaPeriode(variationsStock, moisEntiers),
    arbitrageStockParMois: parMois,
    conflitStock: decisionsStock.some((d) => d.conflit),
    ajustements: appliques.filter(dansLaPeriode),
  });
  return {
    pnl,
    regles,
    comptes,
    soldes,
    moisEntiers,
    exercices,
    provisoire: lectureProvisoire(moisEntiers, exercices),
    decisionsStock,
    arbitrageStock: Object.fromEntries(parMois),
    variationsStock,
    ajustements: appliques,
    ajustementsEcartes: ecartes.filter(dansLaPeriode),
    derniereSynchro: synchros.derniere,
    derniereSynchroReussie: synchros.derniereReussie,
    premiereEcriture: premiereEcriture,
  };
}
