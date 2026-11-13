import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calculerProjectionCash, listerFluxProjetes } from "./cash-engine";
import { calculerSyntheseMensuelle } from "./syntheseMensuelle";
import { calculerFluxPeriode, calculerPeriodeFiltre } from "./periodeFiltre";
import { construireReference } from "./fiabiliteProjection";
import { CORRESPONDANCE_VIDE } from "./futurPnl";
import { FactureFournisseur } from "./types";

/**
 * Factures fournisseurs en retard : une facture non payée et non litigieuse dont la date de paiement
 * (prévue, à défaut l'échéance) précède le début de la projection est projetée au PREMIER JOUR de la
 * projection, jamais retirée. Sa date enregistrée reste intacte.
 */

const DEBUT = "2026-11-11";
const HORIZON = 30;
const SOLDE = 100_000;

function facture(overrides: Partial<FactureFournisseur> = {}): FactureFournisseur {
  return {
    id: "ff-1",
    facture: "F-1",
    fournisseur: "Fournisseur",
    montant: 20_000,
    dateEcheance: "2026-11-10",
    datePaiementPrevue: "2026-11-10",
    litigieuse: false,
    payee: false,
    paidAt: null,
    ...overrides,
  };
}

const VIDES = {
  facturesClients: [],
  chargesFixes: [],
  autresDepenses: [],
  financements: [],
  rentreesRegulieres: [],
};

function projeter(facturesFournisseurs: FactureFournisseur[]) {
  return calculerProjectionCash({ ...VIDES, soldeInitial: SOLDE, facturesFournisseurs, dateDepart: DEBUT, horizonJours: HORIZON });
}

function fluxFournisseurs(facturesFournisseurs: FactureFournisseur[]) {
  return listerFluxProjetes({ ...VIDES, facturesFournisseurs, dateDepart: DEBUT, horizonJours: HORIZON }).filter(
    (f) => f.source === "facture_fournisseur"
  );
}

function soldeLe(serie: { date: string; solde: number }[], date: string): number {
  const point = serie.find((p) => p.date === date);
  assert.ok(point, `pas de point au ${date}`);
  return point.solde;
}

describe("Factures fournisseurs en retard — date effective de projection", () => {
  test("Bug reproduit : 20 000 € prévus le 10/11, projection au 11/11 → la sortie compte le 11/11", () => {
    const res = projeter([facture()]);
    assert.equal(soldeLe(res.serie, "2026-11-11"), SOLDE - 20_000);
    assert.equal(res.pointBas, SOLDE - 20_000);
    assert.equal(res.soldeJ90, SOLDE - 20_000);
  });

  test("A. paiement prévu 10/11, Payée false → projetée le 11/11", () => {
    assert.deepEqual(
      fluxFournisseurs([facture()]).map((f) => [f.date, f.montant]),
      [["2026-11-11", -20_000]]
    );
  });

  test("B. paiement prévu 11/11 → projetée le 11/11", () => {
    assert.deepEqual(
      fluxFournisseurs([facture({ datePaiementPrevue: "2026-11-11" })]).map((f) => f.date),
      ["2026-11-11"]
    );
  });

  test("C. paiement prévu 12/11 → projetée le 12/11", () => {
    assert.deepEqual(
      fluxFournisseurs([facture({ datePaiementPrevue: "2026-11-12" })]).map((f) => f.date),
      ["2026-11-12"]
    );
  });

  test("D. paiement prévu 10/11, Payée true → aucune projection", () => {
    assert.deepEqual(fluxFournisseurs([facture({ payee: true, paidAt: "2026-11-10T09:00:00Z" })]), []);
    assert.equal(projeter([facture({ payee: true })]).pointBas, SOLDE);
  });

  test("E. paiement prévu 10/11, Litigieuse true → aucune projection", () => {
    assert.deepEqual(fluxFournisseurs([facture({ litigieuse: true })]), []);
    assert.equal(projeter([facture({ litigieuse: true })]).pointBas, SOLDE);
  });

  test("F. pas de paiement prévu, échéance 05/11 → projetée au début de la simulation", () => {
    assert.deepEqual(
      fluxFournisseurs([facture({ datePaiementPrevue: "", dateEcheance: "2026-11-05", montant: 8_000 })]).map((f) => [
        f.date,
        f.montant,
      ]),
      [["2026-11-11", -8_000]]
    );
  });

  test("G. échéance 01/11, paiement prévu 20/11 → projetée le 20/11 (pas en retard pour le moteur)", () => {
    assert.deepEqual(
      fluxFournisseurs([facture({ dateEcheance: "2026-11-01", datePaiementPrevue: "2026-11-20" })]).map((f) => f.date),
      ["2026-11-20"]
    );
  });

  test("Sans date de paiement prévue ni échéance → règle actuelle conservée (aucun flux)", () => {
    assert.deepEqual(fluxFournisseurs([facture({ datePaiementPrevue: "", dateEcheance: "" })]), []);
  });

  test("Au-delà de l'horizon → toujours hors projection", () => {
    assert.deepEqual(fluxFournisseurs([facture({ datePaiementPrevue: "2026-12-31" })]), []);
  });

  test("La date enregistrée de la facture n'est pas modifiée", () => {
    const f = facture();
    projeter([f]);
    assert.equal(f.datePaiementPrevue, "2026-11-10");
    assert.equal(f.dateEcheance, "2026-11-10");
  });
});

describe("Factures fournisseurs en retard — accumulation et cohérence des consommateurs", () => {
  const echues = [
    facture({ id: "a", montant: 20_000, datePaiementPrevue: "2026-11-10" }),
    facture({ id: "b", montant: 15_000, datePaiementPrevue: "2026-10-02" }),
    facture({ id: "c", montant: 30_000, datePaiementPrevue: "", dateEcheance: "2026-09-15" }),
  ];
  const aVenir = facture({ id: "d", montant: 5_000, datePaiementPrevue: "2026-11-20" });

  test("H. 3 factures échues (20k + 15k + 30k) → 65k de décaissement le premier jour", () => {
    const flux = fluxFournisseurs(echues);
    assert.deepEqual(flux.map((f) => f.date), ["2026-11-11", "2026-11-11", "2026-11-11"]);
    assert.equal(flux.reduce((s, f) => s + f.montant, 0), -65_000);
    assert.equal(soldeLe(projeter(echues).serie, "2026-11-11"), SOLDE - 65_000);
  });

  test("I. le point bas intègre bien les 65k", () => {
    const res = projeter([...echues, aVenir]);
    assert.equal(res.pointBas, SOLDE - 65_000 - 5_000);
    assert.equal(res.dateDuPointBas, "2026-11-20");
    assert.equal(soldeLe(res.serie, "2026-11-19"), SOLDE - 65_000);
  });

  test("J. cohérence moteur / KPIs / courbe / synthèse mensuelle / filtre de période / référence", () => {
    const factures = [...echues, aVenir];
    const res = projeter(factures);
    const totalMoteur = res.soldeJ90 - SOLDE;
    assert.equal(totalMoteur, -70_000);

    const synthese = calculerSyntheseMensuelle({ ...VIDES, dateReleve: DEBUT, horizonJours: HORIZON, facturesFournisseurs: factures });
    const ligne = synthese.lignes.find((l) => l.libelle === "Factures fournisseurs")!;
    assert.equal(ligne.total, totalMoteur);
    assert.deepEqual(
      synthese.mois.map((m, i) => [m.cle, ligne.montantsParMois[i]]),
      [
        ["2026-11", -70_000],
        ["2026-12", 0],
      ]
    );

    // Clic sur le premier jour de la courbe : fenêtre 11/11..14/11, qui doit montrer les 65k.
    const periode = calculerPeriodeFiltre(DEBUT, DEBUT, HORIZON)!;
    const fluxPeriode = calculerFluxPeriode({ ...VIDES, debut: periode.debut, fin: periode.fin, dateDepart: DEBUT, facturesFournisseurs: factures });
    assert.equal(fluxPeriode.resume.sorties, -65_000);
    assert.deepEqual([...fluxPeriode.idsFacturesFournisseurs.keys()].sort(), ["a", "b", "c"]);

    // Somme des fenêtres du filtre couvrant tout l'horizon = total du moteur.
    let totalFenetres = 0;
    for (let i = 0; i <= HORIZON; i += 7) {
      const debutFenetre = new Date(2026, 10, 11 + i);
      const finFenetre = new Date(2026, 10, 11 + Math.min(i + 6, HORIZON));
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      totalFenetres += calculerFluxPeriode({ ...VIDES, debut: iso(debutFenetre), fin: iso(finFenetre), dateDepart: DEBUT, facturesFournisseurs: factures }).resume.sorties;
    }
    assert.equal(totalFenetres, totalMoteur);

    // Prévision de référence (fiabilité) : même moteur, même règle au premier jour de la période.
    const reference = construireReference(
      { ...VIDES, facturesFournisseurs: factures },
      { type: "month", debut: "2026-11-01", fin: "2026-11-30" },
      CORRESPONDANCE_VIDE
    );
    const premierJour = reference.lignes.filter((l) => l.date === "2026-11-01");
    // b (02/10) et c (15/09) sont échues au 01/11 ; a (10/11) et d (20/11) gardent leur date.
    assert.deepEqual(premierJour.map((l) => l.sourceId).sort(), ["b", "c"]);
    assert.equal(reference.totaux.decaissements, 70_000);
  });
});
