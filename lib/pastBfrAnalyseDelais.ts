import { formatDateCourte, parseDateISO, toISODate } from "./dates";
import { ConfigExercice, getCurrentFiscalQuarterRange, getFiscalYearRange } from "./fiscalPeriods";
import { finDeMois } from "./pastAdjustments";
import { CategorieAnalytique, FactureBfr } from "./pastBfr";
import { CoteDelai, FiltreCategorie, PeriodeDelai, TOUTES_CATEGORIES } from "./pastBfrDelais";
import { libelleMois } from "./pastDetail";
import { exercicesProposes, libelleExercice, moisProposes } from "./pastPdfPeriodes";
import { AxeAnalytique } from "./pastTransactions";

/**
 * Filtres de l'ANALYSE des délais clients / fournisseurs (onglet BFR) — fonctions pures. L'écran
 * principal du BFR n'en a aucun : il lit toujours la cohorte mensuelle, toutes factures.
 *
 *  - Période : un mois civil, un trimestre ou l'exercice fiscal de l'organisation (trimestres de
 *    l'exercice, comme le reporting du module), ou deux dates. Une facture en fait partie par sa
 *    DATE D'ÉMISSION ; son délai court jusqu'à son règlement, même après la période.
 *  - Catégorie analytique : celle des TRANSACTIONS bancaires rapprochées de la facture (les factures
 *    elles-mêmes n'en portent pas forcément) — voir avecCategoriesDesTransactions ; filtre et seuil
 *    de montant : lib/pastBfrDelais.ts.
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

export interface GroupeCategories {
  groupId: string | null;
  nom: string; // nom de l'axe analytique
  categories: CategorieAnalytique[];
}

/**
 * Catégories analytiques présentes sur les factures d'un côté, rangées par axe (nom tiré des axes
 * du module, sinon « Axe analytique »), par libellé. Chaque catégorie une fois.
 */
export function categoriesProposees(factures: FactureBfr[], cote: CoteDelai, axes: AxeAnalytique[]): GroupeCategories[] {
  const parId = new Map<string, CategorieAnalytique>();
  for (const f of factures) if (f.type === cote && Array.isArray(f.categories)) for (const c of f.categories) if (!parId.has(c.id)) parId.set(c.id, c);
  const groupes = new Map<string, GroupeCategories>();
  for (const c of parId.values()) {
    const cle = c.groupId ?? "";
    const groupe = groupes.get(cle) ?? { groupId: c.groupId, nom: axes.find((a) => a.groupId === c.groupId)?.name ?? "Axe analytique", categories: [] };
    groupe.categories.push(c);
    groupes.set(cle, groupe);
  }
  return [...groupes.values()]
    .map((g) => ({ ...g, categories: g.categories.sort((a, b) => a.label.localeCompare(b.label, "fr")) }))
    .sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
}

/** Les catégories des factures d'un côté ont-elles été récupérées ? (aucune : filtre sans objet). */
export function categoriesRecuperees(factures: FactureBfr[], cote: CoteDelai): boolean {
  return factures.some((f) => f.type === cote && Array.isArray(f.categories));
}

export function libelleCategorie(filtre: FiltreCategorie, groupes: GroupeCategories[]): string {
  if (filtre.type === "toutes") return "Toutes les catégories";
  if (filtre.type === "non_categorise") return "Non catégorisé";
  for (const g of groupes) for (const c of g.categories) if (c.id === filtre.id) return c.label;
  return "Catégorie introuvable";
}
