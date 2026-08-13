import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calculerProjectionCash } from "./cash-engine";
import { calculerSyntheseMensuelle } from "./syntheseMensuelle";
import { ChargeFixe, RentreeReguliere } from "./types";

function chargeFixe(overrides: Partial<ChargeFixe> = {}): ChargeFixe {
  return {
    id: "charge-1",
    libelle: "Charge",
    montant: 0,
    datePrevue: "2026-01-01",
    recurrence: "mensuel",
    dateFin: null,
    modeMontant: "fixe",
    tauxCalcul: null,
    sourceCalculId: null,
    sourceCalculType: null,
    ...overrides,
  };
}

function rentree(overrides: Partial<RentreeReguliere> = {}): RentreeReguliere {
  return {
    id: "rentree-1",
    libelle: "Rentree",
    montant: 0,
    dateDebut: "2026-01-01",
    frequence: "quotidien",
    dateFin: null,
    modeMontant: "fixe",
    profilSaisonnalite: null,
    ...overrides,
  };
}

const PARAMS_VIDES = {
  facturesClients: [],
  facturesFournisseurs: [],
  autresDepenses: [],
  financements: [],
};

describe("calculerProjectionCash — impact du montant calculé sur le moteur (KPIs, courbe)", () => {
  test("une charge calculée hebdomadaire (40% de CA quotidien) débite bien 2800 à sa 2e occurrence", () => {
    const ca = rentree({ id: "ca", libelle: "CA", montant: 1000, dateDebut: "2026-01-01", frequence: "quotidien" });
    const ads = chargeFixe({
      id: "ads",
      libelle: "Ads",
      datePrevue: "2026-01-01",
      recurrence: "hebdomadaire",
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });

    const resultat = calculerProjectionCash({
      ...PARAMS_VIDES,
      soldeInitial: 0,
      chargesFixes: [ads],
      rentreesRegulieres: [ca],
      dateDepart: "2026-01-01",
      horizonJours: 30,
    });

    const soldeAvant7 = resultat.serie.find((p) => p.date === "2026-01-07")!.solde;
    const soldeApres8 = resultat.serie.find((p) => p.date === "2026-01-08")!.solde;
    // Le débit de 2800 (occurrence hebdomadaire à J8, période complète) tombe précisément à J8,
    // pas avant, pas après.
    assert.equal(soldeApres8 - soldeAvant7, 1000 - 2800); // +1000 de CA le jour même, -2800 d'Ads
  });

  test("horizon 90 jours et 180 jours : les deux se recalculent sans erreur et 180j contient plus d'occurrences calculées", () => {
    const ca = rentree({ id: "ca", montant: 1000, dateDebut: "2026-01-01", frequence: "quotidien" });
    const abo = chargeFixe({
      id: "abo",
      datePrevue: "2026-01-01",
      recurrence: "mensuel",
      modeMontant: "calcule",
      tauxCalcul: 10,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });

    const resultat90 = calculerProjectionCash({
      ...PARAMS_VIDES,
      soldeInitial: 10000,
      chargesFixes: [abo],
      rentreesRegulieres: [ca],
      dateDepart: "2026-01-01",
      horizonJours: 90,
    });
    const resultat180 = calculerProjectionCash({
      ...PARAMS_VIDES,
      soldeInitial: 10000,
      chargesFixes: [abo],
      rentreesRegulieres: [ca],
      dateDepart: "2026-01-01",
      horizonJours: 180,
    });

    assert.equal(resultat90.serie.length, 91);
    assert.equal(resultat180.serie.length, 181);
    // Sur un horizon plus long, plus d'occurrences mensuelles sont débitées : le solde final
    // à J180 doit refléter davantage de débits qu'à J90 (le CA quotidien croît plus vite que
    // les débits mensuels à 10%, donc le solde J180 doit rester cohérent, pas planter/NaN).
    assert.equal(Number.isFinite(resultat90.soldeJ90), true);
    assert.equal(Number.isFinite(resultat180.soldeJ90), true);
  });

  test("charge calculée basée sur une autre charge fixe (non calculée), mensuel -> mensuel", () => {
    const salaires = chargeFixe({
      id: "salaires",
      libelle: "Salaires",
      montant: 10000,
      datePrevue: "2026-01-01",
      recurrence: "mensuel",
      modeMontant: "fixe",
    });
    const chargesSociales = chargeFixe({
      id: "cs",
      libelle: "Charges sociales",
      datePrevue: "2026-01-01",
      recurrence: "mensuel",
      modeMontant: "calcule",
      tauxCalcul: 45,
      sourceCalculId: "salaires",
      sourceCalculType: "charge_fixe",
    });

    const resultat = calculerProjectionCash({
      ...PARAMS_VIDES,
      soldeInitial: 0,
      chargesFixes: [salaires, chargesSociales],
      rentreesRegulieres: [],
      dateDepart: "2026-01-01",
      horizonJours: 60,
    });

    const soldeJ1 = resultat.serie.find((p) => p.date === "2026-01-01")!.solde;
    assert.equal(soldeJ1, -10000 - 4500); // les deux débitent le 1er janvier
  });

  test("source sans montant exploitable (taux non renseigné) : occurrence exclue, pas de plantage", () => {
    const ca = rentree({ id: "ca", montant: 1000, dateDebut: "2026-01-01", frequence: "quotidien" });
    const chargeIncomplete = chargeFixe({
      datePrevue: "2026-01-01",
      recurrence: "hebdomadaire",
      modeMontant: "calcule",
      tauxCalcul: null,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });

    const resultat = calculerProjectionCash({
      ...PARAMS_VIDES,
      soldeInitial: 5000,
      chargesFixes: [chargeIncomplete],
      rentreesRegulieres: [ca],
      dateDepart: "2026-01-01",
      horizonJours: 30,
    });

    // Seul le CA doit apparaître ; la charge incomplète ne débite jamais rien.
    const soldeFinal = resultat.serie[resultat.serie.length - 1].solde;
    assert.equal(soldeFinal, 5000 + 1000 * 31); // 31 jours de CA (1er janv. -> 31 janv. inclus sur horizon 30j)
  });
});

describe("calculerProjectionCash — Rentrée régulière saisonnalisée (directe et comme source de Charge calculée)", () => {
  test("une rentrée saisonnalisée directe débite le bon mois : août = 15% de 1 200 000", () => {
    const ca = rentree({
      id: "ca",
      libelle: "CA",
      dateDebut: "2026-01-01",
      frequence: "mensuel",
      modeMontant: "saisonnalise",
      profilSaisonnalite: {
        montantAnnuel: 1200000,
        ponderationsMensuelles: [8, 8, 8, 8, 8, 8, 10, 15, 8, 8, 8, 3],
      },
    });

    const resultat = calculerProjectionCash({
      ...PARAMS_VIDES,
      soldeInitial: 0,
      chargesFixes: [],
      rentreesRegulieres: [ca],
      dateDepart: "2026-01-01",
      horizonJours: 365,
    });

    const soldeJuillet31 = resultat.serie.find((p) => p.date === "2026-07-31")!.solde;
    const soldeAout1 = resultat.serie.find((p) => p.date === "2026-08-01")!.solde;
    assert.equal(soldeAout1 - soldeJuillet31, 180000); // 15% x 1 200 000, débité pile le 1er août
  });

  test("horizon exact : si l'horizon commence en août, juillet n'est jamais intégré", () => {
    const ca = rentree({
      id: "ca",
      dateDebut: "2025-01-01", // profil actif bien avant l'horizon
      frequence: "mensuel",
      modeMontant: "saisonnalise",
      profilSaisonnalite: {
        montantAnnuel: 1200000,
        ponderationsMensuelles: [8, 8, 8, 8, 8, 8, 10, 15, 8, 8, 8, 3],
      },
    });

    const resultat = calculerProjectionCash({
      ...PARAMS_VIDES,
      soldeInitial: 0,
      chargesFixes: [],
      rentreesRegulieres: [ca],
      dateDepart: "2026-08-01",
      horizonJours: 30, // couvre uniquement août (+ 1er sept.)
    });

    const fluxJuillet = resultat.serie.find((p) => p.date === "2026-07-01");
    assert.equal(fluxJuillet, undefined); // juillet est avant l'horizon : jamais dans la série
    const soldeJ0 = resultat.serie[0].solde;
    assert.equal(soldeJ0, 180000); // uniquement l'occurrence d'août (15%), pas juillet (10%)
  });

  test("Charge calculée dépendant d'une source saisonnalisée : la courbe reflète les deux flux, mois par mois", () => {
    const ca = rentree({
      id: "ca",
      libelle: "CA",
      dateDebut: "2026-01-01",
      frequence: "mensuel",
      modeMontant: "saisonnalise",
      profilSaisonnalite: {
        montantAnnuel: 1200000,
        ponderationsMensuelles: [8, 8, 8, 8, 8, 8, 10, 15, 8, 8, 8, 3],
      },
    });
    const ads = chargeFixe({
      id: "ads",
      libelle: "Ads",
      datePrevue: "2026-01-01",
      recurrence: "mensuel",
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });

    const resultat = calculerProjectionCash({
      ...PARAMS_VIDES,
      soldeInitial: 0,
      chargesFixes: [ads],
      rentreesRegulieres: [ca],
      dateDepart: "2026-01-01",
      horizonJours: 365,
    });

    const soldeJuillet31 = resultat.serie.find((p) => p.date === "2026-07-31")!.solde;
    const soldeAout1 = resultat.serie.find((p) => p.date === "2026-08-01")!.solde;
    // +180 000 de CA, -72 000 d'Ads (40% de 180 000), le même jour.
    assert.equal(soldeAout1 - soldeJuillet31, 180000 - 72000);
  });

  test("modification du montant annuel de la source : recalcule immédiatement la courbe et le point bas", () => {
    const chargesFixesEtRentrees = (montantAnnuel: number) => ({
      ca: rentree({
        id: "ca",
        dateDebut: "2026-01-01",
        frequence: "mensuel",
        modeMontant: "saisonnalise",
        profilSaisonnalite: { montantAnnuel, ponderationsMensuelles: [8, 8, 8, 8, 8, 8, 10, 15, 8, 8, 8, 3] },
      }),
    });

    const { ca: caAvant } = chargesFixesEtRentrees(1200000);
    const { ca: caApres } = chargesFixesEtRentrees(2000000);

    const resultatAvant = calculerProjectionCash({
      ...PARAMS_VIDES,
      soldeInitial: 0,
      chargesFixes: [],
      rentreesRegulieres: [caAvant],
      dateDepart: "2026-01-01",
      horizonJours: 240,
    });
    const resultatApres = calculerProjectionCash({
      ...PARAMS_VIDES,
      soldeInitial: 0,
      chargesFixes: [],
      rentreesRegulieres: [caApres],
      dateDepart: "2026-01-01",
      horizonJours: 240,
    });

    assert.notEqual(resultatAvant.pointBas, resultatApres.pointBas);
    assert.ok(resultatApres.soldeJ90 > resultatAvant.soldeJ90); // montant annuel plus élevé -> solde final plus élevé
  });

  test("horizon 90 jours et 180 jours avec source saisonnalisée : les deux se recalculent sans erreur", () => {
    const ca = rentree({
      id: "ca",
      dateDebut: "2026-01-01",
      frequence: "mensuel",
      modeMontant: "saisonnalise",
      profilSaisonnalite: { montantAnnuel: 1200000, ponderationsMensuelles: [8, 8, 8, 8, 8, 8, 10, 15, 8, 8, 8, 3] },
    });
    const ads = chargeFixe({
      id: "ads",
      datePrevue: "2026-01-01",
      recurrence: "mensuel",
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });

    const resultat90 = calculerProjectionCash({
      ...PARAMS_VIDES,
      soldeInitial: 0,
      chargesFixes: [ads],
      rentreesRegulieres: [ca],
      dateDepart: "2026-01-01",
      horizonJours: 90,
    });
    const resultat180 = calculerProjectionCash({
      ...PARAMS_VIDES,
      soldeInitial: 0,
      chargesFixes: [ads],
      rentreesRegulieres: [ca],
      dateDepart: "2026-01-01",
      horizonJours: 180,
    });

    assert.equal(resultat90.serie.length, 91);
    assert.equal(resultat180.serie.length, 181);
    assert.equal(Number.isFinite(resultat90.soldeJ90), true);
    assert.equal(Number.isFinite(resultat180.soldeJ90), true);
  });
});

describe("calculerSyntheseMensuelle — agrégation mensuelle avec le montant calculé", () => {
  test("répartit correctement 31 jours de CA en janvier et 28 en février (charge mensuelle 10%)", () => {
    const ca = rentree({ id: "ca", montant: 1000, dateDebut: "2025-01-01", frequence: "quotidien" });
    const abo = chargeFixe({
      id: "abo",
      libelle: "Abonnement",
      datePrevue: "2026-01-01",
      recurrence: "mensuel",
      modeMontant: "calcule",
      tauxCalcul: 10,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });

    const resultat = calculerSyntheseMensuelle({
      ...PARAMS_VIDES,
      dateReleve: "2026-01-01",
      horizonJours: 90,
      chargesFixes: [abo],
      rentreesRegulieres: [ca],
    });

    const ligneCharges = resultat.lignes.find((l) => l.libelle === "Charges fixes")!;
    const indexJanvier = resultat.mois.findIndex((m) => m.cle === "2026-01");
    const indexFevrier = resultat.mois.findIndex((m) => m.cle === "2026-02");
    // La charge est payée le 1er de chaque mois (comme toute charge mensuelle), donc le débit
    // représentant la période de janvier (31 jours) apparaît dans la colonne de FÉVRIER (date
    // de paiement réelle : 1er février) — même logique de bucketing par date que le reste du
    // moteur. La toute première occurrence (1er janvier, période partielle d'1 seul jour de CA)
    // apparaît elle dans la colonne de janvier.
    assert.equal(ligneCharges.montantsParMois[indexFevrier], -3100); // 10% x 31000 (janvier, 31 jours)
    assert.equal(ligneCharges.montantsParMois[indexJanvier], -100); // 10% x 1000 (1er janvier seul)
  });

  test("source saisonnalisée + charge calculée dépendante : les deux restent dans leurs catégories existantes", () => {
    const ca = rentree({
      id: "ca",
      libelle: "CA",
      dateDebut: "2026-01-01",
      frequence: "mensuel",
      modeMontant: "saisonnalise",
      profilSaisonnalite: { montantAnnuel: 1200000, ponderationsMensuelles: [8, 8, 8, 8, 8, 8, 10, 15, 8, 8, 8, 3] },
    });
    const ads = chargeFixe({
      id: "ads",
      libelle: "Ads",
      datePrevue: "2026-01-01",
      recurrence: "mensuel",
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });

    const resultat = calculerSyntheseMensuelle({
      ...PARAMS_VIDES,
      dateReleve: "2026-01-01",
      horizonJours: 365,
      chargesFixes: [ads],
      rentreesRegulieres: [ca],
    });

    // Aucune nouvelle catégorie "Saisonnières" : uniquement les 6 lignes habituelles.
    assert.deepEqual(
      resultat.lignes.map((l) => l.libelle),
      ["Factures clients", "Rentrées régulières", "Financements", "Factures fournisseurs", "Charges fixes", "Autres dépenses"]
    );

    const ligneRentrees = resultat.lignes.find((l) => l.libelle === "Rentrées régulières")!;
    const ligneCharges = resultat.lignes.find((l) => l.libelle === "Charges fixes")!;
    const indexAout = resultat.mois.findIndex((m) => m.cle === "2026-08");
    assert.equal(ligneRentrees.montantsParMois[indexAout], 180000);
    assert.equal(ligneCharges.montantsParMois[indexAout], -72000);
  });
});
