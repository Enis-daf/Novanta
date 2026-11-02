import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EXERCICE_PAR_DEFAUT } from "./fiscalPeriods";
import { exercicesProposes, libelleExercice, moisProposes, planRapport, resumeDuPlan } from "./pastPdfPeriodes";

const AVRIL = { mois: 4, jour: 1 };

describe("Rapport PDF — export d'un mois terminé", () => {
  const plan = planRapport({ type: "mois", mois: "2026-09" }, "2026-10-15", EXERCICE_PAR_DEFAUT);

  test("P&L sur le mois, BFR au dernier jour du mois, écarts contre le mois précédent", () => {
    assert.equal(plan.libelle, "Septembre 2026");
    assert.deepEqual(plan.periode, { debut: "2026-09-01", fin: "2026-09-30" });
    assert.equal(plan.enCours, false);
    assert.equal(plan.libellePnl, "septembre 2026");
    assert.deepEqual(plan.bfr, { mois: "2026-09", date: "2026-09-30", dernierMoisComplet: false });
    assert.equal(plan.libelleBfr, "situation au 30 septembre 2026");
    assert.deepEqual(plan.ecarts.b, { debut: "2026-09-01", fin: "2026-09-30" });
    assert.deepEqual(plan.ecarts.a, { debut: "2026-08-01", fin: "2026-08-31" });
    assert.equal(plan.ecarts.libelle, "Septembre 2026 vs août 2026");
    assert.equal(plan.ecarts.portion, false);
  });

  test("janvier se compare à décembre de l'année précédente ; mars à février (bissextile)", () => {
    assert.deepEqual(planRapport({ type: "mois", mois: "2026-01" }, "2026-10-15", EXERCICE_PAR_DEFAUT).ecarts.a, { debut: "2025-12-01", fin: "2025-12-31" });
    assert.deepEqual(planRapport({ type: "mois", mois: "2028-03" }, "2028-10-15", EXERCICE_PAR_DEFAUT).ecarts.a, { debut: "2028-02-01", fin: "2028-02-29" });
  });

  test("le résumé est construit à partir des dates réellement utilisées", () => {
    assert.deepEqual(resumeDuPlan(plan), [
      "Reporting P&L : septembre 2026",
      "BFR : situation au 30 septembre 2026",
      "Analyse d'écarts : Septembre 2026 vs août 2026 (01/09/2026 → 30/09/2026 vs 01/08/2026 → 31/08/2026)",
    ]);
  });
});

describe("Rapport PDF — export du mois en cours", () => {
  const plan = planRapport({ type: "mois", mois: "2026-10" }, "2026-10-15", EXERCICE_PAR_DEFAUT);

  test("P&L à date, BFR au dernier mois complet, dit explicitement", () => {
    assert.equal(plan.enCours, true);
    assert.equal(plan.libellePnl, "octobre 2026, à date (15/10/2026)");
    assert.deepEqual(plan.bfr, { mois: "2026-09", date: "2026-09-30", dernierMoisComplet: true });
    assert.equal(plan.libelleBfr, "situation au 30 septembre 2026, dernier mois complet disponible");
  });

  test("écarts : le mois à date contre la même portion du mois précédent, jamais un mois entier", () => {
    assert.deepEqual(plan.ecarts.b, { debut: "2026-10-01", fin: "2026-10-15" });
    assert.deepEqual(plan.ecarts.a, { debut: "2026-09-01", fin: "2026-09-15" });
    assert.equal(plan.ecarts.portion, true);
    assert.equal(plan.ecarts.libelle, "Octobre 2026 à date vs même portion de septembre 2026");
  });

  test("un 31 se compare au dernier jour d'un mois plus court", () => {
    const mars = planRapport({ type: "mois", mois: "2026-03" }, "2026-03-31", EXERCICE_PAR_DEFAUT);
    assert.deepEqual(mars.ecarts.a, { debut: "2026-02-01", fin: "2026-02-28" });
  });
});

describe("Rapport PDF — export d'un exercice terminé", () => {
  test("exercice civil : P&L sur l'année, BFR au 31/12, écarts contre l'exercice précédent", () => {
    const plan = planRapport({ type: "exercice", debut: "2025-01-01" }, "2026-10-15", EXERCICE_PAR_DEFAUT);
    assert.equal(plan.libelle, "Exercice 2025");
    assert.deepEqual(plan.periode, { debut: "2025-01-01", fin: "2025-12-31" });
    assert.equal(plan.enCours, false);
    assert.deepEqual(plan.bfr, { mois: "2025-12", date: "2025-12-31", dernierMoisComplet: false });
    assert.equal(plan.libelleBfr, "situation au 31 décembre 2025");
    assert.deepEqual(plan.ecarts.a, { debut: "2024-01-01", fin: "2024-12-31" });
    assert.equal(plan.ecarts.libelle, "Exercice 2025 vs exercice 2024");
  });

  test("exercice décalé (1er avril) : deux exercices fiscaux successifs, BFR au 31 mars", () => {
    const plan = planRapport({ type: "exercice", debut: "2025-04-01" }, "2026-10-15", AVRIL);
    assert.equal(plan.libelle, "Exercice 2025/2026");
    assert.deepEqual(plan.periode, { debut: "2025-04-01", fin: "2026-03-31" });
    assert.deepEqual(plan.bfr, { mois: "2026-03", date: "2026-03-31", dernierMoisComplet: false });
    assert.deepEqual(plan.ecarts.a, { debut: "2024-04-01", fin: "2025-03-31" });
    assert.equal(plan.ecarts.libelle, "Exercice 2025/2026 vs exercice 2024/2025");
  });

  test("exercice au 15 avril : la dernière fin de mois DANS l'exercice est le 31 mars", () => {
    const plan = planRapport({ type: "exercice", debut: "2025-04-15" }, "2026-10-15", { mois: 4, jour: 15 });
    assert.deepEqual(plan.periode, { debut: "2025-04-15", fin: "2026-04-14" });
    assert.equal(plan.bfr?.date, "2026-03-31");
  });
});

describe("Rapport PDF — export de l'exercice en cours", () => {
  test("BFR au dernier mois complet ; écarts contre la même portion de l'exercice précédent", () => {
    const plan = planRapport({ type: "exercice", debut: "2026-04-01" }, "2026-10-31", AVRIL);
    assert.equal(plan.enCours, true);
    assert.equal(plan.libellePnl, "exercice 2026/2027, à date (31/10/2026)");
    assert.deepEqual(plan.bfr, { mois: "2026-09", date: "2026-09-30", dernierMoisComplet: true });
    assert.deepEqual(plan.ecarts.b, { debut: "2026-04-01", fin: "2026-10-31" });
    assert.deepEqual(plan.ecarts.a, { debut: "2025-04-01", fin: "2025-10-31" });
    assert.equal(plan.ecarts.portion, true);
  });

  test("le 29 février se compare au 28 février de l'année précédente", () => {
    const plan = planRapport({ type: "exercice", debut: "2028-01-01" }, "2028-02-29", EXERCICE_PAR_DEFAUT);
    assert.deepEqual(plan.ecarts.a, { debut: "2027-01-01", fin: "2027-02-28" });
  });

  test("exercice commencé ce mois-ci : aucune fin de mois terminée, pas de BFR fabriqué", () => {
    const plan = planRapport({ type: "exercice", debut: "2026-10-01" }, "2026-10-15", { mois: 10, jour: 1 });
    assert.equal(plan.bfr, null);
    assert.equal(resumeDuPlan(plan)[1], "BFR : non disponible — aucune fin de mois terminée sur la période");
  });
});

describe("Rapport PDF — périodes proposées", () => {
  test("mois : du mois en cours à celui de la première donnée", () => {
    assert.deepEqual(moisProposes("2026-07-12", "2026-10-15"), ["2026-10", "2026-09", "2026-08", "2026-07"]);
    assert.deepEqual(moisProposes(null, "2026-10-15"), ["2026-10"]);
  });

  test("exercices : selon le début d'exercice réel de l'organisation", () => {
    assert.deepEqual(
      exercicesProposes("2024-06-01", "2026-10-15", AVRIL).map(libelleExercice),
      ["Exercice 2026/2027", "Exercice 2025/2026", "Exercice 2024/2025"]
    );
    assert.deepEqual(exercicesProposes("2025-03-01", "2026-10-15", EXERCICE_PAR_DEFAUT).map(libelleExercice), ["Exercice 2026", "Exercice 2025"]);
  });
});
