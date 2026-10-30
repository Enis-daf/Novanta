import { moisEntre } from "./comptaExercices";
import { SoldeCompte } from "./comptaPnl";

/**
 * Une seule source par mois — pur, sans effet de bord. FEC et API Pennylane alimentent la même balance
 * mensuelle ; un mois couvert par les deux n'est jamais additionné.
 *
 * Aucune source n'a de priorité par défaut : un FEC n'est pas forcément plus récent que l'API, et l'API pas
 * forcément plus fiable qu'un FEC clôturé. Sans décision, le mois reste en conflit et sort du calcul : le P&L le
 * dit, plutôt que de présenter un chiffre choisi au hasard.
 */

export type SourceBalance = "fec" | "pennylane" | "fixtures";

export interface SoldeProvenance extends SoldeCompte {
  source: SourceBalance;
}

export interface ChoixSource {
  debut: string;
  fin: string;
  source: "fec" | "pennylane";
  choisiLe: string;
}

export interface ImportFec {
  id: string;
  nomFichier: string;
  debut: string;
  fin: string;
  cloture: boolean;
  statut: "active" | "replaced" | "withdrawn";
  importeLe: string;
  resume: { lignes?: number; ecritures?: number; desequilibrees?: number; ecrituresDeSolde?: number; resultat?: number };
}

export interface ConflitSource {
  debut: string;
  fin: string;
  mois: string[];
  fichier: string | null;
}

export interface ResolutionSources {
  soldes: SoldeCompte[];
  sourceParMois: Map<string, SourceBalance>;
  moisEnConflit: string[];
}

/** Le dernier choix couvrant ce mois, s'il existe. */
function choixDuMois(choix: ChoixSource[], mois: string): ChoixSource | null {
  let retenu: ChoixSource | null = null;
  for (const c of choix) {
    if (mois < c.debut.slice(0, 7) || mois > c.fin.slice(0, 7)) continue;
    if (!retenu || c.choisiLe > retenu.choisiLe) retenu = c;
  }
  return retenu;
}

export function resoudreSources(soldes: SoldeProvenance[], choix: ChoixSource[]): ResolutionSources {
  const sourcesParMois = new Map<string, Set<SourceBalance>>();
  for (const s of soldes) {
    const ensemble = sourcesParMois.get(s.mois) ?? new Set<SourceBalance>();
    ensemble.add(s.source);
    sourcesParMois.set(s.mois, ensemble);
  }
  // Une source choisie mais vide sur toute sa période n'existe plus (import retiré) : le choix tombe.
  const choixValides = choix.filter((c) => moisEntre(c.debut, c.fin).some((m) => sourcesParMois.get(m)?.has(c.source)));

  const sourceParMois = new Map<string, SourceBalance>();
  const moisEnConflit: string[] = [];
  const mois = new Set([...sourcesParMois.keys(), ...choixValides.flatMap((c) => moisEntre(c.debut, c.fin))]);
  for (const m of mois) {
    const c = choixDuMois(choixValides, m);
    if (c) {
      // Un mois sans écriture dans la source retenue reste vide : l'autre source n'y entre pas.
      sourceParMois.set(m, c.source);
      continue;
    }
    const presentes = sourcesParMois.get(m);
    if (!presentes) continue;
    if (presentes.size === 1) sourceParMois.set(m, [...presentes][0]);
    else moisEnConflit.push(m);
  }
  return {
    soldes: soldes.filter((s) => sourceParMois.get(s.mois) === s.source).map(({ compte, mois: m, debit, credit, nombreLignes }) => ({ compte, mois: m, debit, credit, nombreLignes })),
    sourceParMois,
    moisEnConflit: moisEnConflit.sort(),
  };
}

/** Conflits regroupés par import : c'est sur la période de l'import que l'utilisateur tranche. */
export function regrouperConflits(moisEnConflit: string[], imports: ImportFec[]): ConflitSource[] {
  const restants = new Set(moisEnConflit);
  const conflits: ConflitSource[] = [];
  for (const i of imports.filter((x) => x.statut === "active").sort((a, b) => a.debut.localeCompare(b.debut))) {
    const mois = moisEntre(i.debut, i.fin).filter((m) => restants.has(m));
    if (mois.length === 0) continue;
    mois.forEach((m) => restants.delete(m));
    conflits.push({ debut: i.debut, fin: i.fin, mois, fichier: i.nomFichier });
  }
  for (const m of [...restants].sort()) {
    const dernierJour = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
    conflits.push({ debut: `${m}-01`, fin: dernierJour, mois: [m], fichier: null });
  }
  return conflits;
}
