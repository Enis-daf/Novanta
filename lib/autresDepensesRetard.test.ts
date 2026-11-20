import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calculerProjectionCash, listerFluxProjetes } from "./cash-engine";
import { calculerSyntheseMensuelle } from "./syntheseMensuelle";
import { calculerFluxPeriode, calculerPeriodeFiltre } from "./periodeFiltre";
import { construireReference } from "./fiabiliteProjection";
import { CORRESPONDANCE_VIDE } from "./futurPnl";
import { AutreDepense } from "./types";

/**
 * Autres dépenses en retard : une dépense ni Facturée ni Payée dont la date prévue précède le début
 * de la projection est projetée au PREMIER JOUR de la projection, jamais retirée. Sa date enregistrée
 * reste intacte. Facturée ou Payée l'exclut, comme avant.
 */

const DEBUT = "2026-11-11";
const HORIZON = 30;
const SOLDE = 100_000;

function depense(overrides: Partial<AutreDepense> = {}): AutreDepense {
  return {
    id: "ad-1",
    libelle: "Dépense",
    montant: 12_000,
    datePrevue: "2026-11-10",
    type: "certaine",
    facturee: false,
    payee: false,
    ...overrides,
  };
}

const VIDES = {
  facturesClients: [],
  facturesFournisseurs: [],
  chargesFixes: [],
  financements: [],
  rentreesRegulieres: [],
};

function projeter(autresDepenses: AutreDepense[]) {
  return calculerProjectionCash({ ...VIDES, soldeInitial: SOLDE, autresDepenses, dateDepart: DEBUT, horizonJours: HORIZON });
}

function fluxDepenses(autresDepenses: AutreDepense[]) {
  return listerFluxProjetes({ ...VIDES, autresDepenses, dateDepart: DEBUT, horizonJours: HORIZON }).filter((f) => f.source === "autre_depense");
}

function soldeLe(serie: { date: string; solde: number }[], date: string): number {
  const point = serie.find((p) => p.date === date);
  assert.ok(point, `pas de point au ${date}`);
  return point.solde;
}

describe("Autres dépenses en retard — date effective de projection", () => {
  test("Bug reproduit : 12 000 € prévus le 10/11, projection au 11/11 → la sortie compte le 11/11", () => {
    const res = projeter([depense()]);
    assert.equal(soldeLe(res.serie, "2026-11-11"), SOLDE - 12_000);
    assert.equal(res.pointBas, SOLDE - 12_000);
  });

  test("A. date 10/11, Facturée false, Payée false → projetée le 11/11", () => {
    assert.deepEqual(fluxDepenses([depense()]).map((f) => [f.date, f.montant]), [["2026-11-11", -12_000]]);
  });

  test("B. date 11/11 → projetée le 11/11", () => {
    assert.deepEqual(fluxDepenses([depense({ datePrevue: "2026-11-11" })]).map((f) => f.date), ["2026-11-11"]);
  });

  test("C. date 12/11 → projetée le 12/11", () => {
    assert.deepEqual(fluxDepenses([depense({ datePrevue: "2026-11-12" })]).map((f) => f.date), ["2026-11-12"]);
  });

  test("D. date passée, Facturée true, Payée false → aucune projection", () => {
    assert.deepEqual(fluxDepenses([depense({ facturee: true })]), []);
    assert.equal(projeter([depense({ facturee: true })]).pointBas, SOLDE);
  });

  test("E. date passée, Facturée false, Payée true → aucune projection", () => {
    assert.deepEqual(fluxDepenses([depense({ payee: true })]), []);
    assert.equal(projeter([depense({ payee: true })]).pointBas, SOLDE);
  });

  test("F. date passée, Facturée true, Payée true → aucune projection", () => {
    assert.deepEqual(fluxDepenses([depense({ facturee: true, payee: true })]), []);
  });

  test("Passage à Facturée puis à Payée : la dépense sort immédiatement, sans réapparaître", () => {
    const active = depense({ montant: 10_000 });
    assert.equal(projeter([active]).pointBas, SOLDE - 10_000);
    assert.equal(projeter([{ ...active, facturee: true }]).pointBas, SOLDE);
    assert.equal(projeter([{ ...active, payee: true }]).pointBas, SOLDE);
    assert.equal(projeter([{ ...active, facturee: true, payee: true }]).pointBas, SOLDE);
  });

  test("Sans date → règle actuelle conservée (aucun flux)", () => {
    assert.deepEqual(fluxDepenses([depense({ datePrevue: "" })]), []);
  });

  test("Au-delà de l'horizon → toujours hors projection", () => {
    assert.deepEqual(fluxDepenses([depense({ datePrevue: "2026-12-31" })]), []);
  });

  test("La date enregistrée n'est pas modifiée", () => {
    const d = depense();
    projeter([d]);
    assert.equal(d.datePrevue, "2026-11-10");
  });
});

describe("Autres dépenses en retard — accumulation et cohérence des consommateurs", () => {
  const echues = [
    depense({ id: "a", montant: 20_000, datePrevue: "2026-11-10" }),
    depense({ id: "b", montant: 15_000, datePrevue: "2026-10-20" }),
    depense({ id: "c", montant: 5_000, datePrevue: "2026-09-01", type: "probable" }),
  ];
  const aVenir = depense({ id: "d", montant: 3_000, datePrevue: "2026-11-25" });

  test("G. 3 dépenses échues (20k + 15k + 5k) → −40k au premier jour", () => {
    const flux = fluxDepenses(echues);
    assert.deepEqual(flux.map((f) => f.date), ["2026-11-11", "2026-11-11", "2026-11-11"]);
    assert.equal(flux.reduce((s, f) => s + f.montant, 0), -40_000);
    assert.equal(soldeLe(projeter(echues).serie, "2026-11-11"), SOLDE - 40_000);
  });

  test("H. le point bas intègre bien les 40k", () => {
    const res = projeter([...echues, aVenir]);
    assert.equal(soldeLe(res.serie, "2026-11-24"), SOLDE - 40_000);
    assert.equal(res.pointBas, SOLDE - 43_000);
    assert.equal(res.dateDuPointBas, "2026-11-25");
  });

  test("I. cohérence moteur / KPIs / courbe / synthèse mensuelle / filtre de période / référence", () => {
    const depenses = [...echues, aVenir];
    const res = projeter(depenses);
    const totalMoteur = res.soldeJ90 - SOLDE;
    assert.equal(totalMoteur, -43_000);

    const synthese = calculerSyntheseMensuelle({ ...VIDES, dateReleve: DEBUT, horizonJours: HORIZON, autresDepenses: depenses });
    const ligne = synthese.lignes.find((l) => l.libelle === "Autres dépenses")!;
    assert.equal(ligne.total, totalMoteur);
    assert.deepEqual(
      synthese.mois.map((m, i) => [m.cle, ligne.montantsParMois[i]]),
      [
        ["2026-11", -43_000],
        ["2026-12", 0],
      ]
    );

    // Clic sur le premier jour de la courbe : la fenêtre montre les 40k en retard.
    const periode = calculerPeriodeFiltre(DEBUT, DEBUT, HORIZON)!;
    const fluxPeriode = calculerFluxPeriode({ ...VIDES, debut: periode.debut, fin: periode.fin, dateDepart: DEBUT, autresDepenses: depenses });
    assert.equal(fluxPeriode.resume.sorties, -40_000);
    assert.deepEqual([...fluxPeriode.idsAutresDepenses.keys()].sort(), ["a", "b", "c"]);

    // Prévision de référence (fiabilité) : même moteur, même règle au premier jour de la période.
    const reference = construireReference(
      { ...VIDES, autresDepenses: depenses },
      { type: "month", debut: "2026-11-01", fin: "2026-11-30" },
      CORRESPONDANCE_VIDE
    );
    assert.deepEqual(reference.lignes.filter((l) => l.date === "2026-11-01").map((l) => l.sourceId).sort(), ["b", "c"]);
    assert.equal(reference.totaux.decaissements, 43_000);
  });
});
