import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import {
  PRECISION_FINANCEMENT_COMPRIS,
  PRECISION_HORS_FINANCEMENT,
  calculerDetail,
  evolutionDesCoutsAssocies,
  FiltresDetail,
  libelleMois,
  libelleMoisCourt,
  moisDeLaPeriode,
  PartMappee,
  partsMappees,
  TRI_TRANSACTIONS_PAR_DEFAUT,
  trierTransactions,
} from "./pastDetail";
import { calculerPnl, CLE_AUTRES } from "./pastPnl";
import { PastTransactionStockee } from "./pastTransactions";

const AXE = "229";
const PERIODE = { debut: "2026-07-01", fin: "2026-09-30" };
const SANS_FILTRE: FiltresDetail = { categorie: null, mois: null };

function mapping(id: string, nom: string, pnlStage: MappingCategorie["pnlStage"]): MappingCategorie {
  return { sourceCategoryId: id, sourceCategoryName: nom, sourceGroupId: AXE, pnlStage };
}

function tx(id: string, date: string, amount: number, parts: [string, number][]): PastTransactionStockee {
  return {
    id,
    sourceType: "pennylane",
    transactionDate: date,
    label: `Transaction ${id}`,
    amount,
    currency: "EUR",
    affectations: parts.map(([categoryId, weight]) => ({ groupId: AXE, categoryId, categoryName: categoryId, weight })),
  };
}

const mappings = indexerMappings([
  mapping("stripe", "Stripe", "revenue"),
  mapping("matieres", "Achats matières", "gross_margin"),
  mapping("pub", "Publicité & marketing", "contribution_margin"),
  mapping("logistique", "Logistique", "contribution_margin"),
  mapping("loyer", "Loyer", "ebitda"),
  mapping("tva", "TVA", "extra_pnl"),
  mapping("emprunt", "Emprunt reçu", "extra_pnl"),
  mapping("nouvelle", "Nouvelle catégorie", null),
]);

const transactions = [
  tx("v-juil", "2026-07-10", 10_000, [["stripe", 1]]),
  tx("v-aout", "2026-08-10", 12_000, [["stripe", 1]]),
  tx("v-sept", "2026-09-10", 20_000, [["stripe", 1]]),
  tx("m-sept", "2026-09-12", -6_000, [["matieres", 1]]),
  tx("pub-aout", "2026-08-15", -1_000, [["pub", 1]]),
  tx("pub-sept-1", "2026-09-05", -2_500, [["pub", 1]]),
  tx("pub-sept-2", "2026-09-20", -1_500, [["pub", 1]]),
  tx("log-sept", "2026-09-18", -800, [["logistique", 1]]),
  tx("mixte-sept", "2026-09-25", -1_000, [["pub", 0.7], ["logistique", 0.3]]),
  tx("loyer-sept", "2026-09-01", -3_000, [["loyer", 1]]),
  tx("tva-sept", "2026-09-28", -2_000, [["tva", 1]]),
  tx("emprunt-aout", "2026-08-02", 500, [["emprunt", 1]]),
  tx("non-mappee", "2026-09-03", -999, [["nouvelle", 1]]),
  tx("non-categorisee", "2026-09-04", -777, []),
];
const parts = partsMappees(transactions, AXE, mappings);
const detail = (metrique: Parameters<typeof calculerDetail>[1], filtres = SANS_FILTRE) =>
  calculerDetail(parts, metrique, filtres, PERIODE);

describe("parts mappées — matière première commune des écrans de détail", () => {
  test("ni transaction non catégorisée, ni catégorie non mappée", () => {
    assert.ok(!parts.some((p) => p.transactionId === "non-categorisee" || p.transactionId === "non-mappee"));
  });

  test("une transaction ventilée donne une part par catégorie, montant source conservé", () => {
    assert.deepEqual(
      parts.filter((p) => p.transactionId === "mixte-sept").map((p) => [p.sourceCategoryId, p.montant, p.montantSource, p.weight]),
      [
        ["pub", -700, -1000, 0.7],
        ["logistique", -300, -1000, 0.3],
      ]
    );
  });
});

describe("mois de la période", () => {
  test("tous les mois couverts, même sans transaction, à cheval sur deux années", () => {
    assert.deepEqual(moisDeLaPeriode({ debut: "2025-11-15", fin: "2026-02-03" }), ["2025-11", "2025-12", "2026-01", "2026-02"]);
    assert.deepEqual(moisDeLaPeriode({ debut: "2026-09-30", fin: "2026-09-30" }), ["2026-09"]);
    assert.deepEqual(moisDeLaPeriode({ debut: "2026-12-01", fin: "2026-01-01" }), []);
  });

  test("libellés", () => {
    assert.equal(libelleMois("2026-09"), "Septembre 2026");
    assert.equal(libelleMoisCourt("2026-09", false), "sept.");
    assert.equal(libelleMoisCourt("2026-09", true), "sept. 26");
  });
});

describe("écran de détail sans filtre local — cohérent avec le P&L de l'onglet Général", () => {
  const pnl = calculerPnl(transactions, AXE, mappings);

  test("le KPI de chaque écran est le solde correspondant du P&L", () => {
    assert.equal(detail("ca").kpi.montant, pnl.ca);
    assert.equal(detail("marge_brute").kpi.montant, pnl.margeBrute);
    assert.equal(detail("marge_contributive").kpi.montant, pnl.margeContributive);
    assert.equal(detail("ebitda").kpi.montant, pnl.ebitda);
    assert.equal(detail("cash_flow").kpi.montant, pnl.cashFlow);
  });

  test("ratio sur le CA pour les marges et l'EBITDA, pas pour le CA ni le Cash flow", () => {
    assert.equal(detail("ca").kpi.ratio, undefined);
    assert.equal(detail("cash_flow").kpi.ratio, undefined);
    assert.equal(detail("marge_contributive").kpi.ratio, pnl.ratios.margeContributive);
    assert.equal(detail("ebitda").kpi.ratio, pnl.ratios.ebitda);
  });

  test("le camembert détaille l'étage de l'écran, par catégorie", () => {
    assert.deepEqual(detail("marge_contributive").structure!.parts.map((p) => [p.nom, p.montant]), [
      ["Publicité & marketing", -5_700],
      ["Logistique", -1_100],
    ]);
    assert.deepEqual(detail("ca").structure!.parts.map((p) => [p.nom, p.montant]), [["Stripe", 42_000]]);
  });

  test("l'histogramme couvre tous les mois de la période avec le solde mensuel signé", () => {
    const vue = detail("marge_contributive");
    assert.deepEqual(vue.evolution, [
      { mois: "2026-07", montant: 10_000, valeur: 10_000 },
      { mois: "2026-08", montant: 11_000, valeur: 11_000 },
      { mois: "2026-09", montant: 8_200, valeur: 8_200 },
    ]);
    assert.equal(vue.evolutionAbsolue, false);
    // Sans catégorie, un solde mensuel négatif reste sous zéro.
    const coutsSeuls = calculerDetail(parts.filter((p) => p.etage !== "revenue"), "ebitda", SANS_FILTRE, PERIODE);
    assert.deepEqual(coutsSeuls.evolution.map((e) => e.valeur), [0, -1_000, -14_800]);
  });

  test("les transactions sont celles de l'étage exploré, sans non mappées", () => {
    assert.deepEqual(
      trierTransactions(detail("marge_contributive").transactions, "date").map((p) => [p.transactionId, p.sourceCategoryId, p.montant]),
      [
        ["mixte-sept", "pub", -700],
        ["mixte-sept", "logistique", -300],
        ["pub-sept-2", "pub", -1_500],
        ["log-sept", "logistique", -800],
        ["pub-sept-1", "pub", -2_500],
        ["pub-aout", "pub", -1_000],
      ]
    );
  });
});

describe("cross-filtering — une seule source de vérité pour les quatre blocs", () => {
  test("clic sur un mois : KPI, camembert et transactions se limitent à ce mois ; l'histogramme reste entier", () => {
    const vue = detail("marge_contributive", { categorie: null, mois: "2026-08" });
    assert.equal(vue.kpi.montant, 11_000);
    assert.deepEqual(vue.structure!.parts.map((p) => [p.nom, p.montant]), [["Publicité & marketing", -1_000]]);
    assert.deepEqual(vue.transactions.map((p) => p.transactionId), ["pub-aout"]);
    assert.equal(vue.evolution.length, 3);
    assert.deepEqual(vue.evolution, detail("marge_contributive").evolution);
  });

  test("clic sur une catégorie : KPI, histogramme et transactions se limitent à elle ; le camembert reste entier", () => {
    const vue = detail("marge_contributive", { categorie: "pub", mois: null });
    assert.deepEqual([vue.kpi.categorie, vue.kpi.montant], ["Publicité & marketing", -5_700]);
    assert.equal(vue.kpi.ratio, -5_700 / 42_000);
    assert.ok(vue.transactions.every((p) => p.sourceCategoryId === "pub"));
    assert.equal(vue.transactions.length, 4);
    assert.equal(vue.structure!.parts.length, 2);
  });

  test("catégorie sélectionnée : barreaux en valeur absolue, montants réels conservés", () => {
    const vue = detail("marge_contributive", { categorie: "pub", mois: null });
    assert.equal(vue.evolutionAbsolue, true);
    assert.deepEqual(vue.evolution.map((e) => e.valeur), [0, 1_000, 4_700]);
    assert.deepEqual(vue.evolution.map((e) => e.montant), [0, -1_000, -4_700]);
    // Le KPI, lui, garde le montant financier signé.
    assert.equal(vue.kpi.montant, -5_700);
  });

  test("catégorie + mois se cumulent", () => {
    const vue = detail("marge_contributive", { categorie: "pub", mois: "2026-09" });
    assert.equal(vue.kpi.montant, -4_700);
    assert.equal(vue.kpi.ratio, -4_700 / 20_000);
    assert.deepEqual(trierTransactions(vue.transactions, "date").map((p) => [p.transactionId, p.montant]), [
      ["mixte-sept", -700],
      ["pub-sept-2", -1_500],
      ["pub-sept-1", -2_500],
    ]);
    // Somme des transactions listées = KPI affiché : ce que l'on voit explique le chiffre.
    assert.equal(vue.transactions.reduce((s, p) => s + p.montant, 0), vue.kpi.montant);
  });

  test("le filtre catégorie prend la part pondérée d'une transaction ventilée, pas son montant total", () => {
    const vue = detail("marge_contributive", { categorie: "logistique", mois: "2026-09" });
    assert.equal(vue.kpi.montant, -1_100);
    assert.deepEqual(trierTransactions(vue.transactions, "date").map((p) => [p.transactionId, p.montant, p.montantSource]), [
      ["mixte-sept", -300, -1_000],
      ["log-sept", -800, -800],
    ]);
  });

  test("mois sans CA : pas de ratio plutôt qu'une division par zéro", () => {
    const sansCa = calculerDetail(parts.filter((p) => p.etage !== "revenue"), "ebitda", SANS_FILTRE, PERIODE);
    assert.equal(sansCa.kpi.ratio, null);
  });
});

describe("Cash flow — indicateur dérivé, répartition en histogramme", () => {
  test("KPI = EBITDA + Extra P&L ; transactions de l'Extra P&L", () => {
    const vue = detail("cash_flow");
    assert.equal(vue.kpi.montant, detail("ebitda").kpi.montant + (-2_000 + 500));
    assert.deepEqual(vue.transactions.map((p) => p.transactionId), ["tva-sept", "emprunt-aout"]);
  });

  test("pas de camembert : un histogramme par catégorie d'Extra P&L, montants signés", () => {
    const vue = detail("cash_flow");
    assert.equal(vue.structure, null);
    assert.deepEqual(vue.barresCategories, [
      { cle: "tva", nom: "TVA", montant: -2_000 },
      { cle: "emprunt", nom: "Emprunt reçu", montant: 500 },
    ]);
    assert.equal(detail("ebitda").barresCategories, null);
  });

  test("l'histogramme mensuel reste celui du Cash flow", () => {
    assert.deepEqual(detail("cash_flow").evolution.map((e) => e.montant), [10_000, 11_500, 3_200]);
  });

  test("filtres mois et catégorie, comme sur les autres écrans", () => {
    const aout = detail("cash_flow", { categorie: null, mois: "2026-08" });
    assert.equal(aout.kpi.montant, 11_500);
    assert.deepEqual(aout.barresCategories, [{ cle: "emprunt", nom: "Emprunt reçu", montant: 500 }]);
    assert.deepEqual(aout.transactions.map((p) => p.transactionId), ["emprunt-aout"]);

    const tva = detail("cash_flow", { categorie: "tva", mois: null });
    assert.deepEqual([tva.kpi.categorie, tva.kpi.montant], ["TVA", -2_000]);
    assert.deepEqual(tva.evolution.map((e) => e.valeur), [0, 0, 2_000]);
    assert.equal(tva.barresCategories!.length, 2);
    assert.equal(tva.transactions.reduce((s, p) => s + p.montant, 0), tva.kpi.montant);
  });
});

describe("camembert — lisibilité", () => {
  const nombreuses = Array.from({ length: 10 }, (_, i) => mapping(`c${i}`, `Catégorie ${i}`, "ebitda"));
  const transactionsNombreuses = (etage: MappingCategorie["pnlStage"]) =>
    partsMappees(
      nombreuses.map((m, i) => tx(`t${i}`, "2026-09-01", -(10 - i) * 100, [[m.sourceCategoryId, 1]])),
      AXE,
      indexerMappings(nombreuses.map((m) => ({ ...m, pnlStage: etage })))
    );

  test("CA, Marge brute, Marge contributive : 5 catégories puis « Autres » (6 parts)", () => {
    const vue = calculerDetail(transactionsNombreuses("contribution_margin"), "marge_contributive", SANS_FILTRE, PERIODE);
    assert.deepEqual(vue.structure!.parts.map((p) => p.cle), ["c0", "c1", "c2", "c3", "c4", CLE_AUTRES]);
    assert.equal(vue.structure!.parts[5].nom, "Autres (5 catégories)");
  });

  test("EBITDA : 7 catégories puis « Autres » (8 parts)", () => {
    const vue = calculerDetail(transactionsNombreuses("ebitda"), "ebitda", SANS_FILTRE, PERIODE);
    assert.deepEqual(vue.structure!.parts.map((p) => p.cle), ["c0", "c1", "c2", "c3", "c4", "c5", "c6", CLE_AUTRES]);
    assert.equal(vue.structure!.parts[7].nom, "Autres (3 catégories)");
  });

  test("une petite catégorie sélectionnée sort de « Autres » ; une autre y entre à sa place", () => {
    const vue = calculerDetail(transactionsNombreuses("ebitda"), "ebitda", { categorie: "c9", mois: null }, PERIODE);
    assert.deepEqual(vue.structure!.parts.map((p) => p.cle), ["c0", "c1", "c2", "c3", "c4", "c5", "c9", CLE_AUTRES]);
    assert.equal(vue.structure!.parts[7].nom, "Autres (3 catégories)");
    assert.equal(vue.structure!.parts.reduce((s, p) => s + p.montant, 0), -5_500);
  });
});

describe("tri des listes de transactions", () => {
  const part = (id: string, date: string, montant: number, categorie = "c"): PartMappee => ({
    transactionId: id,
    transactionDate: date,
    mois: date.slice(0, 7),
    label: id,
    montant,
    montantSource: montant,
    weight: 1,
    sourceCategoryId: categorie,
    sourceCategoryName: categorie,
    etage: "ebitda",
  });
  const ids = (liste: PartMappee[]) => liste.map((p) => p.transactionId);

  test("Montant est le tri par défaut", () => {
    assert.equal(TRI_TRANSACTIONS_PAR_DEFAUT, "montant");
  });

  test("Montant : valeur absolue décroissante, le signe réel est conservé", () => {
    const liste = [part("a", "2026-01-01", 800), part("b", "2026-01-02", -4_200), part("c", "2026-01-03", 9_500), part("d", "2026-01-04", -12_000)];
    const triee = trierTransactions(liste, "montant");
    assert.deepEqual(triee.map((p) => p.montant), [-12_000, 9_500, -4_200, 800]);
    // Le tri ne modifie pas la liste d'origine.
    assert.deepEqual(ids(liste), ["a", "b", "c", "d"]);
  });

  test("Date : de la plus récente à la plus ancienne", () => {
    const liste = [part("a", "2026-03-01", -1), part("b", "2026-09-15", -2), part("c", "2026-01-20", -3)];
    assert.deepEqual(ids(trierTransactions(liste, "date")), ["b", "a", "c"]);
  });

  test("à égalité, l'ordre est déterministe quel que soit l'ordre de départ", () => {
    const liste = [part("b", "2026-03-01", -100), part("a", "2026-03-01", -100), part("c", "2026-03-01", -100)];
    for (const tri of ["montant", "date"] as const) {
      assert.deepEqual(ids(trierTransactions(liste, tri)), ["a", "b", "c"]);
      assert.deepEqual(ids(trierTransactions([...liste].reverse(), tri)), ["a", "b", "c"]);
    }
    // Même montant : la plus récente d'abord. Même date : la plus lourde d'abord.
    assert.deepEqual(ids(trierTransactions([part("x", "2026-01-01", -50), part("y", "2026-02-01", 50)], "montant")), ["y", "x"]);
    assert.deepEqual(ids(trierTransactions([part("x", "2026-01-01", -50), part("y", "2026-01-01", 900)], "date")), ["y", "x"]);
  });

  test("transaction ventilée : triée sur le montant attribué à la catégorie, pas sur le montant bancaire", () => {
    const transactions = [
      tx("ventilee", "2026-09-01", -10_000, [["pub", 0.7], ["logistique", 0.3]]),
      tx("simple", "2026-09-02", -5_000, [["pub", 1]]),
      tx("petite", "2026-09-03", -4_000, [["logistique", 1]]),
    ];
    const vue = (categorie: string) =>
      trierTransactions(
        calculerDetail(partsMappees(transactions, AXE, mappings), "marge_contributive", { categorie, mois: null }, PERIODE).transactions,
        "montant"
      ).map((p) => [p.transactionId, p.montant]);
    assert.deepEqual(vue("pub"), [["ventilee", -7_000], ["simple", -5_000]]);
    // Dans le contexte Logistique, la même transaction ne pèse que 3 000 : elle passe derrière.
    assert.deepEqual(vue("logistique"), [["petite", -4_000], ["ventilee", -3_000]]);
  });

  test("le tri porte sur tout le résultat filtré avant le découpage en lots de 100", () => {
    const liste = Array.from({ length: 350 }, (_, i) => part(`t${String(i).padStart(3, "0")}`, "2026-05-01", i % 2 === 0 ? -(i + 1) : i + 1));
    const triee = trierTransactions(liste, "montant");
    assert.equal(triee.length, 350);
    assert.deepEqual(triee.slice(0, 3).map((p) => Math.abs(p.montant)), [350, 349, 348]);
    // Lots successifs : 1–100, 101–200, 201–300, 301–350, sans trou ni redite.
    assert.deepEqual(triee.slice(100, 102).map((p) => Math.abs(p.montant)), [250, 249]);
    assert.equal(triee.slice(300).length, 50);
    assert.equal(Math.abs(triee[349].montant), 1);
  });

  test("le tri s'applique après les filtres catégorie et mois", () => {
    const vue = calculerDetail(parts, "marge_contributive", { categorie: "pub", mois: "2026-09" }, PERIODE);
    assert.deepEqual(trierTransactions(vue.transactions, "montant").map((p) => [p.transactionId, p.montant]), [
      ["pub-sept-1", -2_500],
      ["pub-sept-2", -1_500],
      ["mixte-sept", -700],
    ]);
    assert.deepEqual(ids(trierTransactions(vue.transactions, "date")), ["mixte-sept", "pub-sept-2", "pub-sept-1"]);
  });

  test("donnée anormale : le tri ne plante pas, la ligne passe en dernier sans être modifiée", () => {
    const liste = [part("nan", "2026-01-01", Number.NaN), part("ok", "2026-01-02", -5), part("sans-date", "", -900)];
    assert.deepEqual(ids(trierTransactions(liste, "montant")), ["sans-date", "ok", "nan"]);
    assert.deepEqual(ids(trierTransactions(liste, "date")), ["ok", "nan", "sans-date"]);
    assert.ok(Number.isNaN(liste[0].montant));
  });
});

describe("histogramme « Coûts associés » des écrans de marge", () => {
  const couts = (metrique: Parameters<typeof calculerDetail>[1], filtres = SANS_FILTRE) => evolutionDesCoutsAssocies(parts, metrique, filtres, PERIODE);

  test("chaque marge montre les coûts de son étage, mois par mois, en valeur absolue", () => {
    assert.deepEqual(couts("marge_brute")!.map((p) => [p.mois, p.montant, p.valeur]), [["2026-07", 0, 0], ["2026-08", 0, 0], ["2026-09", -6_000, 6_000]]);
    assert.deepEqual(couts("marge_contributive")!.map((p) => [p.mois, p.montant, p.valeur]), [["2026-07", 0, 0], ["2026-08", -1_000, 1_000], ["2026-09", -5_800, 5_800]]);
    assert.deepEqual(couts("ebitda")!.map((p) => [p.mois, p.montant, p.valeur]), [["2026-07", 0, 0], ["2026-08", 0, 0], ["2026-09", -3_000, 3_000]]);
  });

  test("CA et Cash flow n'ont pas cette lecture", () => {
    assert.equal(couts("ca"), null);
    assert.equal(couts("cash_flow"), null);
  });

  test("un total mensuel positif (avoirs supérieurs aux achats) reste un barreau positif, montant réel conservé", () => {
    const avecAvoir = partsMappees([...transactions, tx("avoir-juil", "2026-07-08", 400, [["matieres", 1]])], AXE, mappings);
    const [juillet] = evolutionDesCoutsAssocies(avecAvoir, "marge_brute", SANS_FILTRE, PERIODE)!;
    assert.deepEqual([juillet.montant, juillet.valeur], [400, 400]);
  });

  test("catégorie sélectionnée : l'évolution de cette catégorie, comme en mode Marge", () => {
    const pub = couts("marge_contributive", { categorie: "pub", mois: null })!;
    assert.deepEqual(pub.map((p) => p.valeur), [0, 1_000, 4_700]);
    assert.deepEqual(pub, detail("marge_contributive", { categorie: "pub", mois: null }).evolution);
  });

  test("le filtre mois ne retire aucun barreau : il reste entier pour situer le mois choisi", () => {
    assert.deepEqual(couts("marge_contributive", { categorie: null, mois: "2026-09" }), couts("marge_contributive"));
  });

  test("les ajustements de gestion ne sont pas des coûts de l'étage : dans la marge, pas dans les coûts associés", () => {
    const stock = [{ id: "s1", date: "2026-09-30", label: "Variation de stock", montant: 2_000, etage: "gross_margin" as const, type: "inventory_variation", notes: null }];
    const marge = calculerDetail(parts, "marge_brute", SANS_FILTRE, PERIODE, stock);
    assert.equal(marge.evolution.find((p) => p.mois === "2026-09")!.montant, 20_000 - 6_000 + 2_000);
    assert.equal(couts("marge_brute")!.find((p) => p.mois === "2026-09")!.montant, -6_000);
    assert.equal(marge.ajustements.lignes.length, 1);
  });

  test("le mode Marge est inchangé : l'indicateur signé, ajustements compris", () => {
    assert.deepEqual(detail("marge_contributive").evolution.map((p) => [p.montant, p.valeur]), [[10_000, 10_000], [11_000, 11_000], [8_200, 8_200]]);
  });
});

describe("Cash flow — « hors financement » et « financement compris »", () => {
  // Noms de catégories volontairement quelconques : seul le mapping décide, jamais le nom.
  const mappingsFinancement = indexerMappings([
    mapping("stripe", "Stripe", "revenue"),
    mapping("loyer", "Loyer", "ebitda"),
    mapping("tva", "TVA", "extra_pnl"),
    mapping("emprunt-extra", "Emprunt Dailly levée virement interne", "extra_pnl"),
    mapping("zz1", "Catégorie A", "financing"),
    mapping("zz2", "Catégorie B", "financing"),
  ]);
  const flux = [
    tx("vente-juil", "2026-07-10", 10_000, [["stripe", 1]]),
    tx("vente-aout", "2026-08-10", 10_000, [["stripe", 1]]),
    tx("vente-sept", "2026-09-10", 10_000, [["stripe", 1]]),
    tx("loyer-aout", "2026-08-01", -3_000, [["loyer", 1]]),
    tx("tva-sept", "2026-09-28", -2_000, [["tva", 1]]),
    tx("extra-nomme-emprunt", "2026-09-03", 700, [["emprunt-extra", 1]]),
    tx("tirage", "2026-07-05", 100_000, [["zz1", 1]]),
    tx("remboursement", "2026-08-05", -100_000, [["zz1", 1]]),
    tx("pret", "2026-07-20", 500_000, [["zz2", 1]]),
    tx("echeance-aout", "2026-08-20", -8_000, [["zz2", 1]]),
    tx("echeance-sept", "2026-09-20", -8_000, [["zz2", 1]]),
  ];
  const copie = structuredClone(flux);
  const partsFlux = partsMappees(flux, AXE, mappingsFinancement);
  const hors = calculerDetail(partsFlux, "cash_flow", SANS_FILTRE, PERIODE);
  const compris = calculerDetail(partsFlux, "cash_flow", SANS_FILTRE, PERIODE, [], { financementCompris: true });
  const pnl = calculerPnl(flux, AXE, mappingsFinancement);

  test("hors financement est la lecture par défaut ; le titre reste « Cash flow », la lecture est précisée", () => {
    assert.deepEqual(calculerDetail(partsFlux, "cash_flow", SANS_FILTRE, PERIODE, [], { financementCompris: false }), hors);
    assert.deepEqual([hors.kpi.libelle, hors.kpi.precision], ["Cash flow", PRECISION_HORS_FINANCEMENT]);
    assert.deepEqual([compris.kpi.libelle, compris.kpi.precision], ["Cash flow", PRECISION_FINANCEMENT_COMPRIS]);
    assert.equal(detail("ebitda").kpi.precision, null);
  });

  test("hors financement = EBITDA + Extra P&L : tout l'étage est exclu, montants positifs comme négatifs", () => {
    assert.equal(hors.kpi.montant, pnl.ebitda + pnl.extraPnl);
    assert.equal(hors.kpi.montant, 30_000 - 3_000 - 2_000 + 700);
    assert.deepEqual(hors.evolution.map((e) => e.montant), [10_000, 7_000, 8_700]);
  });

  test("financement compris = EBITDA + Extra P&L + l'étage : la lecture bancaire complète", () => {
    assert.equal(compris.kpi.montant, pnl.cashFlow);
    assert.equal(pnl.cashFlow, pnl.ebitda + pnl.extraPnl + pnl.financements);
    assert.equal(compris.kpi.montant, flux.reduce((s, t) => s + t.amount, 0));
    assert.deepEqual(compris.evolution.map((e) => e.montant), [610_000, -101_000, 700]);
  });

  test("aucune règle de signe : l'écart entre les deux lectures est, chaque mois, le total de l'étage", () => {
    const etage = new Map([["2026-07", 600_000], ["2026-08", -108_000], ["2026-09", -8_000]]);
    for (const [index, point] of compris.evolution.entries()) {
      assert.equal(point.montant - hors.evolution[index].montant, etage.get(point.mois), point.mois);
    }
  });

  test("Extra P&L est inclus dans les deux lectures, quel que soit le nom de la catégorie", () => {
    for (const vue of [hors, compris]) {
      assert.ok(vue.transactions.some((p) => p.transactionId === "tva-sept"));
      assert.ok(vue.transactions.some((p) => p.transactionId === "extra-nomme-emprunt"));
    }
  });

  test("KPI, histogramme, répartition et transactions parlent du même périmètre", () => {
    for (const vue of [hors, compris]) {
      assert.equal(vue.kpi.montant, vue.evolution.reduce((s, e) => s + e.montant, 0));
      const detailTransactions = vue.transactions.reduce((s, p) => s + p.montant, 0);
      assert.equal(vue.barresCategories!.reduce((s, c) => s + c.montant, 0), detailTransactions);
    }
    assert.deepEqual(hors.barresCategories!.map((c) => c.cle).sort(), ["emprunt-extra", "tva"]);
    assert.deepEqual(compris.barresCategories!.map((c) => c.cle).sort(), ["emprunt-extra", "tva", "zz1", "zz2"]);
    assert.ok(!hors.transactions.some((p) => p.etage === "financing"));
    assert.equal(compris.transactions.filter((p) => p.etage === "financing").length, 5);
  });

  test("financement compris : les transactions de l'étage sont listées à leur montant et signe réels", () => {
    const parId = new Map(compris.transactions.map((p) => [p.transactionId, p.montant]));
    assert.deepEqual([parId.get("tirage"), parId.get("remboursement"), parId.get("pret"), parId.get("echeance-aout")], [100_000, -100_000, 500_000, -8_000]);
  });

  test("changer de lecture ne modifie aucune donnée source", () => {
    assert.deepEqual(flux, copie);
  });

  test("l'option n'a d'effet que sur l'écran Cash flow", () => {
    assert.deepEqual(calculerDetail(partsFlux, "ebitda", SANS_FILTRE, PERIODE, [], { financementCompris: true }), calculerDetail(partsFlux, "ebitda", SANS_FILTRE, PERIODE));
  });

  test("sans catégorie rattachée à l'étage, les deux lectures sont identiques : les mappings Extra P&L existants ne bougent pas", () => {
    const avec = calculerDetail(parts, "cash_flow", SANS_FILTRE, PERIODE, [], { financementCompris: true });
    const sans = detail("cash_flow");
    assert.deepEqual([avec.kpi.montant, avec.evolution, avec.barresCategories, avec.transactions], [sans.kpi.montant, sans.evolution, sans.barresCategories, sans.transactions]);
    assert.equal(calculerPnl(transactions, AXE, mappings).financements, 0);
    assert.equal(calculerPnl(transactions, AXE, mappings).cashFlow, sans.kpi.montant);
  });
});
