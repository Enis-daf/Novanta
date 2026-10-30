import type { ActionCompta, ReponseCompta } from "./comptaClient";
import type { ResultatImportFec } from "./comptaRepository";
import { ChoixSource, ImportFec, SoldeProvenance } from "./comptaSources";
import { assemblerVueComptable } from "./comptaVue";
import { contenuCanonique, erreurImportFec, ImportFecPrepare, soldesDepuisImportFec } from "./fecParseur";
import { MODELE_CORRESPONDANCE, RegleCorrespondance } from "./comptaCorrespondance";
import { COMPTES_FIXTURES, LIGNES_FIXTURES } from "./comptaFixtures";
import { ExerciceComptable } from "./comptaExercices";
import { soldesDepuisLignes } from "./comptaPnl";
import { AjustementComptable, ChoixStock } from "./comptaStocks";
import type { BilanSynchro } from "./comptaSynchro";
import { StockFinDeMois } from "./pastAdjustments";
import { MappingCategorie } from "./pastCategoryMapping";
import { PastTransactionStockee, Periode } from "./pastTransactions";

/**
 * Données SIMULÉES de la page de démonstration (app/demo/pnl) : les vrais composants et le vrai moteur,
 * sans base ni Pennylane. Rien ici n'est atteint par le produit ; la page répond 404 sans son drapeau.
 */

const AXE = "demo";

export const AXE_DEMO = AXE;

export const MAPPINGS_DEMO: MappingCategorie[] = [
  { sourceCategoryId: "ventes", sourceCategoryName: "Ventes", sourceGroupId: AXE, pnlStage: "revenue", vatRate: 20 },
  { sourceCategoryId: "abonnements", sourceCategoryName: "Abonnements", sourceGroupId: AXE, pnlStage: "revenue", vatRate: 20 },
  { sourceCategoryId: "achats", sourceCategoryName: "Achats marchandises", sourceGroupId: AXE, pnlStage: "gross_margin", vatRate: 20 },
  { sourceCategoryId: "transport", sourceCategoryName: "Transport", sourceGroupId: AXE, pnlStage: "contribution_margin", vatRate: 20 },
  { sourceCategoryId: "loyer", sourceCategoryName: "Loyer", sourceGroupId: AXE, pnlStage: "ebitda", vatRate: 20 },
  { sourceCategoryId: "salaires", sourceCategoryName: "Salaires", sourceGroupId: AXE, pnlStage: "ebitda", vatRate: 0 },
  { sourceCategoryId: "divers", sourceCategoryName: "Exceptionnel", sourceGroupId: AXE, pnlStage: "extra_pnl", vatRate: 0 },
  { sourceCategoryId: "tva", sourceCategoryName: "TVA", sourceGroupId: AXE, pnlStage: "vat", vatRate: null },
  { sourceCategoryId: "emprunt", sourceCategoryName: "Emprunt", sourceGroupId: AXE, pnlStage: "financing", vatRate: null },
  { sourceCategoryId: "autre", sourceCategoryName: "Catégorie sans étage", sourceGroupId: AXE, pnlStage: null, vatRate: null },
];

function t(id: string, date: string, label: string, amount: number, categorie?: string): PastTransactionStockee {
  return {
    id,
    sourceType: "pennylane",
    transactionDate: date,
    label,
    amount,
    currency: "EUR",
    affectations: categorie ? [{ groupId: AXE, categoryId: categorie, categoryName: MAPPINGS_DEMO.find((m) => m.sourceCategoryId === categorie)!.sourceCategoryName, weight: 1 }] : [],
  };
}

export const TRANSACTIONS_DEMO: PastTransactionStockee[] = (["01", "02", "03"] as const).flatMap((mois, i) => {
  const d = `2026-${mois}`;
  const facteur = 1 + i * 0.1;
  return [
    t(`v${mois}`, `${d}-10`, "Encaissements clients", 96_000 * facteur, "ventes"),
    t(`a${mois}`, `${d}-12`, "Abonnements", 24_000 * facteur, "abonnements"),
    t(`m${mois}`, `${d}-15`, "Fournisseur marchandises", -42_000 * facteur, "achats"),
    t(`r${mois}`, `${d}-16`, "Transporteur", -6_000 * facteur, "transport"),
    t(`l${mois}`, `${d}-05`, "Loyer", -4_800, "loyer"),
    t(`s${mois}`, `${d}-28`, "Salaires", -21_000, "salaires"),
    t(`t${mois}`, `${d}-20`, "TVA à reverser", -9_000, "tva"),
    t(`e${mois}`, `${d}-25`, "Échéance d'emprunt", -2_500, "emprunt"),
  ];
}).concat([
  t("x1", "2026-02-18", "Exceptionnel", -1_200, "divers"),
  t("n1", "2026-03-11", "Virement sans catégorie", -1_850),
  t("n2", "2026-03-12", "Remboursement sans catégorie", 420),
  t("c1", "2026-03-14", "Dépense à mapper", -730, "autre"),
]);

export const STOCKS_DEMO: StockFinDeMois[] = [
  { mois: "2025-12", valeur: 30_000 },
  { mois: "2026-01", valeur: 32_000 },
  { mois: "2026-02", valeur: 31_000 },
  { mois: "2026-03", valeur: 34_000 },
];

export const EXERCICES_DEMO: ExerciceComptable[] = [
  { idSource: "demo-2025", debut: "2025-01-01", fin: "2025-12-31", statut: "closed" },
  { idSource: "demo-2026", debut: "2026-01-01", fin: "2026-12-31", statut: "open" },
];

/**
 * Services en mémoire pour PasseCompta : le vrai parseur et le vrai assemblage, sur des données simulées. Reproduit
 * les règles de la fonction SQL d'import (contenu identique, chevauchement, remplacement explicite).
 */
export function servicesDemo(options: { reglesInitiales?: RegleCorrespondance[]; avecStocksNovanta?: boolean; sansApi?: boolean } = {}) {
  let regles = options.reglesInitiales ?? [...MODELE_CORRESPONDANCE];
  const choixStock = new Map<string, ChoixStock>();
  const choixAmortissement = new Map<string, ChoixStock>();
  const choixSources: ChoixSource[] = [];
  const imports: (ImportFec & { empreinte: string; lignes: ImportFecPrepare["lignes"] })[] = [];
  const ajustements: AjustementComptable[] = [];
  const libelles = new Map(COMPTES_FIXTURES.map((c) => [c.numero, c.libelle]));
  let horloge = 0;
  const instant = () => `2026-04-01T00:00:${String(horloge++ % 60).padStart(2, "0")}Z`;

  const soldesApi = (): SoldeProvenance[] => (options.sansApi ? [] : soldesDepuisLignes(LIGNES_FIXTURES, { debut: "2025-01-01", fin: "2026-12-31" }).map((s) => ({ ...s, source: "pennylane" })));
  const soldesFec = (): SoldeProvenance[] => imports.filter((i) => i.statut === "active").flatMap((i) => soldesDepuisImportFec(i.lignes).map((s) => ({ ...s, source: "fec" as const })));

  return {
    async charger(periode: Periode): Promise<ReponseCompta> {
      const comptes = [...libelles].map(([numero, libelle]) => ({ numero, libelle, premiereVue: "2026-01-01T00:00:00Z" }));
      const fin = "2026-03-31T06:00:00Z";
      const vue = assemblerVueComptable(
        {
          exercicesPennylane: options.sansApi ? [] : EXERCICES_DEMO,
          imports: imports.map(({ empreinte: _e, lignes: _l, ...i }) => i),
          choixSources,
          regles,
          comptes,
          stocks: options.avecStocksNovanta ? STOCKS_DEMO : [],
          choixStock,
          choixAmortissement,
          ajustementsSaisis: ajustements,
          synchros: { derniere: null, derniereReussie: options.sansApi ? null : { declencheur: "quotidien", statut: "success", commenceeLe: fin, termineeLe: fin, moisDemandes: 2, moisActualises: 2, moisEnEchec: [], limites: [] } },
          premiereEcriture: null,
        },
        [...soldesApi(), ...soldesFec()],
        periode
      );
      return { ...vue, synchroDisponible: false };
    },
    async modifier(action: ActionCompta): Promise<void> {
      if (action.action === "enregistrer_regle") {
        regles = [...regles.filter((r) => r.prefixe !== action.prefixe), { prefixe: action.prefixe, destination: action.destination as RegleCorrespondance["destination"], categorie: action.categorie }];
      } else if (action.action === "supprimer_regle") {
        regles = regles.filter((r) => r.prefixe !== action.prefixe);
      } else if (action.action === "appliquer_modele") {
        const presentes = new Set(regles.map((r) => r.prefixe));
        regles = [...regles, ...MODELE_CORRESPONDANCE.filter((r) => !presentes.has(r.prefixe))];
      } else if (action.action === "source_stock") {
        (action.element === "depreciation" ? choixAmortissement : choixStock).set(action.debut, { source: action.source, montantPennylane: null, montantNovanta: null, choisiLe: instant() });
      } else if (action.action === "source_periode") {
        choixSources.push({ debut: action.debut, fin: action.fin, source: action.source, choisiLe: instant() });
      } else if (action.action === "retirer_import") {
        const i = imports.find((x) => x.id === action.id);
        if (i) i.statut = "withdrawn";
      } else if (action.action === "ajouter_ajustements") {
        for (const a of action.ajustements) ajustements.push({ id: `demo-${horloge++}`, date: a.date, ligne: a.ligne as AjustementComptable["ligne"], libelle: a.libelle, montant: a.montant, notes: null, nature: a.nature as AjustementComptable["nature"] });
      } else if (action.action === "retirer_ajustement") {
        const rang = ajustements.findIndex((a) => a.id === action.id);
        if (rang >= 0) ajustements.splice(rang, 1);
      }
    },
    async synchroniser(): Promise<BilanSynchro> {
      throw new Error("Aucune lecture réelle en démonstration.");
    },
    async importerFec(p: ImportFecPrepare, remplacer: boolean): Promise<ResultatImportFec> {
      const erreur = erreurImportFec(p);
      if (erreur) throw new Error(erreur);
      const empreinte = contenuCanonique(p);
      const actifs = imports.filter((i) => i.statut === "active");
      const identique = actifs.find((i) => i.empreinte === empreinte);
      if (identique) return { statut: "identique", import_id: identique.id };
      const recoupes = actifs.filter((i) => i.debut <= p.exercice.fin && i.fin >= p.exercice.debut);
      if (recoupes.length > 0 && !remplacer) return { statut: "chevauchement", chevauchements: recoupes.map((i) => ({ id: i.id, debut: i.debut, fin: i.fin, fichier: i.nomFichier })) };
      for (const i of recoupes) i.statut = "replaced";
      const id = `demo-import-${imports.length + 1}`;
      imports.push({ id, nomFichier: p.nomFichier, debut: p.exercice.debut, fin: p.exercice.fin, cloture: p.exercice.cloture, statut: "active", importeLe: instant(), resume: p.resume, empreinte, lignes: p.lignes });
      for (const [compte, libelle] of Object.entries(p.libelles)) if (!libelles.has(compte)) libelles.set(compte, libelle);
      return { statut: "importe", import_id: id };
    },
  };
}
