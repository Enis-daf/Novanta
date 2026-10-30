import { LigneEcriture } from "./comptaPnl";
import { Periode } from "./pastTransactions";

/**
 * Couche d'adaptation : le reste de Novanta lit ces types, jamais une réponse Pennylane brute. La
 * source réelle (lib/comptaPennylaneAdapter.ts) reste désactivée tant que Pennylane n'a pas confirmé
 * droits et comportements ; les tests et la démonstration utilisent des données simulées.
 */

export interface CompteSource {
  idSource: string;
  numero: string;
  libelle: string;
  type: string | null;
  actif: boolean;
}

export interface LigneSource extends LigneEcriture {
  idSource: string;
  idEcriture: string | null;
  idJournal: string | null;
  libelle: string | null;
  statutSource: string | null;
  creeeLe: string | null;
  modifieeLe: string | null;
}

export interface LecturePeriode {
  lignes: LigneSource[];
  // false : la borne de pagination a été atteinte. Jamais présenté comme complet.
  complete: boolean;
}

export interface SourceComptable {
  readonly nom: "pennylane" | "fixtures";
  lireComptes(): Promise<CompteSource[]>;
  lirePeriode(periode: Periode): Promise<LecturePeriode>;
}
