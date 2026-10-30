
/**
 * Couche d'adaptation : le reste de Novanta lit ces types, jamais une réponse Pennylane brute. La
 * source réelle (lib/comptaPennylaneAdapter.ts) reste désactivée tant que Pennylane n'a pas confirmé
 * droits et comportements ; les tests et la démonstration utilisent des données simulées. Le P&L lit la
 * balance mensuelle, pas les lignes d'écriture : voir docs/pnl-comptable-pennylane.md.
 */

export interface CompteSource {
  idSource: string;
  numero: string;
  libelle: string;
  type: string | null;
  actif: boolean;
}

export interface SoldeSource {
  compte: string;
  libelle: string | null;
  debit: number;
  credit: number;
}

export interface LectureBalance {
  soldes: SoldeSource[];
  // false : la borne de pagination a été atteinte. Jamais présenté comme complet.
  complete: boolean;
}

export interface SourceComptable {
  readonly nom: "pennylane" | "fixtures";
  lireComptes(): Promise<CompteSource[]>;
  // Balance d'un mois entier (YYYY-MM), comptes auxiliaires compris.
  lireBalanceDuMois(mois: string): Promise<LectureBalance>;
}
