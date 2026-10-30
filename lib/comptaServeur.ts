import type { SupabaseClient } from "@supabase/supabase-js";
import {
  chargerAjustementsComptables,
  chargerChoixSources,
  chargerChoixStock,
  chargerComptes,
  chargerDernieresSynchros,
  chargerExercices,
  chargerImportsFec,
  chargerPremierMoisDeBalance,
  chargerRegles,
  chargerSoldes,
} from "./comptaRepository";
import { assemblerVueComptable, periodeALire, VueComptable } from "./comptaVue";
import { Periode } from "./pastTransactions";
import { chargerStocks } from "./pastTransactionsRepository";

export type { VueComptable } from "./comptaVue";

/** Charge les données d'une société, toujours bornées à elle, puis assemble la vue (lib/comptaVue.ts). */
export async function chargerVueComptable(admin: SupabaseClient, organizationId: string, periode: Periode): Promise<VueComptable> {
  const [exercicesPennylane, imports, choixSources, regles, comptes, stocks, choixStock, choixAmortissement, ajustementsSaisis, synchros, premiereEcriture] = await Promise.all([
    chargerExercices(admin, organizationId),
    chargerImportsFec(admin, organizationId),
    chargerChoixSources(admin, organizationId),
    chargerRegles(admin, organizationId),
    chargerComptes(admin, organizationId),
    chargerStocks(admin, organizationId),
    chargerChoixStock(admin, organizationId, "inventory"),
    chargerChoixStock(admin, organizationId, "depreciation"),
    chargerAjustementsComptables(admin, organizationId),
    chargerDernieresSynchros(admin, organizationId),
    chargerPremierMoisDeBalance(admin, organizationId),
  ]);
  const lus = await chargerSoldes(admin, organizationId, periodeALire(periode, exercicesPennylane, imports));
  return assemblerVueComptable({ exercicesPennylane, imports, choixSources, regles, comptes, stocks, choixStock, choixAmortissement, ajustementsSaisis, synchros, premiereEcriture }, lus, periode);
}
