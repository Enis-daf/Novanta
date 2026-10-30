import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { declencheurPlanifie, estCommence, etatExercice, ExerciceComptable, LIMITE_EXERCICES_INDISPONIBLES, LIMITE_STATUT_AMBIGU, lectureProvisoire, moisEntre, perimetreExceptionnel, perimetreSynchro, perimetresStock } from "./comptaExercices";

const E = (idSource: string, debut: string, fin: string, statut: string | null): ExerciceComptable => ({ idSource, debut, fin, statut });
const AUJOURDHUI = "2026-10-30";
const E2025 = E("25", "2025-01-01", "2025-12-31", "open");
const E2026 = E("26", "2026-01-01", "2026-12-31", "open");
const E2027 = E("27", "2027-01-01", "2027-12-31", "open");

describe("Statuts d'exercice", () => {
  test("seul closed vaut clôture ; open et reopen restent ouverts ; le reste est ambigu", () => {
    assert.equal(etatExercice("closed"), "cloture");
    assert.equal(etatExercice("open"), "non_cloture");
    assert.equal(etatExercice("reopen"), "non_cloture");
    assert.equal(etatExercice("frozen"), "ambigu");
    assert.equal(etatExercice(null), "ambigu");
    assert.equal(etatExercice("inconnu"), "ambigu");
  });

  test("un exercice futur n'est pas commencé", () => {
    assert.equal(estCommence(E2027, AUJOURDHUI), false);
    assert.equal(estCommence(E2026, AUJOURDHUI), true);
  });
});

describe("Périmètre d'une synchronisation", () => {
  test("quotidien : mois en cours et précédent", () => {
    assert.deepEqual(perimetreSynchro("quotidien", [E2025, E2026], AUJOURDHUI).mois, ["2026-09", "2026-10"]);
  });

  test("quotidien en janvier : le mois précédent appartient à l'exercice d'avant", () => {
    assert.deepEqual(perimetreSynchro("quotidien", [E2025, E2026], "2026-01-15").mois, ["2025-12", "2026-01"]);
  });

  test("quotidien en janvier, exercice précédent clôturé : décembre n'est pas relu", () => {
    assert.deepEqual(perimetreSynchro("quotidien", [{ ...E2025, statut: "closed" }, E2026], "2026-01-15").mois, ["2026-01"]);
  });

  test("hebdomadaire, exercice courant ouvert : du début de l'exercice à aujourd'hui", () => {
    const { mois } = perimetreSynchro("hebdomadaire", [E2026], AUJOURDHUI);
    assert.equal(mois[0], "2026-01");
    assert.equal(mois[mois.length - 1], "2026-10");
    assert.equal(mois.length, 10);
  });

  test("hebdomadaire, plusieurs exercices ouverts : tous, sans doublon ni trou", () => {
    const { mois } = perimetreSynchro("hebdomadaire", [E2025, E2026], AUJOURDHUI);
    assert.equal(mois.length, 22);
    assert.equal(new Set(mois).size, 22);
    assert.equal(mois[0], "2025-01");
  });

  test("manuel : même périmètre que l'hebdomadaire", () => {
    assert.deepEqual(perimetreSynchro("manuel", [E2025, E2026], AUJOURDHUI).mois, perimetreSynchro("hebdomadaire", [E2025, E2026], AUJOURDHUI).mois);
  });

  test("exercice futur ouvert : aucun de ses mois n'est lu", () => {
    assert.ok(perimetreSynchro("hebdomadaire", [E2026, E2027], AUJOURDHUI).mois.every((m) => m <= "2026-10"));
  });

  test("jamais de mois à venir, même dans l'exercice en cours", () => {
    assert.ok(!perimetreSynchro("manuel", [E2026], AUJOURDHUI).mois.includes("2026-11"));
  });

  test("exercice clôturé : conservé, non relu", () => {
    const { mois } = perimetreSynchro("hebdomadaire", [{ ...E2025, statut: "closed" }, E2026], AUJOURDHUI);
    assert.ok(mois.every((m) => m >= "2026-01"));
  });

  test("un exercice ouvert ancien reste lu : l'âge ne vaut pas clôture", () => {
    assert.ok(perimetreSynchro("hebdomadaire", [E("20", "2020-01-01", "2020-12-31", "open")], AUJOURDHUI).mois.includes("2020-06"));
  });

  test("statut ambigu : lu quand même, et signalé", () => {
    const p = perimetreSynchro("hebdomadaire", [{ ...E2025, statut: "frozen" }, E2026], AUJOURDHUI);
    assert.ok(p.mois.includes("2025-06"));
    assert.deepEqual(p.limites, [LIMITE_STATUT_AMBIGU]);
  });

  test("exercices illisibles : mois récents seulement, et signalé", () => {
    const p = perimetreSynchro("hebdomadaire", null, AUJOURDHUI);
    assert.deepEqual(p.mois, ["2026-09", "2026-10"]);
    assert.deepEqual(p.limites, [LIMITE_EXERCICES_INDISPONIBLES]);
  });

  test("resynchronisation exceptionnelle : l'exercice désigné, même clôturé, sans mois à venir", () => {
    assert.equal(perimetreExceptionnel({ ...E2025, statut: "closed" }, AUJOURDHUI).mois.length, 12);
    assert.equal(perimetreExceptionnel(E2026, AUJOURDHUI).mois.length, 10);
  });

  test("exercice décalé à cheval sur deux années", () => {
    const { mois } = perimetreSynchro("hebdomadaire", [E("x", "2025-07-01", "2026-06-30", "open")], "2025-09-10");
    assert.deepEqual(mois, ["2025-07", "2025-08", "2025-09"]);
  });

  test("mois entre deux dates", () => {
    assert.deepEqual(moisEntre("2025-11-15", "2026-02-01"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
});

describe("Cadence planifiée", () => {
  const maintenant = new Date("2026-10-30T02:30:00Z");

  test("jamais lu entièrement : hebdomadaire", () => {
    assert.equal(declencheurPlanifie(null, maintenant), "hebdomadaire");
  });

  test("lecture complète récente : quotidien", () => {
    assert.equal(declencheurPlanifie("2026-10-28T02:30:00Z", maintenant), "quotidien");
  });

  test("7 jours révolus, ou passage manqué : hebdomadaire dès ce passage", () => {
    assert.equal(declencheurPlanifie("2026-10-23T02:30:00Z", maintenant), "hebdomadaire");
    assert.equal(declencheurPlanifie("2026-10-01T00:00:00Z", maintenant), "hebdomadaire");
  });
});

describe("Comptabilité provisoire", () => {
  const periode = { debut: "2026-01-01", fin: "2026-03-31" };

  test("exercice ouvert : provisoire", () => {
    assert.deepEqual(lectureProvisoire(periode, [E2026]), { provisoire: true, ambigu: false });
  });

  test("exercice clôturé : non provisoire", () => {
    assert.deepEqual(lectureProvisoire(periode, [{ ...E2026, statut: "closed" }]), { provisoire: false, ambigu: false });
  });

  test("période à cheval sur un exercice clôturé et un ouvert : provisoire", () => {
    assert.equal(lectureProvisoire({ debut: "2025-11-01", fin: "2026-02-28" }, [{ ...E2025, statut: "closed" }, E2026]).provisoire, true);
  });

  test("exercice inconnu ou statut non documenté : provisoire et ambigu, jamais clôturé par déduction", () => {
    assert.deepEqual(lectureProvisoire(periode, []), { provisoire: true, ambigu: true });
    assert.deepEqual(lectureProvisoire(periode, [{ ...E2026, statut: "frozen" }]), { provisoire: true, ambigu: true });
  });
});

describe("Périmètres de décision des stocks", () => {
  test("l'exercice entier, même pour un seul mois affiché", () => {
    assert.deepEqual(perimetresStock({ debut: "2026-02-01", fin: "2026-02-28" }, [E2026]).map((p) => [p.debut, p.fin]), [["2026-01-01", "2026-12-31"]]);
  });

  test("à cheval : un périmètre par exercice", () => {
    assert.equal(perimetresStock({ debut: "2025-11-01", fin: "2026-02-28" }, [E2025, E2026]).length, 2);
  });

  test("sans exercice connu : année civile, explicitement", () => {
    const [p] = perimetresStock({ debut: "2026-02-01", fin: "2026-02-28" }, []);
    assert.deepEqual([p.debut, p.fin, p.exercice], ["2026-01-01", "2026-12-31", false]);
  });
});
