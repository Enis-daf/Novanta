import { RegleCorrespondance } from "./comptaCorrespondance";
import { PnlComptable, SoldeCompte, SourceStock } from "./comptaPnl";
import type { CompteConnu, EtatSynchroComptable } from "./comptaRepository";
import { Periode } from "./pastTransactions";

/** Appels du navigateur aux routes du P&L comptable : le navigateur ne lit jamais les tables comptables. */

export interface ReponseCompta {
  pnl: PnlComptable;
  regles: RegleCorrespondance[];
  comptes: CompteConnu[];
  soldes: SoldeCompte[];
  sourceStock: SourceStock | null;
  synchro: EtatSynchroComptable | null;
  synchroDisponible: boolean;
  premiereEcriture: string | null;
  // La balance est mensuelle : la période réellement couverte, en mois entiers.
  moisEntiers: Periode;
}

export type ActionCompta =
  | { action: "enregistrer_regle"; prefixe: string; destination: string; categorie: string }
  | { action: "supprimer_regle"; prefixe: string }
  | { action: "appliquer_modele" }
  | { action: "source_stock"; source: SourceStock | null };

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

export interface ResultatSynchroMois {
  nombreComptes: number;
  nouveauxComptes: number;
  complete: boolean;
  illisibles: number;
}

export async function synchroniserCompta(accessToken: string, mois: string, avecComptes: boolean): Promise<ResultatSynchroMois> {
  const reponse = await fetch("/api/passe/compta/sync", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mois, avecComptes }),
  });
  return lireReponse(reponse, "La synchronisation comptable a échoué.");
}
