import { formatDateCourte, parseDateISO, toISODate } from "./dates";
import { ConfigExercice, getCurrentFiscalQuarterRange, getFiscalYearRange } from "./fiscalPeriods";
import { finDeMois } from "./pastAdjustments";
import { CategorieAnalytique, FactureBfr } from "./pastBfr";
import { CoteDelai, FiltreCategorie, PeriodeDelai, TOUTES_CATEGORIES } from "./pastBfrDelais";
import { libelleMois } from "./pastDetail";
import { exercicesProposes, libelleExercice, moisProposes } from "./pastPdfPeriodes";
import { estEtagePnl, ETAGES_PNL, EtagePnl, identiteCategorie, libelleEtagePnl, MappingCategorie } from "./pastCategoryMapping";

/**
 * Filtres de l'ANALYSE des délais clients / fournisseurs (onglet BFR) — fonctions pures. L'écran
 * principal du BFR n'en a aucun : il lit toujours la cohorte mensuelle, toutes factures.
 *
 *  - Période : un mois civil, un trimestre ou l'exercice fiscal de l'organisation (trimestres de
 *    l'exercice, comme le reporting du module), ou deux dates. Une facture en fait partie par sa
 *    DATE D'ÉMISSION ; son délai court jusqu'à son règlement, même après la période.
 *  - Étage P&L : celui des TRANSACTIONS bancaires rapprochées de la facture, selon la correspondance
 *    P&L du module (catégorie de l'axe de référence -> étage) — voir etagesParTransaction et
 *    avecCategoriesDesTransactions. Le filtre réutilise le mécanisme générique de lib/pastBfrDelais.ts
 *    (FiltreCategorie), dont les valeurs sont ici des étages ; seuil de montant : même fichier.
 */

export type TypePeriodeAnalyse = "mois" | "trimestre" | "exercice" | "personnalise";

export type PeriodeAnalyse =
  | { type: "mois"; mois: string } // YYYY-MM
  | { type: "trimestre"; debut: string } // premier jour du trimestre de l'exercice
  | { type: "exercice"; debut: string } // premier jour de l'exercice
  | { type: "personnalise"; debut: string; fin: string };

export interface FiltresAnalyse {
  periode: PeriodeAnalyse;
  categorie: FiltreCategorie;
  seuilHt: number | null;
}

/** Ouverture depuis le BFR : le mois du BFR, toutes catégories, tous montants. */
export function filtresInitiaux(mois: string): FiltresAnalyse {
  return { periode: { type: "mois", mois }, categorie: TOUTES_CATEGORIES, seuilHt: null };
}

// Période personnalisée : au plus 5 ans, au-delà la saisie est refusée (jamais raccourcie en silence).
export const MAX_ANNEES_PERSONNALISE = 5;

export type PeriodeResolue = { ok: true; periode: PeriodeDelai; libelle: string } | { ok: false; erreur: string };

/** Date réelle au format YYYY-MM-DD : le 31/02 n'en est pas une (Date le décalerait au 3 mars). */
const dateReelle = (valeur: string) => /^\d{4}-\d{2}-\d{2}$/.test(valeur) && toISODate(parseDateISO(valeur)) === valeur;

const veille = (dateISO: string) => {
  const d = parseDateISO(dateISO);
  d.setDate(d.getDate() - 1);
  return toISODate(d);
};

/** « T3 2026 » (exercice civil), « T1 2026/2027 » sinon : le rang du trimestre DANS l'exercice. */
export function libelleTrimestre(trimestre: PeriodeDelai, config: ConfigExercice): string {
  const exercice = getFiscalYearRange(trimestre.debut, config);
  const d = parseDateISO(exercice.debut);
  const t = parseDateISO(trimestre.debut);
  const rang = Math.floor(((t.getFullYear() - d.getFullYear()) * 12 + t.getMonth() - d.getMonth()) / 3) + 1;
  const debut = exercice.debut.slice(0, 4);
  const fin = exercice.fin.slice(0, 4);
  return `T${rang} ${debut === fin ? debut : `${debut}/${fin}`}`;
}

export function resoudrePeriode(p: PeriodeAnalyse, config: ConfigExercice): PeriodeResolue {
  switch (p.type) {
    case "mois":
      return { ok: true, periode: { debut: `${p.mois}-01`, fin: finDeMois(p.mois) }, libelle: libelleMois(p.mois) };
    case "trimestre": {
      const periode = getCurrentFiscalQuarterRange(p.debut, config);
      return { ok: true, periode, libelle: libelleTrimestre(periode, config) };
    }
    case "exercice": {
      const periode = getFiscalYearRange(p.debut, config);
      return { ok: true, periode, libelle: libelleExercice(periode) };
    }
    case "personnalise": {
      if (!dateReelle(p.debut) || !dateReelle(p.fin)) return { ok: false, erreur: "Saisissez deux dates valides." };
      if (p.debut > p.fin) return { ok: false, erreur: "La date de début doit précéder la date de fin." };
      const limite = parseDateISO(p.debut);
      limite.setFullYear(limite.getFullYear() + MAX_ANNEES_PERSONNALISE);
      if (p.fin >= toISODate(limite)) return { ok: false, erreur: `Période limitée à ${MAX_ANNEES_PERSONNALISE} ans.` };
      return { ok: true, periode: { debut: p.debut, fin: p.fin }, libelle: `Du ${formatDateCourte(p.debut)} au ${formatDateCourte(p.fin)}` };
    }
  }
}

/** Nouvelle période d'un autre type, prise autour de la période actuelle (son début). */
export function periodeDuType(type: TypePeriodeAnalyse, actuelle: PeriodeDelai, config: ConfigExercice): PeriodeAnalyse {
  switch (type) {
    case "mois":
      return { type, mois: actuelle.debut.slice(0, 7) };
    case "trimestre":
      return { type, debut: getCurrentFiscalQuarterRange(actuelle.debut, config).debut };
    case "exercice":
      return { type, debut: getFiscalYearRange(actuelle.debut, config).debut };
    case "personnalise":
      return { type, debut: actuelle.debut, fin: actuelle.fin };
  }
}

export interface ChoixPeriode {
  valeur: string; // mois YYYY-MM, ou premier jour du trimestre / de l'exercice
  libelle: string;
}

/** Périodes proposées pour un type, de la plus récente à celle de la première facture émise. */
export function periodesProposees(type: "mois" | "trimestre" | "exercice", premiereEmission: string | null, aujourdhui: string, config: ConfigExercice): ChoixPeriode[] {
  if (type === "mois") return moisProposes(premiereEmission, aujourdhui).map((m) => ({ valeur: m, libelle: libelleMois(m) }));
  if (type === "exercice") return exercicesProposes(premiereEmission, aujourdhui, config).map((e) => ({ valeur: e.debut, libelle: libelleExercice(e) }));
  const borne = premiereEmission && premiereEmission < aujourdhui ? premiereEmission : aujourdhui;
  const trimestres: ChoixPeriode[] = [];
  for (let t = getCurrentFiscalQuarterRange(aujourdhui, config); trimestres.length < 200; t = getCurrentFiscalQuarterRange(veille(t.debut), config)) {
    trimestres.push({ valeur: t.debut, libelle: `${libelleTrimestre(t, config)} · ${formatDateCourte(t.debut)} → ${formatDateCourte(t.fin)}` });
    if (t.debut <= borne) break;
  }
  return trimestres;
}

/** Catégories des transactions Pennylane, par identifiant de transaction (absente : inconnue). */
export type CategoriesParTransaction = ReadonlyMap<string, CategorieAnalytique[]>;

/** Identifiants des transactions rapprochées des factures, chacun une fois. */
export function transactionsRapprochees(factures: FactureBfr[]): string[] {
  const ids = new Set<string>();
  for (const f of factures) for (const r of f.reglements ?? []) if (r.transactionId) ids.add(r.transactionId);
  return [...ids];
}

/**
 * Catégories d'une facture = l'UNION des catégories de ses transactions rapprochées connues de Passé
 * (chaque catégorie une fois). [] : transactions connues, aucune catégorisée — « Non catégorisé ».
 * null : rien ne permet de le dire — facture encore ouverte (aucune transaction), règlements datés
 * avant l'identifiant de transaction, ou transactions pas encore synchronisées dans Passé.
 * La facture reste une : son montant et son délai ne sont jamais répartis entre ses catégories.
 */
export function avecCategoriesDesTransactions(factures: FactureBfr[], parTransaction: CategoriesParTransaction): FactureBfr[] {
  return factures.map((f) => {
    const connues = (f.reglements ?? []).flatMap((r) => (r.transactionId && parTransaction.has(r.transactionId) ? [parTransaction.get(r.transactionId)!] : []));
    if (connues.length === 0) return { ...f, categories: null };
    const union = new Map<string, CategorieAnalytique>();
    for (const categories of connues) for (const c of categories) if (!union.has(c.id)) union.set(c.id, c);
    return { ...f, categories: [...union.values()] };
  });
}

/** Date d'émission la plus ancienne des factures d'un côté (bornes des listes de périodes). */
export function premiereEmission(factures: FactureBfr[], cote: CoteDelai): string | null {
  let premiere: string | null = null;
  for (const f of factures) if (f.type === cote && f.dateEmission && (premiere === null || f.dateEmission < premiere)) premiere = f.dateEmission;
  return premiere;
}

/** Étage proposé au filtre : clé de l'étage et son libellé. */
export interface EtagePropose {
  id: EtagePnl;
  label: string;
}

/**
 * Étage(s) P&L d'une transaction : ceux des catégories de l'AXE DE RÉFÉRENCE du module, via la
 * correspondance P&L courante — exactement la règle du P&L de Passé (lib/pastDetail.ts::partsMappees).
 * Catégorie non rattachée, ou d'un autre axe : aucun étage. [] : transaction connue, aucun étage.
 * Axe non configuré : rien n'est connu (carte vide).
 */
export function etagesParTransaction(
  categories: CategoriesParTransaction,
  axeId: string | null,
  mappings: ReadonlyMap<string, MappingCategorie>
): CategoriesParTransaction {
  const parTransaction = new Map<string, CategorieAnalytique[]>();
  if (axeId === null) return parTransaction;
  for (const [tid, liste] of categories) {
    const etages = new Map<EtagePnl, CategorieAnalytique>();
    for (const c of liste) {
      if (c.groupId !== axeId) continue;
      const etage = mappings.get(identiteCategorie(c.id, c.label))?.pnlStage ?? null;
      if (etage && !etages.has(etage)) etages.set(etage, { id: etage, label: libelleEtagePnl(etage), groupId: null, weight: 1 });
    }
    parTransaction.set(tid, [...etages.values()]);
  }
  return parTransaction;
}

/** Étages présents sur les factures d'un côté, dans l'ordre du P&L. */
export function etagesProposes(factures: FactureBfr[], cote: CoteDelai): EtagePropose[] {
  const presents = new Set<string>();
  for (const f of factures) if (f.type === cote && Array.isArray(f.categories)) for (const c of f.categories) presents.add(c.id);
  return ETAGES_PNL.filter((e) => presents.has(e.cle)).map((e) => ({ id: e.cle, label: e.libelle }));
}

export function libelleEtageFiltre(filtre: FiltreCategorie): string {
  if (filtre.type === "toutes") return "Tous les étages";
  if (filtre.type === "non_categorise") return "Non classé";
  return estEtagePnl(filtre.id) ? libelleEtagePnl(filtre.id) : "Étage inconnu";
}

/**
 * Pourquoi le filtre d'étage P&L n'a rien à proposer, étape par étape de la chaîne
 * facture -> règlements -> transaction Pennylane -> transaction du module Passé -> étage :
 *  - "axe_non_configure" : plusieurs axes analytiques et aucun choisi pour le P&L du module ;
 *  - "lecture" : catégories des transactions en cours de lecture ;
 *  - "erreur" : lecture des transactions impossible ;
 *  - "aucune_reglee" : aucune facture réglée de ce côté ;
 *  - "a_resynchroniser" : aucun règlement ne porte encore l'identifiant de sa transaction (datés
 *    avant ce champ : la prochaine synchronisation les redate) ;
 *  - "transactions_absentes" : transactions inconnues du module Passé (périodes jamais synchronisées) ;
 *  - "aucun_etage" : transactions connues, aucune de leurs catégories rattachée à un étage du P&L.
 * null : des catégories existent, le filtre est utilisable.
 */
export type RaisonCategoriesIndisponibles =
  | "lecture"
  | "erreur"
  | "axe_non_configure"
  | "aucune_reglee"
  | "a_resynchroniser"
  | "transactions_absentes"
  | "aucun_etage";

export interface DiagnosticCategories {
  reglees: number; // factures du côté avec au moins un règlement daté
  identifiees: number; // dont au moins un règlement porte l'identifiant de sa transaction
  connues: number; // dont au moins une transaction est connue du module Passé
  categorisees: number; // dont au moins un étage P&L
  raison: RaisonCategoriesIndisponibles | null;
}

/** `factures` : avec catégories déduites (avecCategoriesDesTransactions). */
export function diagnosticCategories(
  factures: FactureBfr[],
  cote: CoteDelai,
  parTransaction: CategoriesParTransaction | null,
  erreur: boolean,
  axeConfigure = true
): DiagnosticCategories {
  let reglees = 0;
  let identifiees = 0;
  let connues = 0;
  let categorisees = 0;
  for (const f of factures) {
    if (f.type !== cote || !f.reglements || f.reglements.length === 0) continue;
    reglees++;
    if (f.reglements.some((r) => r.transactionId)) identifiees++;
    if (Array.isArray(f.categories)) connues++;
    if (Array.isArray(f.categories) && f.categories.length > 0) categorisees++;
  }
  const raison: RaisonCategoriesIndisponibles | null = erreur
    ? "erreur"
    : !axeConfigure
      ? "axe_non_configure"
      : parTransaction === null
      ? "lecture"
      : reglees === 0
        ? "aucune_reglee"
        : identifiees === 0
          ? "a_resynchroniser"
          : connues === 0
            ? "transactions_absentes"
            : categorisees === 0
              ? "aucun_etage"
              : null;
  return { reglees, identifiees, connues, categorisees, raison };
}

export const MESSAGES_CATEGORIES_INDISPONIBLES: Record<RaisonCategoriesIndisponibles, string> = {
  lecture: "Lecture des étages P&L des transactions…",
  erreur: "Étages P&L non disponibles : lecture des transactions impossible. Réessayez.",
  axe_non_configure: "Étages P&L non disponibles : choisissez l'axe analytique du P&L dans la correspondance P&L du module.",
  aucune_reglee: "Étages P&L non disponibles : aucune facture réglée, donc aucune transaction rapprochée.",
  a_resynchroniser:
    "Étages P&L non disponibles dans les données Pennylane synchronisées : relancez « Synchroniser Pennylane » pour relier chaque facture réglée à ses transactions.",
  transactions_absentes: "Étages P&L non disponibles : les transactions rapprochées de ces factures ne sont pas encore synchronisées dans le module Passé.",
  aucun_etage: "Étages P&L non disponibles : les catégories des transactions rapprochées ne sont rattachées à aucun étage dans la correspondance P&L.",
};
