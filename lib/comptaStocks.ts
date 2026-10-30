import { IndexRegles, indexerRegles, LigneComptable, normaliserCompte, RegleCorrespondance, regleDuCompte } from "./comptaCorrespondance";
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

export const NATURES_AJUSTEMENT = [
  { cle: "amortissement", libelle: "Dotation estimée" },
  { cle: "charge_a_rattacher", libelle: "Charge à rattacher" },
  { cle: "produit_a_rattacher", libelle: "Produit à rattacher" },
  { cle: "charge_payee_d_avance", libelle: "Charge payée d'avance" },
  { cle: "revenu_facture_d_avance", libelle: "Revenu facturé d'avance" },
  { cle: "autre", libelle: "Autre régularisation" },
] as const;

export type NatureAjustement = (typeof NATURES_AJUSTEMENT)[number]["cle"];

export function estNatureAjustement(valeur: unknown): valeur is NatureAjustement {
  return NATURES_AJUSTEMENT.some((n) => n.cle === valeur);
}

export function libelleNature(nature: NatureAjustement): string {
  return NATURES_AJUSTEMENT.find((n) => n.cle === nature)!.libelle;
}

export interface AjustementComptable {
  id: string;
  date: string;
  ligne: Exclude<LigneComptable, "inventory_variation">;
  libelle: string;
  montant: number;
  notes: string | null;
  nature: NatureAjustement;
  // Période réellement couverte, si elle diffère du mois de l'ajustement.
  couvreDu?: string | null;
  couvreAu?: string | null;
}

export interface DecisionAmortissement {
  perimetre: PerimetreStock;
  source: SourceStock | "aucune";
  conflit: boolean;
  moisComptables: string[];
  montantComptable: number;
  moisAjustements: string[];
  montantAjustements: number;
  choix: ChoixStock | null;
  sourceModifieeDepuisChoix: boolean;
}

/**
 * Dotations : même règle que les stocks, par exercice. Une dotation annuelle de décembre et des dotations
 * mensuelles estimées couvrent le même périmètre probable : conflit, décision de l'utilisateur, une seule source.
 * La valeur « pennylane » désigne ici la comptabilité, qu'elle vienne de l'API ou d'un FEC.
 */
export function deciderAmortissements(options: {
  perimetres: PerimetreStock[];
  soldes: SoldeCompte[];
  regles: RegleCorrespondance[];
  ajustements: AjustementComptable[];
  choix: ReadonlyMap<string, ChoixStock>;
}): DecisionAmortissement[] {
  const index = indexerRegles(options.regles);
  const comptables = options.soldes.filter((s) => {
    const numero = normaliserCompte(s.compte);
    return numero && regleDuCompte(numero, index)?.destination === "depreciation" && (s.debit !== 0 || s.credit !== 0);
  });
  const estimes = options.ajustements.filter((a) => a.nature === "amortissement");
  return options.perimetres.map((perimetre) => {
    const debut = perimetre.debut.slice(0, 7);
    const fin = perimetre.fin.slice(0, 7);
    const dans = (mois: string) => mois >= debut && mois <= fin;
    const lignes = comptables.filter((s) => dans(s.mois));
    const saisies = estimes.filter((a) => dans(a.date.slice(0, 7)));
    const montantComptable = lignes.reduce((t, s) => t + centimes(s.credit) - centimes(s.debit), 0) / 100;
    const montantAjustements = saisies.reduce((t, a) => t + centimes(a.montant), 0) / 100;
    const choix = options.choix.get(perimetre.cle) ?? null;
    const lesDeux = lignes.length > 0 && saisies.length > 0;
    const arbitre = choix?.source ?? null;
    let source: SourceStock | "aucune" = "aucune";
    if (lesDeux) source = arbitre ?? "pennylane";
    else if (lignes.length > 0) source = "pennylane";
    else if (saisies.length > 0) source = "novanta";
    const aChange = (auChoix: number | null, actuel: number) => auChoix !== null && centimes(auChoix) !== centimes(actuel);
    return {
      perimetre,
      source,
      conflit: lesDeux && arbitre === null,
      moisComptables: [...new Set(lignes.map((s) => s.mois))].sort(),
      montantComptable,
      moisAjustements: [...new Set(saisies.map((a) => a.date.slice(0, 7)))].sort(),
      montantAjustements,
      choix,
      sourceModifieeDepuisChoix: lesDeux && arbitre !== null && choix !== null && (aChange(choix.montantPennylane, montantComptable) || aChange(choix.montantNovanta, montantAjustements)),
    };
  });
}

export interface TriAjustements {
  appliques: AjustementComptable[];
  ecartes: AjustementComptable[];
  // Période déjà clôturée : la comptabilité a peut-être déjà pris en compte cet élément. Rien ne permet de
  // l'affirmer à partir d'un numéro de compte : il reste appliqué, et c'est signalé pour décision.
  aVerifier: AjustementComptable[];
  // Mois où la comptabilité cède la place aux dotations estimées, sur arbitrage.
  lignesEcarteesParMois: Map<string, Set<LigneComptable>>;
}

/**
 * Applique les arbitrages. Dotations : une source par exercice. Cut-offs et autres : appliqués tels que saisis,
 * car une écriture sur le même compte ne prouve pas qu'il s'agit du même élément.
 */
export function trierAjustements(options: {
  ajustements: AjustementComptable[];
  decisionsAmortissement: DecisionAmortissement[];
  periodesCloturees: { debut: string; fin: string }[];
}): TriAjustements {
  const appliques: AjustementComptable[] = [];
  const ecartes: AjustementComptable[] = [];
  const aVerifier: AjustementComptable[] = [];
  const lignesEcarteesParMois = new Map<string, Set<LigneComptable>>();

  for (const decision of options.decisionsAmortissement) {
    if (decision.source !== "novanta" || decision.moisComptables.length === 0) continue;
    for (const mois of decision.moisComptables) {
      const ensemble = lignesEcarteesParMois.get(mois) ?? new Set<LigneComptable>();
      ensemble.add("depreciation");
      lignesEcarteesParMois.set(mois, ensemble);
    }
  }
  for (const ajustement of options.ajustements) {
    const mois = ajustement.date.slice(0, 7);
    if (ajustement.nature === "amortissement") {
      const decision = options.decisionsAmortissement.find((d) => mois >= d.perimetre.debut.slice(0, 7) && mois <= d.perimetre.fin.slice(0, 7));
      (decision?.source === "pennylane" ? ecartes : appliques).push(ajustement);
      continue;
    }
    appliques.push(ajustement);
    const debut = ajustement.couvreDu ?? ajustement.date;
    const fin = ajustement.couvreAu ?? ajustement.date;
    if (options.periodesCloturees.some((p) => debut <= p.fin && fin >= p.debut)) aVerifier.push(ajustement);
  }
  return { appliques, ecartes, aVerifier, lignesEcarteesParMois };
}

export interface SaisieAjustement {
  date: string;
  ligne: string;
  libelle: string;
  montant: number;
  nature: string;
  notes?: string | null;
  couvreDu?: string | null;
  couvreAu?: string | null;
}

const LIGNES_AJUSTABLES = new Set(["revenue", "direct_costs", "other_variable_costs", "structure_costs", "depreciation", "financial", "other_items", "income_tax"]);

/** Erreur d'un ajustement saisi, ou null. Les stocks restent saisis dans leur module. */
export function erreurAjustement(a: SaisieAjustement): string | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof a.date !== "string" || !iso.test(a.date)) return "Date invalide.";
  if (!LIGNES_AJUSTABLES.has(a.ligne)) return "Ligne du P&L invalide : les stocks se saisissent dans leur écran.";
  if (typeof a.libelle !== "string" || a.libelle.trim() === "" || a.libelle.trim().length > 120) return "Nommez l'ajustement (120 caractères au plus).";
  if (typeof a.montant !== "number" || !Number.isFinite(a.montant) || a.montant === 0) return "Saisissez un montant.";
  if (!estNatureAjustement(a.nature)) return "Nature invalide.";
  if (a.nature === "amortissement" && a.ligne !== "depreciation") return "Une dotation estimée va sur la ligne Amortissements et dotations.";
  for (const d of [a.couvreDu, a.couvreAu]) if (d !== null && d !== undefined && !iso.test(d)) return "Période couverte invalide.";
  if (a.couvreDu && a.couvreAu && a.couvreDu > a.couvreAu) return "Période couverte invalide.";
  return null;
}
