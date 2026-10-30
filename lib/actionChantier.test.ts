import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  Atteinte,
  calculerAtteinte,
  carteDuSuivi,
  libelleAtteinte,
  libelleEcartReference,
  libellesReference,
  lirePhotographie,
  photographierChantier,
  Chantier,
  CLE_PERSONNALISE,
  decalerMois,
  departDuChemin,
  DonneesPasse,
  erreurChantierActif,
  erreurCible,
  erreurCompositionKpis,
  formatEcartKpi,
  formatFraction,
  KpiChantier,
  libellePeriode,
  mesurerSurPeriode,
  moisSaisissables,
  peutAjouterKpi,
  periodesProposees,
  proposerReference,
  SANS_REFERENCE,
  statutDuMois,
  suivreKpi,
} from "./actionChantier";
import { EXERCICE_PAR_DEFAUT } from "./fiscalPeriods";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { calculerPnlEnBase } from "./pastHtEstime";
import { PastTransactionStockee } from "./pastTransactions";

const AXE = "axe";

function mapping(id: string, pnlStage: MappingCategorie["pnlStage"], vatRate: number | null = 0): MappingCategorie {
  return { sourceCategoryId: id, sourceCategoryName: id, sourceGroupId: AXE, pnlStage, vatRate };
}

let compteur = 0;
function tx(date: string, amount: number, categorie: string): PastTransactionStockee {
  compteur += 1;
  return {
    id: `t${compteur}`,
    sourceType: "pennylane",
    transactionDate: date,
    label: "",
    amount,
    currency: "EUR",
    affectations: [{ groupId: AXE, categoryId: categorie, categoryName: categorie, weight: 1 }],
  };
}

const mappings = indexerMappings([mapping("ca", "revenue"), mapping("achats", "gross_margin"), mapping("pub", "contribution_margin"), mapping("loyer", "ebitda")]);

// Chaque mois : 100 k€ d'encaissements, 60 k€ d'achats → marge brute 40 k€ (40 %).
function moisType(mois: string, ca = 100_000, achats = -60_000): PastTransactionStockee[] {
  return [tx(`${mois}-05`, ca, "ca"), tx(`${mois}-12`, achats, "achats")];
}

function donnees(transactions: PastTransactionStockee[], extra: Partial<DonneesPasse> = {}): DonneesPasse {
  const premiere = transactions.map((t) => t.transactionDate).sort()[0] ?? null;
  return { transactions, axeId: AXE, mappings, ajustements: [], premiereOperation: premiere, situationsBfr: [], ...extra };
}

function kpi(partiel: Partial<KpiChantier> & Pick<KpiChantier, "cle">): KpiChantier {
  return {
    id: `k-${partiel.cle}`,
    position: 1,
    nomPersonnalise: null,
    unitePersonnalisee: null,
    sens: "up",
    reference: SANS_REFERENCE,
    cible: 0,
    ...partiel,
  };
}

const T4: Chantier["periode"] = { debut: "2026-10-01", fin: "2026-12-31" };

describe("Composition du chantier", () => {
  test("exactement 3 indicateurs", () => {
    assert.match(erreurCompositionKpis([{ cle: "encaissements" }, { cle: "taux_marge_brute" }]) ?? "", /exactement 3/);
    assert.equal(erreurCompositionKpis([{ cle: "encaissements" }, { cle: "taux_marge_brute" }, { cle: "bfr" }]), null);
    assert.match(
      erreurCompositionKpis([{ cle: "encaissements" }, { cle: "taux_marge_brute" }, { cle: "bfr" }, { cle: "ebitda" }]) ?? "",
      /exactement 3/
    );
  });

  test("trois indicateurs automatiques acceptés, un deuxième indicateur manuel refusé", () => {
    assert.equal(erreurCompositionKpis([{ cle: "encaissements" }, { cle: "ebitda" }, { cle: CLE_PERSONNALISE }]), null);
    assert.match(
      erreurCompositionKpis([{ cle: CLE_PERSONNALISE }, { cle: CLE_PERSONNALISE }, { cle: "ebitda" }]) ?? "",
      /Un seul indicateur personnalisé/
    );
    assert.equal(peutAjouterKpi([{ cle: CLE_PERSONNALISE }], CLE_PERSONNALISE), false);
    assert.equal(peutAjouterKpi([{ cle: "ebitda" }, { cle: "bfr" }, { cle: "encaissements" }], "taux_ebitda"), false);
    assert.equal(peutAjouterKpi([{ cle: "ebitda" }], CLE_PERSONNALISE), true);
  });

  test("un seul chantier actif", () => {
    assert.match(erreurChantierActif({ statut: "active" }) ?? "", /déjà en cours/);
    assert.equal(erreurChantierActif({ statut: "completed" }), null);
    assert.equal(erreurChantierActif(null), null);
  });

  test("cible fixe : sens d'amélioration et cumul positif", () => {
    assert.equal(erreurCible(48, "up", 30, "taux"), null);
    assert.match(erreurCible(25, "up", 30, "taux") ?? "", /inférieur à la référence/);
    assert.match(erreurCible(70, "down", 60, "situation") ?? "", /supérieur à la référence/);
    assert.equal(erreurCible(30, "up", 30, "taux"), null); // maintien
    assert.match(erreurCible(0, "up", null, "cumulatif") ?? "", /positif/);
    assert.equal(erreurCible(120_000, "up", 250_000, "cumulatif"), null); // la référence n'est qu'un repère
    assert.match(erreurCible(null, "up", null, "manuel") ?? "", /Saisissez/);
  });
});

describe("Pourcentage d'atteinte : chemin parcouru entre référence et cible", () => {
  test("en hausse : référence 30 %, cible 48 %, réalisé 42 % → 67 %", () => {
    const a = calculerAtteinte(30, 48, 42, "up");
    assert.equal(a.etat, "calcule");
    if (a.etat !== "calcule") return;
    assert.equal(Math.round(a.fraction * 100), 67);
    assert.equal(a.recul, false);
  });

  test("en baisse : référence 60 j, cible 40 j, réalisé 48 j → 60 %", () => {
    const a = calculerAtteinte(60, 40, 48, "down");
    assert.equal(a.etat === "calcule" && Math.round(a.fraction * 100), 60);
  });

  test("dépassement : le pourcentage dépasse 100 %, la jauge est plafonnée", () => {
    const a = calculerAtteinte(30, 48, 50.16, "up");
    assert.equal(a.etat, "calcule");
    if (a.etat !== "calcule") return;
    assert.equal(Math.round(a.fraction * 100), 112);
    assert.equal(a.jauge, 1);
    assert.equal(a.depasse, true);
    assert.equal(formatFraction(a.fraction), "112 %");
  });

  test("détérioration : pourcentage négatif, jauge vide, recul signalé", () => {
    const a = calculerAtteinte(30, 48, 26.4, "up");
    assert.equal(a.etat, "calcule");
    if (a.etat !== "calcule") return;
    assert.equal(Math.round(a.fraction * 100), -20);
    assert.equal(a.jauge, 0);
    assert.equal(a.recul, true);
    const baisse = calculerAtteinte(60, 40, 66, "down");
    assert.equal(baisse.etat === "calcule" && baisse.recul, true);
  });

  test("absence de référence ou de valeur", () => {
    assert.deepEqual(calculerAtteinte(null, 48, 42, "up"), { etat: "sans_reference" });
    assert.deepEqual(calculerAtteinte(30, 48, null, "up"), { etat: "sans_valeur" });
  });

  test("cible égale à la référence : objectif de maintien, sans division par zéro", () => {
    assert.deepEqual(calculerAtteinte(30, 30, 31, "up"), { etat: "maintien", atteint: true });
    assert.deepEqual(calculerAtteinte(30, 30, 29, "up"), { etat: "maintien", atteint: false });
    assert.deepEqual(calculerAtteinte(40, 40, 38, "down"), { etat: "maintien", atteint: true });
  });

  test("valeurs négatives : seul l'écart compte", () => {
    // Taux d'EBITDA de −10 % à +5 %, réalisé −4 % : 6 points sur 15 → 40 %.
    const a = calculerAtteinte(-10, 5, -4, "up");
    assert.equal(a.etat === "calcule" && Math.round(a.fraction * 100), 40);
    // BFR négatif qu'on veut encore réduire : −20 k€ → −50 k€, réalisé −35 k€ → 50 %.
    const b = calculerAtteinte(-20_000, -50_000, -35_000, "down");
    assert.equal(b.etat === "calcule" && Math.round(b.fraction * 100), 50);
  });

  test("cumul : le chemin part de zéro, la référence reste un repère", () => {
    assert.equal(departDuChemin("cumulatif", 250_000), 0);
    assert.equal(departDuChemin("taux", 30), 30);
    const a = calculerAtteinte(departDuChemin("cumulatif", 250_000), 300_000, 175_000, "up");
    assert.equal(a.etat === "calcule" && Math.round(a.fraction * 100), 58);
  });
});

describe("Périodes", () => {
  test("périodes proposées avec dates exactes, sur l'exercice", () => {
    const [enCours, suivante] = periodesProposees("quarter", "2026-10-27", EXERCICE_PAR_DEFAUT);
    assert.deepEqual(enCours.periode, { debut: "2026-10-01", fin: "2026-12-31" });
    assert.equal(enCours.libelle, "T4 2026");
    assert.deepEqual(suivante.periode, { debut: "2027-01-01", fin: "2027-03-31" });
    assert.equal(suivante.libelle, "T1 2027");
    const [mois] = periodesProposees("month", "2026-10-27", EXERCICE_PAR_DEFAUT);
    assert.deepEqual(mois.periode, { debut: "2026-10-01", fin: "2026-10-31" });
    assert.equal(mois.libelle, "Octobre 2026");
    const [, semestre] = periodesProposees("semester", "2026-10-27", EXERCICE_PAR_DEFAUT);
    assert.equal(semestre.libelle, "S1 2027");
    assert.equal(periodesProposees("year", "2026-10-27", EXERCICE_PAR_DEFAUT)[0].libelle, "Exercice 2026");
  });

  test("exercice décalé : rang dans l'exercice", () => {
    const config = { mois: 7, jour: 1 };
    const [enCours] = periodesProposees("quarter", "2026-10-27", config);
    assert.deepEqual(enCours.periode, { debut: "2026-10-01", fin: "2026-12-31" });
    assert.equal(libellePeriode("quarter", enCours.periode, config), "T2 · exercice 2026-27");
  });

  test("décalage de mois : un dernier jour de mois le reste", () => {
    assert.equal(decalerMois("2026-12-31", -12), "2025-12-31");
    assert.equal(decalerMois("2026-03-31", -1), "2026-02-28");
    assert.equal(decalerMois("2024-02-29", 12), "2025-02-28");
  });

  test("mois clos, en cours, à venir", () => {
    assert.equal(statutDuMois("2026-09", T4, "2026-10-27"), "clos");
    assert.equal(statutDuMois("2026-10", T4, "2026-10-27"), "en_cours");
    assert.equal(statutDuMois("2026-11", T4, "2026-10-27"), "a_venir");
    // Le dernier jour du mois n'est pas encore passé : toujours en cours.
    assert.equal(statutDuMois("2026-10", T4, "2026-10-31"), "en_cours");
    assert.equal(statutDuMois("2026-10", T4, "2026-11-01"), "clos");
    assert.deepEqual(moisSaisissables(T4, "2026-11-03"), ["2026-10", "2026-11"]);
  });
});

describe("Référence historique", () => {
  const historiqueComplet = donnees([
    ...moisType("2025-10", 80_000, -56_000), // 30 %
    ...moisType("2025-11", 80_000, -56_000),
    ...moisType("2025-12", 80_000, -56_000),
    ...moisType("2026-07"),
    ...moisType("2026-08"),
    ...moisType("2026-09"),
    ...moisType("2026-10"),
  ]);

  test("1. période équivalente passée", () => {
    const ref = proposerReference("taux_marge_brute", "quarter", T4, (p) => libellePeriode("quarter", p, EXERCICE_PAR_DEFAUT), historiqueComplet, "2026-10-27");
    assert.equal(ref.origine, "equivalent");
    assert.equal(ref.libelle, "T4 2025");
    assert.ok(Math.abs((ref.valeur as number) - 30) < 1e-9);
    assert.deepEqual(ref.periode, { debut: "2025-10-01", fin: "2025-12-31" });
  });

  test("2. sinon dernière période complète comparable", () => {
    const d = donnees([...moisType("2026-07"), ...moisType("2026-08"), ...moisType("2026-09"), ...moisType("2026-10")]);
    const ref = proposerReference("encaissements", "quarter", T4, (p) => libellePeriode("quarter", p, EXERCICE_PAR_DEFAUT), d, "2026-10-27");
    assert.equal(ref.origine, "previous");
    assert.equal(ref.libelle, "Trimestre précédent (T3 2026)");
    assert.equal(ref.valeur, 300_000);
  });

  test("3. sinon référence indicative, dite comme telle, sans transformer quelques mois en année en silence", () => {
    const d = donnees([...moisType("2026-07"), ...moisType("2026-08"), ...moisType("2026-09"), ...moisType("2026-10")]);
    const annee = { debut: "2027-01-01", fin: "2027-12-31" };
    const cumul = proposerReference("encaissements", "year", annee, (p) => libellePeriode("year", p, EXERCICE_PAR_DEFAUT), d, "2026-10-27");
    assert.equal(cumul.origine, "indicative");
    assert.equal(cumul.libelle, "Indicative : moyenne de 3 mois (juil.–sept. 2026) ramenée à 12 mois");
    assert.equal(cumul.valeur, 1_200_000);
    const taux = proposerReference("taux_marge_brute", "year", annee, (p) => libellePeriode("year", p, EXERCICE_PAR_DEFAUT), d, "2026-10-27");
    assert.equal(taux.libelle, "Indicative : sur les 3 mois disponibles (juil.–sept. 2026)");
    assert.ok(Math.abs((taux.valeur as number) - 40) < 1e-9);
  });

  test("4. historique insuffisant : aucune référence, jamais zéro", () => {
    const d = donnees(moisType("2026-10"));
    const ref = proposerReference("encaissements", "quarter", T4, (p) => libellePeriode("quarter", p, EXERCICE_PAR_DEFAUT), d, "2026-10-27");
    assert.equal(ref.origine, "none");
    assert.equal(ref.valeur, null);
    assert.match(ref.raison ?? "", /Historique insuffisant/);
  });

  test("BFR : situation validée de la fin du mois précédent", () => {
    const d = donnees([], { situationsBfr: [{ date: "2026-08-31", bfr: 90_000 }, { date: "2026-09-30", bfr: 80_000 }] });
    const ref = proposerReference("bfr", "quarter", T4, () => "", d, "2026-10-27");
    assert.equal(ref.origine, "situation");
    assert.equal(ref.valeur, 80_000);
    assert.match(ref.libelle ?? "", /30 sept\. 2026/);
    const sans = proposerReference("bfr", "quarter", T4, () => "", donnees([]), "2026-10-27");
    assert.equal(sans.origine, "none");
  });
});

describe("Séries mensuelles", () => {
  const aujourdhui = "2026-11-15";
  const d = donnees([
    ...moisType("2026-09"),
    ...moisType("2026-10", 80_000, -50_000),
    ...moisType("2026-11", 95_000, -40_000),
    // Hors période : n'entre jamais dans le chantier.
    tx("2027-01-04", 999_999, "ca"),
  ]);

  test("cumulatif : progression cumulée depuis le début, aucun mois futur", () => {
    const suivi = suivreKpi(kpi({ cle: "encaissements", cible: 300_000 }), { periode: T4 }, d, [], aujourdhui);
    assert.deepEqual(
      suivi.points.map((p) => [p.mois, p.statut, p.valeur]),
      [
        ["2026-10", "clos", 80_000],
        ["2026-11", "en_cours", 175_000],
        ["2026-12", "a_venir", null],
      ]
    );
    assert.equal(suivi.actuelle?.valeur, 175_000);
    assert.equal(suivi.actuelle?.source, "en_cours");
    assert.equal(suivi.actuelle?.derniereOperation, "2026-11-12");
    assert.equal(suivi.atteinte.etat === "calcule" && Math.round(suivi.atteinte.fraction * 100), 58);
  });

  test("taux : recalculé sur les montants agrégés, jamais une somme de pourcentages", () => {
    const suivi = suivreKpi(kpi({ cle: "taux_marge_brute", cible: 48, reference: { valeur: 30, libelle: "T4 2025", origine: "equivalent", periode: null } }), { periode: T4 }, d, [], aujourdhui);
    // Octobre : 30/80 = 37,5 %. Octobre + novembre : (30 + 55) / (80 + 95) = 48,57 %.
    assert.equal(suivi.points[0].valeur, 37.5);
    assert.ok(Math.abs((suivi.points[1].valeur as number) - (85 / 175) * 100) < 1e-9);
    assert.notEqual(suivi.points[1].valeur, 37.5 + (55 / 95) * 100);
    assert.equal(suivi.atteinte.etat === "calcule" && suivi.atteinte.depasse, true);
  });

  test("les montants sont ceux du P&L du module Passé sur les mêmes dates", () => {
    const passe = calculerPnlEnBase(d.transactions.filter((t) => t.transactionDate >= T4.debut && t.transactionDate <= "2026-11-15"), AXE, mappings, [], "ht");
    const mesure = mesurerSurPeriode("marge_brute", d, { debut: T4.debut, fin: "2026-11-15" });
    assert.equal(mesure.valeur, passe.margeBrute);
  });

  test("point-in-time (BFR) : situations validées seulement, jamais cumulées", () => {
    const avecBfr = { ...d, situationsBfr: [{ date: "2026-10-31", bfr: 70_000 }] };
    const suivi = suivreKpi(kpi({ cle: "bfr", sens: "down", cible: 50_000, reference: { valeur: 80_000, libelle: "x", origine: "situation", periode: null } }), { periode: T4 }, avecBfr, [], aujourdhui);
    assert.deepEqual(suivi.points.map((p) => p.valeur), [70_000, null, null]);
    assert.match(suivi.points[1].raison ?? "", /pas encore validable/);
    assert.equal(suivi.actuelle?.source, "clos");
    assert.equal(suivi.atteinte.etat === "calcule" && Math.round(suivi.atteinte.fraction * 100), 33);
    const sansSeptembre = suivreKpi(kpi({ cle: "bfr", sens: "down", cible: 50_000 }), { periode: { debut: "2026-07-01", fin: "2026-12-31" } }, { ...d, situationsBfr: [{ date: "2026-07-31", bfr: 1 }] }, [], aujourdhui);
    assert.match(sansSeptembre.messages.join(" "), /Situation non validée : août 2026, septembre 2026, octobre 2026/);
  });

  test("KPI manuel : valeurs saisies, mois manquant sans valeur, source manuelle", () => {
    const k = kpi({ cle: CLE_PERSONNALISE, nomPersonnalise: "Délai de livraison", unitePersonnalisee: "jours", sens: "down", cible: 40, reference: { valeur: 60, libelle: "Saisie", origine: "manual", periode: null } });
    const suivi = suivreKpi(k, { periode: T4 }, d, [{ kpiId: k.id, mois: "2026-10", valeur: 48 }], aujourdhui);
    assert.deepEqual(suivi.points.map((p) => p.valeur), [48, null, null]);
    assert.equal(suivi.actuelle?.source, "manuel");
    assert.equal(suivi.atteinte.etat === "calcule" && Math.round(suivi.atteinte.fraction * 100), 60);
    assert.equal(formatEcartKpi(48 - 60, "libre", "jours"), "−12 jours");
  });

  test("chantier à venir : aucune valeur, état à venir", () => {
    const suivi = suivreKpi(kpi({ cle: "encaissements", cible: 1 }), { periode: { debut: "2027-01-01", fin: "2027-03-31" } }, d, [], aujourdhui);
    assert.equal(suivi.etat, "a_venir");
    assert.ok(suivi.points.every((p) => p.valeur === null));
  });

  test("historique insuffisant et données partielles signalés, jamais convertis en zéro", () => {
    const vide = suivreKpi(kpi({ cle: "encaissements", cible: 1 }), { periode: T4 }, donnees([]), [], aujourdhui);
    assert.equal(vide.etat, "insuffisant");
    assert.equal(vide.actuelle, null);
    assert.ok(vide.points.every((p) => p.valeur === null));

    const sansTva = { ...d, mappings: indexerMappings([mapping("ca", "revenue", null), mapping("achats", "gross_margin")]) };
    const partiel = suivreKpi(kpi({ cle: "encaissements", cible: 1 }), { periode: T4 }, sansTva, [], aujourdhui);
    assert.equal(partiel.etat, "partiel");
    assert.match(partiel.messages.join(" "), /TVA non renseignée/);

    const tauxSansCa = suivreKpi(kpi({ cle: "taux_marge_brute", cible: 40 }), { periode: T4 }, donnees([tx("2026-10-03", -500, "achats")]), [], aujourdhui);
    assert.equal(tauxSansCa.points[0].valeur, null);
    assert.match(tauxSansCa.points[0].raison ?? "", /Encaissements nuls/);
  });

  test("le cash flow opérationnel est lu en TTC, comme dans Novanta", () => {
    const tva = { ...d, mappings: indexerMappings([mapping("ca", "revenue", 20), mapping("achats", "gross_margin", 20)]) };
    const cash = mesurerSurPeriode("cash_flow_operationnel", tva, { debut: "2026-10-01", fin: "2026-10-31" });
    const ca = mesurerSurPeriode("encaissements", tva, { debut: "2026-10-01", fin: "2026-10-31" });
    assert.equal(cash.valeur, 30_000); // TTC : 80 000 − 50 000
    assert.ok(Math.abs((ca.valeur as number) - 80_000 / 1.2) < 1e-6); // HT estimé
  });
});

describe("Libellé de l'atteinte : progression métier, jamais « 123 % de l'objectif atteint »", () => {
  const texte = (depart: number, cible: number, realise: number, sens: "up" | "down") =>
    libelleAtteinte(calculerAtteinte(depart, cible, realise, sens), "ok").texte;

  test("sous l'objectif : 0 %, 25 %, 75 %, 99 %", () => {
    assert.equal(texte(20, 60, 20, "up"), "0\u00a0% de l'objectif atteint");
    assert.equal(texte(20, 60, 30, "up"), "25\u00a0% de l'objectif atteint");
    assert.equal(texte(20, 60, 50, "up"), "75\u00a0% de l'objectif atteint");
    assert.equal(texte(20, 60, 59.6, "up"), "99\u00a0% de l'objectif atteint");
    // 99,9 % ne s'affiche jamais « 100 % » : arrondi par défaut tant que la cible n'est pas atteinte.
    assert.equal(texte(20, 60, 59.96, "up"), "99\u00a0% de l'objectif atteint");
  });

  test("exactement à l'objectif : « Objectif atteint »", () => {
    assert.equal(texte(20, 60, 60, "up"), "Objectif atteint");
    assert.equal(texte(60, 40, 40, "down"), "Objectif atteint");
  });

  test("au-dessus : « Objectif dépassé de 5 % / 23 % »", () => {
    assert.equal(texte(20, 60, 62, "up"), "Objectif dépassé de 5\u00a0%");
    assert.equal(texte(20, 60, 69.2, "up"), "Objectif dépassé de 23\u00a0%");
    assert.equal(texte(20, 60, 76, "up"), "Objectif dépassé de 40\u00a0%");
    for (const t of [texte(20, 60, 69.2, "up"), texte(20, 60, 200, "up")]) assert.doesNotMatch(t, /de l'objectif atteint/);
  });

  test("plus bas = mieux : passer sous la cible est un dépassement, lu dans le même sens", () => {
    // DSO : référence 60 j, objectif 40 j, réalisé 35 j → progression 125 %.
    assert.equal(texte(60, 40, 35, "down"), "Objectif dépassé de 25\u00a0%");
    assert.equal(texte(60, 40, 45, "down"), "75\u00a0% de l'objectif atteint");
    // Plus haut = mieux, objectif 55 %, réalisé 62,9 % depuis 40 % : progression 153 %.
    assert.equal(texte(40, 55, 62.9, "up"), "Objectif dépassé de 53\u00a0%");
  });

  test("dégradation par rapport à la référence : recul signalé", () => {
    const up = libelleAtteinte(calculerAtteinte(30, 48, 26.4, "up"), "ok");
    assert.deepEqual(up, { texte: "−20\u00a0% : recul par rapport au point de départ", recul: true });
    const down = libelleAtteinte(calculerAtteinte(60, 40, 66, "down"), "ok");
    assert.equal(down.recul, true);
  });

  test("états sans calcul et maintien", () => {
    assert.equal(libelleAtteinte({ etat: "sans_reference" }, "ok").texte, "Atteinte non calculable : aucune référence");
    assert.equal(libelleAtteinte({ etat: "sans_valeur" }, "a_venir").texte, "Le suivi commence avec le chantier");
    const maintien: Atteinte = { etat: "maintien", atteint: true };
    assert.equal(libelleAtteinte(maintien, "ok").texte, "Objectif de maintien : tenu");
  });
});

describe("Référence nommée explicitement", () => {
  const ref = (origine: KpiChantier["reference"]["origine"], periode: { debut: string; fin: string } | null, libelle = "x", valeur = 20.7) => ({ valeur, libelle, origine, periode });

  test("trimestre exact (période équivalente et précédente)", () => {
    const eq = libellesReference(ref("equivalent", { debut: "2026-04-01", fin: "2026-06-30" }), "quarter", EXERCICE_PAR_DEFAUT);
    assert.deepEqual(eq, { court: "T2 2026", detail: "T2 2026 · même période un an plus tôt" });
    const prec = libellesReference(ref("previous", { debut: "2026-07-01", fin: "2026-09-30" }, "Trimestre précédent (T3 2026)"), "quarter", EXERCICE_PAR_DEFAUT);
    assert.deepEqual(prec, { court: "T3 2026", detail: "T3 2026 · trimestre précédent" });
  });

  test("exercice", () => {
    const eq = libellesReference(ref("equivalent", { debut: "2025-01-01", fin: "2025-12-31" }), "year", EXERCICE_PAR_DEFAUT);
    assert.equal(eq.court, "Exercice 2025");
    const decale = libellesReference(ref("previous", { debut: "2025-07-01", fin: "2026-06-30" }), "year", { mois: 7, jour: 1 });
    assert.equal(decale.court, "Exercice 2025-26");
  });

  test("moyenne historique", () => {
    const l = libellesReference(ref("indicative", { debut: "2026-06-01", fin: "2026-09-30" }, "Indicative : sur les 4 mois disponibles (juin–sept. 2026)"), "year", EXERCICE_PAR_DEFAUT);
    assert.equal(l.court, "la moyenne des 4 mois disponibles (juin–sept. 2026)");
    assert.equal(l.detail, "Indicative : sur les 4 mois disponibles (juin–sept. 2026)");
  });

  test("l'écart nomme la référence, jamais « depuis la référence »", () => {
    const t2 = libellesReference(ref("equivalent", { debut: "2026-04-01", fin: "2026-06-30" }), "quarter", EXERCICE_PAR_DEFAUT);
    assert.equal(libelleEcartReference(42.2, "pct", null, t2), "+42,2\u00a0pts vs T2 2026");
    assert.equal(libelleEcartReference(0, "pct", null, t2), "Stable vs T2 2026");
    const manuel = libellesReference(ref("manual", null, "Saisie au lancement", 60), "quarter", EXERCICE_PAR_DEFAUT);
    assert.equal(libelleEcartReference(-12, "libre", "jours", manuel), "−12\u00a0jours vs la valeur de départ");
    const bfr = libellesReference(ref("situation", { debut: "2026-06-30", fin: "2026-06-30" }, "Situation validée au 30 juin 2026"), "quarter", EXERCICE_PAR_DEFAUT);
    assert.match(libelleEcartReference(-14_000, "eur", null, bfr) ?? "", /vs la situation au 30 juin 2026$/);
    assert.equal(libelleEcartReference(5, "pct", null, libellesReference(SANS_REFERENCE, "quarter", EXERCICE_PAR_DEFAUT)), null);
  });
});

describe("Photographie de clôture", () => {
  const aujourdhui = "2026-11-15";
  const chantier: Chantier = {
    id: "c",
    titre: "Remonter la marge",
    changement: "Hausse des tarifs",
    typePeriode: "quarter",
    periode: T4,
    statut: "active",
    kpis: [
      kpi({ cle: "encaissements", cible: 300_000 }),
      kpi({ cle: "taux_marge_brute", position: 2, cible: 48, reference: { valeur: 30, libelle: "T4 2025", origine: "equivalent", periode: { debut: "2025-10-01", fin: "2025-12-31" } } }),
      kpi({ cle: CLE_PERSONNALISE, position: 3, nomPersonnalise: "Délai", unitePersonnalisee: "jours", sens: "down", cible: 40, reference: { valeur: 60, libelle: "Saisie", origine: "manual", periode: null } }),
    ],
  };
  const sources = donnees([...moisType("2026-10", 80_000, -50_000), ...moisType("2026-11", 95_000, -40_000)]);
  const manuelles = [{ kpiId: "k-custom", mois: "2026-10", valeur: 48 }];
  const cartes = () => chantier.kpis.map((k) => carteDuSuivi(suivreKpi(k, chantier, sources, manuelles, aujourdhui), "quarter", EXERCICE_PAR_DEFAUT));

  test("valeurs finales, séries mensuelles, atteinte, libellés et date de clôture conservés", () => {
    const photo = photographierChantier(chantier, cartes(), EXERCICE_PAR_DEFAUT, aujourdhui, "2026-11-15T10:00:00.000Z");
    assert.equal(photo.clotureLe, "2026-11-15T10:00:00.000Z");
    assert.equal(photo.arreteAu, aujourdhui);
    assert.equal(photo.libellePeriode, "T4 2026");
    assert.equal(photo.titre, "Remonter la marge");
    assert.equal(photo.changement, "Hausse des tarifs");
    assert.equal(photo.cartes[0].suivi.actuelle?.valeur, 175_000);
    assert.deepEqual(photo.cartes[0].suivi.points.map((p) => [p.statut, p.valeur]), [["clos", 80_000], ["en_cours", 175_000], ["a_venir", null]]);
    assert.equal(photo.cartes[1].reference.court, "T4 2025");
    assert.equal(photo.cartes[1].mention, "HT estimé");
    assert.equal(photo.cartes[2].suivi.kpi.unitePersonnalisee, "jours");
    assert.equal(photo.cartes[2].suivi.atteinte.etat === "calcule" && Math.round(photo.cartes[2].suivi.atteinte.fraction * 100), 60);
  });

  test("une modification ultérieure des données sources ne change pas la photographie", () => {
    const vivantes = cartes();
    const photo = photographierChantier(chantier, vivantes, EXERCICE_PAR_DEFAUT, aujourdhui, "2026-11-15T10:00:00.000Z");
    // Stockée en base puis relue (JSON), comme en production.
    const relue = lirePhotographie(JSON.parse(JSON.stringify(photo)));
    assert.ok(relue);
    // Plus tard : une écriture retraitée, un mapping changé, un nouvel état vivant.
    sources.transactions.push(tx("2026-10-20", 500_000, "ca"));
    vivantes[0].suivi.points[0].valeur = -1;
    const recalcule = suivreKpi(chantier.kpis[0], chantier, sources, manuelles, aujourdhui);
    assert.notEqual(recalcule.actuelle?.valeur, 175_000);
    assert.equal(relue!.cartes[0].suivi.actuelle?.valeur, 175_000);
    assert.equal(relue!.cartes[0].suivi.points[0].valeur, 80_000);
    assert.equal(photo.cartes[0].suivi.points[0].valeur, 80_000);
  });

  test("photographie illisible ou absente : jamais reconstituée", () => {
    assert.equal(lirePhotographie(null), null);
    assert.equal(lirePhotographie({ version: 2 }), null);
    assert.equal(lirePhotographie({ version: 1, titre: "x", clotureLe: "x", periode: T4, typePeriode: "quarter", cartes: [] }), null);
  });
});
