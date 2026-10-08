import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  cleStockagePeriode,
  configExerciceValide,
  descriptionExercice,
  deserialiserSelection,
  EXERCICE_PAR_DEFAUT,
  getCurrentFiscalQuarterRange,
  getCurrentFiscalSemesterRange,
  getFiscalQuarterRange,
  getFiscalSemesterRange,
  getFiscalYearRange,
  getLastCompletedFiscalQuarterRange,
  getLastCompletedFiscalSemesterRange,
  getPreviousFiscalYearRange,
  jourMaxDebutExercice,
  normaliserConfigExercice,
  periodeDeLaSelection,
  periodeDuPreset,
  presetCorrespondant,
  PRESETS_PERIODE,
  selectionParDefaut,
  serialiserSelection,
} from "./fiscalPeriods";
import { periodeAnneeCivile } from "./pastTransactions";

const OCTOBRE = { mois: 10, jour: 1 };
const p = (debut: string, fin: string) => ({ debut, fin });

describe("exercice — celui qui contient la date du jour", () => {
  test("défaut 1er janvier : l'année civile, comme avant (aucun changement sans configuration)", () => {
    assert.deepEqual(EXERCICE_PAR_DEFAUT, { mois: 1, jour: 1 });
    for (const jour of ["2026-01-01", "2026-06-15", "2026-12-31"]) {
      assert.deepEqual(getFiscalYearRange(jour, EXERCICE_PAR_DEFAUT), periodeAnneeCivile(jour));
    }
  });

  test("début au 1er octobre : cas du 08/10/2026 et du 15/09/2026", () => {
    assert.deepEqual(getFiscalYearRange("2026-10-08", OCTOBRE), p("2026-10-01", "2027-09-30"));
    assert.deepEqual(getFiscalYearRange("2026-09-15", OCTOBRE), p("2025-10-01", "2026-09-30"));
  });

  test("les jours charnières tombent du bon côté", () => {
    assert.deepEqual(getFiscalYearRange("2026-09-30", OCTOBRE), p("2025-10-01", "2026-09-30"));
    assert.deepEqual(getFiscalYearRange("2026-10-01", OCTOBRE), p("2026-10-01", "2027-09-30"));
  });

  test("débuts au 1er avril et au 1er juillet, à cheval sur deux années civiles", () => {
    assert.deepEqual(getFiscalYearRange("2026-02-10", { mois: 4, jour: 1 }), p("2025-04-01", "2026-03-31"));
    assert.deepEqual(getFiscalYearRange("2026-08-10", { mois: 7, jour: 1 }), p("2026-07-01", "2027-06-30"));
  });

  test("exercice traversant février : la fin suit l'année bissextile", () => {
    const mars = { mois: 3, jour: 1 };
    assert.deepEqual(getFiscalYearRange("2027-06-01", mars), p("2027-03-01", "2028-02-29"));
    assert.deepEqual(getFiscalYearRange("2026-06-01", mars), p("2026-03-01", "2027-02-28"));
    assert.deepEqual(getFiscalYearRange("2028-02-29", OCTOBRE), p("2027-10-01", "2028-09-30"));
  });

  test("début en cours de mois", () => {
    assert.deepEqual(getFiscalYearRange("2026-05-01", { mois: 4, jour: 15 }), p("2026-04-15", "2027-04-14"));
    assert.deepEqual(getFiscalYearRange("2026-04-14", { mois: 4, jour: 15 }), p("2025-04-15", "2026-04-14"));
  });

  test("Exercice N-1 : l'exercice immédiatement précédent", () => {
    assert.deepEqual(getPreviousFiscalYearRange("2026-10-08", OCTOBRE), p("2025-10-01", "2026-09-30"));
    assert.deepEqual(getPreviousFiscalYearRange("2026-06-15", EXERCICE_PAR_DEFAUT), p("2025-01-01", "2025-12-31"));
  });
});

describe("semestres et trimestres — découpés dans l'exercice, pas dans l'année civile", () => {
  test("exercice au 1er octobre", () => {
    const jour = "2026-10-08";
    assert.deepEqual(getFiscalSemesterRange(jour, OCTOBRE, 1), p("2026-10-01", "2027-03-31"));
    assert.deepEqual(getFiscalSemesterRange(jour, OCTOBRE, 2), p("2027-04-01", "2027-09-30"));
    assert.deepEqual(getFiscalQuarterRange(jour, OCTOBRE, 1), p("2026-10-01", "2026-12-31"));
    assert.deepEqual(getFiscalQuarterRange(jour, OCTOBRE, 2), p("2027-01-01", "2027-03-31"));
    assert.deepEqual(getFiscalQuarterRange(jour, OCTOBRE, 3), p("2027-04-01", "2027-06-30"));
    assert.deepEqual(getFiscalQuarterRange(jour, OCTOBRE, 4), p("2027-07-01", "2027-09-30"));
  });

  test("exercice au 1er janvier : semestres et trimestres calendaires", () => {
    const jour = "2026-10-08";
    assert.deepEqual(getFiscalSemesterRange(jour, EXERCICE_PAR_DEFAUT, 1), p("2026-01-01", "2026-06-30"));
    assert.deepEqual(getFiscalSemesterRange(jour, EXERCICE_PAR_DEFAUT, 2), p("2026-07-01", "2026-12-31"));
    assert.deepEqual(getFiscalQuarterRange(jour, EXERCICE_PAR_DEFAUT, 1), p("2026-01-01", "2026-03-31"));
    assert.deepEqual(getFiscalQuarterRange(jour, EXERCICE_PAR_DEFAUT, 4), p("2026-10-01", "2026-12-31"));
  });

  test("les 4 trimestres et les 2 semestres couvrent l'exercice sans trou ni recouvrement", () => {
    for (const config of [EXERCICE_PAR_DEFAUT, OCTOBRE, { mois: 4, jour: 1 }, { mois: 7, jour: 1 }, { mois: 3, jour: 1 }, { mois: 12, jour: 28 }, { mois: 3, jour: 31 }, { mois: 9, jour: 30 }, { mois: 11, jour: 30 }, { mois: 10, jour: 31 }]) {
      for (const jour of ["2026-10-08", "2028-02-29"]) {
        const exercice = getFiscalYearRange(jour, config);
        const trimestres = ([1, 2, 3, 4] as const).map((t) => getFiscalQuarterRange(jour, config, t));
        const semestres = ([1, 2] as const).map((s) => getFiscalSemesterRange(jour, config, s));
        for (const tranches of [trimestres, semestres]) {
          assert.equal(tranches[0].debut, exercice.debut);
          assert.equal(tranches[tranches.length - 1].fin, exercice.fin);
          for (let i = 1; i < tranches.length; i++) {
            const lendemain = new Date(`${tranches[i - 1].fin}T00:00:00`);
            lendemain.setDate(lendemain.getDate() + 1);
            assert.equal(tranches[i].debut, `${lendemain.getFullYear()}-${String(lendemain.getMonth() + 1).padStart(2, "0")}-${String(lendemain.getDate()).padStart(2, "0")}`);
          }
        }
      }
    }
  });
});

describe("configuration d'exercice", () => {
  test("tout jour qui existe chaque année dans le mois est accepté", () => {
    for (const [mois, jour] of [[3, 30], [3, 31], [4, 30], [9, 30], [10, 31], [2, 28], [12, 31], [1, 1]]) {
      assert.equal(configExerciceValide({ mois, jour }), true, `${jour}/${mois}`);
    }
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(jourMaxDebutExercice), [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
  });

  test("une date qui n'existe pas tous les ans est refusée, sans repli implicite", () => {
    for (const [mois, jour] of [[4, 31], [6, 31], [9, 31], [11, 31], [2, 29], [2, 30], [2, 31], [1, 32], [1, 0]]) {
      assert.equal(configExerciceValide({ mois, jour }), false, `${jour}/${mois}`);
    }
    assert.equal(configExerciceValide({ mois: 13, jour: 1 }), false);
    assert.equal(configExerciceValide({ mois: 0, jour: 1 }), false);
    assert.equal(configExerciceValide({ mois: 1.5, jour: 1 }), false);
  });

  test("valeurs absentes ou invalides en base : retour au 1er janvier", () => {
    assert.deepEqual(normaliserConfigExercice(10, 1), OCTOBRE);
    assert.deepEqual(normaliserConfigExercice(undefined, undefined), EXERCICE_PAR_DEFAUT);
    assert.deepEqual(normaliserConfigExercice(2, 30), EXERCICE_PAR_DEFAUT);
    assert.deepEqual(normaliserConfigExercice(3, 31), { mois: 3, jour: 31 });
  });

  test("phrase de confirmation", () => {
    assert.equal(descriptionExercice(OCTOBRE), "Votre exercice va du 1er octobre au 30 septembre.");
    assert.equal(descriptionExercice(EXERCICE_PAR_DEFAUT), "Votre exercice va du 1er janvier au 31 décembre.");
    assert.equal(descriptionExercice({ mois: 3, jour: 1 }), "Votre exercice va du 1er mars au 28 février.");
  });
});

describe("périodes prédéfinies", () => {
  test("la liste est courte et dans l'ordre attendu", () => {
    assert.deepEqual(
      PRESETS_PERIODE.map((x) => x.libelle),
      ["Exercice", "Exercice N-1", "Semestre actuel", "S1", "S2", "Trimestre actuel", "Q1", "Q2", "Q3", "Q4"]
    );
  });

  test("premier usage : Exercice en cours — donc 01/01 → 31/12 sans configuration", () => {
    const selection = selectionParDefaut("2026-10-08", EXERCICE_PAR_DEFAUT);
    assert.equal(selection.choix, "exercice");
    assert.deepEqual(periodeDeLaSelection(selection, "2026-10-08", EXERCICE_PAR_DEFAUT), p("2026-01-01", "2026-12-31"));
  });

  test("changer le début d'exercice recalcule le preset actif, pas une période personnalisée", () => {
    const exercice = selectionParDefaut("2026-10-08", EXERCICE_PAR_DEFAUT);
    assert.deepEqual(periodeDeLaSelection(exercice, "2026-10-08", OCTOBRE), p("2026-10-01", "2027-09-30"));
    const libre = { choix: "personnalise" as const, personnalisee: p("2026-02-03", "2026-05-17") };
    assert.deepEqual(periodeDeLaSelection(libre, "2026-10-08", OCTOBRE), p("2026-02-03", "2026-05-17"));
  });

  test("une saisie manuelle n'est rattachée à un preset que si elle lui correspond exactement", () => {
    assert.equal(presetCorrespondant(p("2026-10-01", "2027-09-30"), "2026-10-08", OCTOBRE), "exercice");
    // Q2 désigne le dernier Q2 achevé : celui de l'exercice précédent, pas celui à venir.
    assert.equal(presetCorrespondant(p("2026-01-01", "2026-03-31"), "2026-10-08", OCTOBRE), "q2");
    assert.equal(presetCorrespondant(p("2027-01-01", "2027-03-31"), "2026-10-08", OCTOBRE), null);
    assert.equal(presetCorrespondant(p("2026-10-02", "2027-09-30"), "2026-10-08", OCTOBRE), null);
    assert.equal(presetCorrespondant(p("2026-10-01", "2027-09-29"), "2026-10-08", OCTOBRE), null);
  });

  test("chaque preset a des bornes distinctes", () => {
    const bornes = PRESETS_PERIODE.map(({ cle }) => JSON.stringify(periodeDuPreset(cle, "2026-10-08", OCTOBRE)));
    assert.equal(new Set(bornes).size, bornes.length);
  });
});

describe("dernière période utilisée — persistance locale par organisation", () => {
  test("une clé par organisation : la période de A ne devient jamais celle de B", () => {
    assert.equal(cleStockagePeriode("org-a"), "past_reporting_period_org-a");
    assert.notEqual(cleStockagePeriode("org-a"), cleStockagePeriode("org-b"));
  });

  test("aller-retour : preset et dates personnalisées sont restaurés à l'identique", () => {
    const libre = { choix: "personnalise" as const, personnalisee: p("2025-10-01", "2026-09-30") };
    assert.deepEqual(deserialiserSelection(serialiserSelection(libre)), libre);
    const preset = { choix: "s2" as const, personnalisee: p("2026-01-01", "2026-12-31") };
    assert.deepEqual(deserialiserSelection(serialiserSelection(preset)), preset);
  });

  test("un preset restauré suit le temps et la config, il ne fige pas d'anciennes dates", () => {
    const restauree = deserialiserSelection(serialiserSelection(selectionParDefaut("2026-09-15", OCTOBRE)))!;
    assert.deepEqual(periodeDeLaSelection(restauree, "2026-09-15", OCTOBRE), p("2025-10-01", "2026-09-30"));
    assert.deepEqual(periodeDeLaSelection(restauree, "2026-10-08", OCTOBRE), p("2026-10-01", "2027-09-30"));
  });

  test("stockage absent, illisible ou incohérent : ignoré, sans erreur", () => {
    for (const brut of [null, "", "pas du json", "{}", '{"choix":"inconnu","personnalisee":{"debut":"2026-01-01","fin":"2026-12-31"}}', '{"choix":"exercice","personnalisee":{"debut":"x","fin":"y"}}', '{"choix":"exercice"}']) {
      assert.equal(deserialiserSelection(brut), null);
    }
  });
});

describe("presets — « actuel » peut être incomplet, S1/S2/Q1-Q4 sont toujours achevés", () => {
  const NOVEMBRE = { mois: 11, jour: 1 };
  const preset = (cle: Parameters<typeof periodeDuPreset>[0], jour: string, config = NOVEMBRE) => periodeDuPreset(cle, jour, config);

  test("exemple complet : exercice 01/11 → 31/10, au 08/10/2026", () => {
    const jour = "2026-10-08";
    assert.deepEqual(preset("exercice", jour), p("2025-11-01", "2026-10-31"));
    assert.deepEqual(preset("trimestre_actuel", jour), p("2026-08-01", "2026-10-31"));
    assert.deepEqual(preset("semestre_actuel", jour), p("2026-05-01", "2026-10-31"));
    assert.deepEqual(preset("q1", jour), p("2025-11-01", "2026-01-31"));
    assert.deepEqual(preset("q2", jour), p("2026-02-01", "2026-04-30"));
    assert.deepEqual(preset("q3", jour), p("2026-05-01", "2026-07-31"));
    // Q4 et S2 de l'exercice courant ne sont pas terminés : on remonte à ceux de l'exercice précédent.
    assert.deepEqual(preset("q4", jour), p("2025-08-01", "2025-10-31"));
    assert.deepEqual(preset("s1", jour), p("2025-11-01", "2026-04-30"));
    assert.deepEqual(preset("s2", jour), p("2025-05-01", "2025-10-31"));
  });

  const configs = [
    { nom: "01/01", config: { mois: 1, jour: 1 }, annee: 2026 },
    { nom: "01/04", config: { mois: 4, jour: 1 }, annee: 2026 },
    { nom: "01/07", config: { mois: 7, jour: 1 }, annee: 2026 },
    { nom: "01/11", config: { mois: 11, jour: 1 }, annee: 2025 },
  ];
  const jourSuivant = (dateISO: string, jours = 1) => {
    const d = new Date(`${dateISO}T00:00:00`);
    d.setDate(d.getDate() + jours);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  for (const { nom, config, annee } of configs) {
    // Les 4 trimestres de l'exercice qui commence en `annee`.
    const debutExercice = `${annee}-${String(config.mois).padStart(2, "0")}-01`;
    const trimestres = ([1, 2, 3, 4] as const).map((t) => getFiscalQuarterRange(debutExercice, config, t));
    const semestres = ([1, 2] as const).map((s) => getFiscalSemesterRange(debutExercice, config, s));

    test(`exercice ${nom} : un Qx en cours n'est jamais renvoyé par le preset Qx`, () => {
      trimestres.forEach((trimestre, index) => {
        const numero = (index + 1) as 1 | 2 | 3 | 4;
        const precedent = getLastCompletedFiscalQuarterRange(trimestre.debut, config, numero);
        // Début, milieu et dernier jour du trimestre : il est en cours, on obtient celui d'un an avant.
        for (const jour of [trimestre.debut, jourSuivant(trimestre.debut, 40), trimestre.fin]) {
          assert.deepEqual(getLastCompletedFiscalQuarterRange(jour, config, numero), precedent, `${nom} Q${numero} au ${jour}`);
          assert.ok(precedent.fin < trimestre.debut);
          assert.deepEqual(getCurrentFiscalQuarterRange(jour, config), trimestre, `${nom} trimestre actuel au ${jour}`);
        }
        // Le lendemain de sa clôture, il devient le dernier Qx achevé.
        assert.deepEqual(getLastCompletedFiscalQuarterRange(jourSuivant(trimestre.fin), config, numero), trimestre, `${nom} Q${numero} clos`);
      });
    });

    test(`exercice ${nom} : même règle pour S1 / S2, et « Semestre actuel » contient aujourd'hui`, () => {
      semestres.forEach((semestre, index) => {
        const numero = (index + 1) as 1 | 2;
        for (const jour of [semestre.debut, jourSuivant(semestre.debut, 80), semestre.fin]) {
          const renvoye = getLastCompletedFiscalSemesterRange(jour, config, numero);
          assert.ok(renvoye.fin < jour, `${nom} S${numero} au ${jour} doit être achevé`);
          assert.notDeepEqual(renvoye, semestre);
          assert.deepEqual(getCurrentFiscalSemesterRange(jour, config), semestre);
        }
        assert.deepEqual(getLastCompletedFiscalSemesterRange(jourSuivant(semestre.fin), config, numero), semestre);
      });
    });
  }

  test("un preset achevé est toujours entièrement passé, un preset « actuel » contient toujours aujourd'hui", () => {
    for (const { config } of configs) {
      for (const jour of ["2026-01-01", "2026-03-31", "2026-04-01", "2026-06-30", "2026-10-08", "2026-12-31", "2028-02-29"]) {
        for (const cle of ["s1", "s2", "q1", "q2", "q3", "q4"] as const) {
          assert.ok(periodeDuPreset(cle, jour, config).fin < jour, `${cle} au ${jour}`);
        }
        for (const cle of ["exercice", "semestre_actuel", "trimestre_actuel"] as const) {
          const periode = periodeDuPreset(cle, jour, config);
          assert.ok(periode.debut <= jour && jour <= periode.fin, `${cle} au ${jour}`);
        }
      }
    }
  });
});

describe("début d'exercice en fin de mois", () => {
  test("exercice au 31 mars : il va du 31 mars au 30 mars, trimestres bornés aux fins de mois", () => {
    const config = { mois: 3, jour: 31 };
    assert.deepEqual(getFiscalYearRange("2026-10-08", config), p("2026-03-31", "2027-03-30"));
    assert.deepEqual(getFiscalYearRange("2026-03-30", config), p("2025-03-31", "2026-03-30"));
    assert.deepEqual(getFiscalQuarterRange("2026-10-08", config, 1), p("2026-03-31", "2026-06-29"));
    assert.deepEqual(getFiscalQuarterRange("2026-10-08", config, 2), p("2026-06-30", "2026-09-29"));
    assert.deepEqual(getFiscalQuarterRange("2026-10-08", config, 3), p("2026-09-30", "2026-12-30"));
    assert.deepEqual(getFiscalQuarterRange("2026-10-08", config, 4), p("2026-12-31", "2027-03-30"));
    assert.equal(descriptionExercice(config), "Votre exercice va du 31 mars au 30 mars.");
  });

  test("exercice au 30 septembre et au 31 octobre", () => {
    assert.deepEqual(getFiscalYearRange("2026-10-08", { mois: 9, jour: 30 }), p("2026-09-30", "2027-09-29"));
    assert.deepEqual(getFiscalYearRange("2026-10-08", { mois: 10, jour: 31 }), p("2025-10-31", "2026-10-30"));
    assert.deepEqual(getFiscalSemesterRange("2026-10-08", { mois: 10, jour: 31 }, 1), p("2025-10-31", "2026-04-29"));
  });

  test("une borne de trimestre qui tombe en février suit la longueur réelle du mois", () => {
    const config = { mois: 11, jour: 30 };
    assert.deepEqual(getFiscalQuarterRange("2027-12-15", config, 1), p("2027-11-30", "2028-02-28"));
    assert.deepEqual(getFiscalQuarterRange("2027-12-15", config, 2), p("2028-02-29", "2028-05-29"));
    assert.deepEqual(getFiscalQuarterRange("2026-12-15", config, 2), p("2027-02-28", "2027-05-29"));
  });
});
