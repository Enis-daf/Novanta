import type { ReponseCompta } from "./comptaClient";
import { MODELE_CORRESPONDANCE, RegleCorrespondance } from "./comptaCorrespondance";
import { COMPTES_FIXTURES, LIGNES_FIXTURES } from "./comptaFixtures";
import { calculerPnlComptable, soldesDepuisLignes, SourceStock } from "./comptaPnl";
import { ajustementsDeLaPeriode, ajustementsDepuisStocks, StockFinDeMois } from "./pastAdjustments";
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

/** Services en mémoire pour PasseCompta : le moteur réel, sur des écritures simulées. */
export function servicesDemo(options: { reglesInitiales?: RegleCorrespondance[]; avecStocksNovanta?: boolean } = {}) {
  let regles = options.reglesInitiales ?? [...MODELE_CORRESPONDANCE];
  let sourceStock: SourceStock | null = null;
  return {
    async charger(periode: Periode): Promise<ReponseCompta> {
      const soldes = soldesDepuisLignes(LIGNES_FIXTURES, periode);
      const comptes = COMPTES_FIXTURES.map((c) => ({ numero: c.numero, libelle: c.libelle, premiereVue: "2026-01-01T00:00:00Z" }));
      return {
        pnl: calculerPnlComptable({
          soldes,
          regles,
          libellesComptes: new Map(comptes.map((c) => [c.numero, c.libelle])),
          variationsStockNovanta: options.avecStocksNovanta ? ajustementsDeLaPeriode(ajustementsDepuisStocks(STOCKS_DEMO), periode) : [],
          sourceStockChoisie: sourceStock,
        }),
        regles,
        comptes,
        soldes,
        sourceStock,
        synchro: null,
        synchroDisponible: false,
        premiereEcriture: "2026-01-20",
      };
    },
    async modifier(action: { action: string; prefixe?: string; destination?: string; categorie?: string; source?: SourceStock | null }): Promise<void> {
      if (action.action === "enregistrer_regle") {
        regles = [...regles.filter((r) => r.prefixe !== action.prefixe), { prefixe: action.prefixe!, destination: action.destination as RegleCorrespondance["destination"], categorie: action.categorie! }];
      } else if (action.action === "supprimer_regle") {
        regles = regles.filter((r) => r.prefixe !== action.prefixe);
      } else if (action.action === "appliquer_modele") {
        const presentes = new Set(regles.map((r) => r.prefixe));
        regles = [...regles, ...MODELE_CORRESPONDANCE.filter((r) => !presentes.has(r.prefixe))];
      } else if (action.action === "source_stock") {
        sourceStock = action.source ?? null;
      }
    },
    async synchroniser() {
      throw new Error("Aucune lecture réelle en démonstration.");
    },
  };
}
