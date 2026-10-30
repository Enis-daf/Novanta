import { SourceStock } from "./comptaPnl";
import type { ResultatImportFec } from "./comptaRepository";
import type { VueComptable } from "./comptaVue";
import type { SaisieAjustement } from "./comptaStocks";
import type { ImportFecPrepare } from "./fecParseur";
import type { BilanSynchro } from "./comptaSynchro";
import { Periode } from "./pastTransactions";

/** Appels du navigateur aux routes du P&L comptable : le navigateur ne lit jamais les tables comptables. */

export type ReponseCompta = VueComptable & { synchroDisponible: boolean };

export type ActionCompta =
  | { action: "enregistrer_regle"; prefixe: string; destination: string; categorie: string }
  | { action: "supprimer_regle"; prefixe: string }
  | { action: "appliquer_modele" }
  | { action: "source_stock"; debut: string; fin: string; source: SourceStock | null; element?: "inventory" | "depreciation" }
  | { action: "source_periode"; debut: string; fin: string; source: "fec" | "pennylane" }
  | { action: "retirer_import"; id: string }
  | { action: "ajouter_ajustements"; ajustements: SaisieAjustement[] }
  | { action: "retirer_ajustement"; id: string };

async function lireReponse<T>(reponse: Response, messageParDefaut: string): Promise<T> {
  const corps = await reponse.json().catch(() => ({}));
  if (!reponse.ok) throw new Error(corps.error || messageParDefaut);
  return corps as T;
}

export async function chargerCompta(accessToken: string, periode: Periode): Promise<ReponseCompta> {
  const parametres = new URLSearchParams({ debut: periode.debut, fin: periode.fin });
  const reponse = await fetch(`/api/passe/compta?${parametres.toString()}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  return lireReponse<ReponseCompta>(reponse, "Le P&L comptable n'a pas pu être chargé.");
}

export async function modifierCompta(accessToken: string, action: ActionCompta): Promise<void> {
  const reponse = await fetch("/api/passe/compta", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  await lireReponse(reponse, "La modification n'a pas pu être enregistrée.");
}

export async function envoyerImportFec(accessToken: string, preparation: ImportFecPrepare, remplacer: boolean): Promise<ResultatImportFec> {
  const reponse = await fetch("/api/passe/compta/fec", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ import: preparation, remplacer }),
  });
  return lireReponse<ResultatImportFec>(reponse, "L'import n'a pas pu être enregistré.");
}

export type DemandeSynchroCompta = { type: "manuel" } | { type: "exceptionnel"; idExercice: string; confirmation: true };

export async function synchroniserCompta(accessToken: string, demande: DemandeSynchroCompta): Promise<BilanSynchro> {
  const reponse = await fetch("/api/passe/compta/sync", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(demande),
  });
  return (await lireReponse<{ bilan: BilanSynchro }>(reponse, "La synchronisation comptable a échoué.")).bilan;
}
