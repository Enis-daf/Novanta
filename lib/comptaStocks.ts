import { IndexRegles, indexerRegles, RegleCorrespondance, regleDuCompte, normaliserCompte, LigneComptable } from "./comptaCorrespondance";
import { moisEntre, PerimetreStock } from "./comptaExercices";
import { AjustementGestion, moisDe } from "./pastAdjustments";
import type { SoldeCompte, SourceStock } from "./comptaPnl";

/**
 * Variation de stocks du P&L comptable : une seule source par exercice — pur, sans effet de bord.
 *
 * La comparaison ne se fait pas mois par mois. En PME, la variation est souvent passée une fois par an : une
 * écriture de décembre peut couvrir les douze saisies mensuelles de Novanta. Il y a donc conflit dès que les
 * deux sources existent dans le même exercice, même sur des mois différents, et Novanta ne sait pas dire si
 * elles couvrent le même périmètre : c'est à l'utilisateur de trancher. Son choix vaut pour tout l'exercice
 * et reste enregistré. Les deux ne s'additionnent jamais.
 *
 * Tant que la comptabilité n'a pas d'écriture de stock, la saisie Novanta s'applique seule : c'est le cas
 * normal, en cours d'exercice.
 */

export interface ChoixStock {
  source: SourceStock | null;
  montantPennylane: number | null;
  montantNovanta: number | null;
  choisiLe: string;
}

export interface DecisionStockExercice {
  perimetre: PerimetreStock;
  source: SourceStock | "aucune";
  conflit: boolean;
  moisPennylane: string[];
  montantPennylane: number;
  moisNovanta: string[];
  montantNovanta: number;
  choix: ChoixStock | null;
  // Une source a changé depuis l'arbitrage : signalé, sans redemander ni changer la source retenue.
  sourceModifieeDepuisChoix: boolean;
}

const centimes = (montant: number) => Math.round(montant * 100);

function estCompteDeStock(compte: string, index: IndexRegles): boolean {
  const numero = normaliserCompte(compte);
  return Boolean(numero) && regleDuCompte(numero, index)?.destination === "inventory_variation";
}

export function deciderStockParExercice(options: {
  perimetres: PerimetreStock[];
  soldes: SoldeCompte[];
  regles: RegleCorrespondance[];
  variationsNovanta: AjustementGestion[];
  choix: ReadonlyMap<string, ChoixStock>;
}): DecisionStockExercice[] {
  const index = indexerRegles(options.regles);
  const soldesStock = options.soldes.filter((s) => estCompteDeStock(s.compte, index) && (s.debit !== 0 || s.credit !== 0));
  return options.perimetres.map((perimetre) => {
    const debut = perimetre.debut.slice(0, 7);
    const fin = perimetre.fin.slice(0, 7);
    const dansPerimetre = (mois: string) => mois >= debut && mois <= fin;
    const pennylane = soldesStock.filter((s) => dansPerimetre(s.mois));
    const novanta = options.variationsNovanta.filter((a) => dansPerimetre(moisDe(a.date)));
    const montantPennylane = pennylane.reduce((t, s) => t + centimes(s.credit) - centimes(s.debit), 0) / 100;
    const montantNovanta = novanta.reduce((t, a) => t + centimes(a.montant), 0) / 100;
    const choix = options.choix.get(perimetre.cle) ?? null;
    const lesDeux = pennylane.length > 0 && novanta.length > 0;
    const arbitre = choix?.source ?? null;

    let source: SourceStock | "aucune" = "aucune";
    if (lesDeux) source = arbitre ?? "pennylane";
    else if (pennylane.length > 0) source = "pennylane";
    else if (novanta.length > 0) source = "novanta";

    const conflit = lesDeux && arbitre === null;
    // Un montant inconnu au moment du choix ne prouve aucun changement : rien à signaler.
    const aChange = (auChoix: number | null, actuel: number) => auChoix !== null && centimes(auChoix) !== centimes(actuel);
    const sourceModifieeDepuisChoix = lesDeux && arbitre !== null && choix !== null && (aChange(choix.montantPennylane, montantPennylane) || aChange(choix.montantNovanta, montantNovanta));

    return {
      perimetre,
      source,
      conflit,
      moisPennylane: [...new Set(pennylane.map((s) => s.mois))].sort(),
      montantPennylane,
      moisNovanta: [...new Set(novanta.map((a) => moisDe(a.date)))].sort(),
      montantNovanta,
      choix,
      sourceModifieeDepuisChoix,
    };
  });
}

/** Source retenue pour chaque mois, à passer au moteur : un mois ne relève jamais des deux sources. */
export function arbitrageParMois(decisions: DecisionStockExercice[]): Map<string, SourceStock | "aucune"> {
  const parMois = new Map<string, SourceStock | "aucune">();
  for (const decision of decisions) {
    for (const mois of moisEntre(decision.perimetre.debut, decision.perimetre.fin)) parMois.set(mois, decision.source);
  }
  return parMois;
}

export interface AjustementComptable {
  id: string;
  date: string;
  ligne: Exclude<LigneComptable, "inventory_variation">;
  libelle: string;
  montant: number;
  notes: string | null;
}

/**
 * Règle explicite pour un ajustement de gestion du P&L comptable (amortissement mensuel, par exemple) : dès
 * que la comptabilité porte des écritures sur la même ligne dans le même exercice, l'ajustement de cet
 * exercice est écarté et signalé. La comptabilité l'emporte, et rien n'est compté deux fois.
 */
export function trierAjustements(options: {
  ajustements: AjustementComptable[];
  perimetres: PerimetreStock[];
  soldes: SoldeCompte[];
  regles: RegleCorrespondance[];
}): { appliques: AjustementComptable[]; ecartes: AjustementComptable[] } {
  const index = indexerRegles(options.regles);
  const ligneDe = (compte: string) => {
    const numero = normaliserCompte(compte);
    return numero ? (regleDuCompte(numero, index)?.destination ?? null) : null;
  };
  const appliques: AjustementComptable[] = [];
  const ecartes: AjustementComptable[] = [];
  for (const ajustement of options.ajustements) {
    const mois = ajustement.date.slice(0, 7);
    const perimetre = options.perimetres.find((p) => mois >= p.debut.slice(0, 7) && mois <= p.fin.slice(0, 7));
    const couvert =
      perimetre !== undefined &&
      options.soldes.some((s) => s.mois >= perimetre.debut.slice(0, 7) && s.mois <= perimetre.fin.slice(0, 7) && (s.debit !== 0 || s.credit !== 0) && ligneDe(s.compte) === ajustement.ligne);
    (couvert ? ecartes : appliques).push(ajustement);
  }
  return { appliques, ecartes };
}
