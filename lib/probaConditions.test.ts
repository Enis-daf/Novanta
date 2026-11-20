import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calibrerModele } from "./probaCalibration";
import { cleTiers, ObservationRetard } from "./probaHistorique";
import { ConditionMoteur, EvenementTresorerie, FiabiliteDate, FiabiliteMontant, LigneProbabiliste } from "./probaEvenements";
import { simuler, tirerFacteurMontant } from "./probaSimulation";
import { calculerIndicateurs } from "./probaIndicateurs";
import { creerAlea } from "./probaAlea";
import { decalerDateISO } from "./dates";

// Départ le 12/11/2026 : le 1er décembre est le jour 19, le 1er janvier le jour 50, le 1er février le jour 81.
const DEPART = "2026-11-12";
const J_DEC = 19;
const J_JAN = 50;
const J_FEV = 81;
const date = (jour: number) => decalerDateISO(DEPART, jour);

const modelesVides = () => ({ client: calibrerModele([], "client", DEPART), fournisseur: calibrerModele([], "fournisseur", DEPART) });

function observations(retards: number[], cote: "client" | "fournisseur" = "client"): ObservationRetard[] {
  return retards.map((retard, i) => ({
    cote,
    tiers: "Tiers",
    cleTiers: cleTiers("Tiers"),
    montant: 1_000,
    echeance: decalerDateISO("2026-06-01", i),
    dateReglement: decalerDateISO(decalerDateISO("2026-06-01", i), retard),
    retard,
  }));
}

function ligne(cle: string, autres: Partial<LigneProbabiliste> = {}): LigneProbabiliste {
  return { cle, probabilite: 100, condition: null, fiabiliteMontant: 100, modeDate: "echeance", aRenseigner: false, ...autres };
}

let n = 0;
function evt(cleLigne: string, jour: number, montant: number, autres: Partial<EvenementTresorerie> = {}): EvenementTresorerie {
  n++;
  return {
    id: `e${n}`,
    cleLigne,
    libelle: cleLigne,
    montant: Math.abs(montant),
    sens: montant >= 0 ? "encaissement" : "decaissement",
    datePrevue: date(jour),
    dateEcheance: null,
    fiabiliteDate: 100,
    tiers: null,
    etage: montant >= 0 ? "revenue" : null,
    ...autres,
  };
}

function finaux(sim: ReturnType<typeof simuler>): number[] {
  return Array.from({ length: sim.nombre }, (_, s) => sim.soldes[(sim.jours - 1) * sim.nombre + s]);
}

const seuil = (indicateur: "ca_mois_precedent" | "tresorerie" | "marge_brute_mois_precedent", valeur: number, comparateur: ">" | "<" = ">"): ConditionMoteur => ({
  type: "seuil",
  indicateur,
  comparateur,
  valeur,
});

// ---------------------------------------------------------------------------------------------
// Montants
// ---------------------------------------------------------------------------------------------

describe("Montants", () => {
  test("montant fixe : toujours exactement le montant saisi", () => {
    const sim = simuler({ soldeInitial: 0, dateDepart: DEPART, horizonJours: 30, lignes: [ligne("r")], evenements: [evt("r", 5, 80_000)], modeles: modelesVides(), nombreSimulations: 1_000 });
    assert.ok(finaux(sim).every((v) => v === 80_000));
  });

  for (const [fiabilite, ecart] of [
    [75, 0.1],
    [50, 0.25],
    [25, 0.5],
  ] as [FiabiliteMontant, number][]) {
    test(`montant variable (${fiabilite} %) : 8 cas sur 10 à ±${ecart * 100} % de la cible, centré sur la cible`, () => {
      const sim = simuler({
        soldeInitial: 0,
        dateDepart: DEPART,
        horizonJours: 30,
        lignes: [ligne("r", { fiabiliteMontant: fiabilite })],
        evenements: [evt("r", 5, 80_000)],
        modeles: modelesVides(),
        nombreSimulations: 20_000,
        graine: 2,
      });
      const ind = calculerIndicateurs(sim).serie.at(-1)!;
      assert.ok(Math.abs(ind.p50 - 80_000) / 80_000 < 0.02, `P50 ${ind.p50}`);
      assert.ok(Math.abs(ind.p10 - 80_000 * (1 - ecart)) / 80_000 < 0.03, `P10 ${ind.p10}`);
      assert.ok(Math.abs(ind.p90 - 80_000 * (1 + ecart)) / 80_000 < 0.03, `P90 ${ind.p90}`);
    });
  }

  test("rentrée régulière très incertaine : jamais de montant négatif ni nul", () => {
    const alea = creerAlea(3);
    for (let i = 0; i < 100_000; i++) assert.ok(tirerFacteurMontant(0.5, alea) > 0);
    const sim = simuler({
      soldeInitial: 0,
      dateDepart: DEPART,
      horizonJours: 90,
      lignes: [ligne("r", { fiabiliteMontant: 25, modeDate: "debut" })],
      evenements: [evt("r", 5, 80_000), evt("r", 35, 80_000), evt("r", 65, 80_000)],
      modeles: modelesVides(),
      nombreSimulations: 10_000,
    });
    assert.ok(finaux(sim).every((v) => v > 0));
  });

  test("un même facteur pour toutes les échéances d'une ligne", () => {
    const sim = simuler({
      soldeInitial: 0,
      dateDepart: DEPART,
      horizonJours: 60,
      lignes: [ligne("r", { fiabiliteMontant: 25 })],
      evenements: [evt("r", 5, 10_000), evt("r", 40, 10_000)],
      modeles: modelesVides(),
      nombreSimulations: 200,
    });
    for (let s = 0; s < sim.nombre; s++) {
      const premier = sim.soldes[10 * sim.nombre + s];
      const second = sim.soldes[50 * sim.nombre + s] - premier;
      assert.ok(Math.abs(premier - second) < 1e-6);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Conditions « Dépend de »
// ---------------------------------------------------------------------------------------------

describe("Dépend de : seuils métier", () => {
  // 150 000 € de CA en novembre ; recrutement de 4 500 €/mois à partir de décembre.
  const ca = evt("ca", 5, 150_000);
  const recrutement = (condition: ConditionMoteur, autres: Partial<LigneProbabiliste> = {}) => ({
    lignes: [ligne("ca"), ligne("rec", { condition, modeDate: "debut", ...autres })],
    evenements: [ca, evt("rec", J_DEC, -4_500), evt("rec", J_JAN, -4_500), evt("rec", J_FEV, -4_500)],
  });

  test("condition satisfaite : CA M-1 > 100 000 € -> la ligne existe", () => {
    const sim = simuler({ soldeInitial: 0, dateDepart: DEPART, horizonJours: 90, ...recrutement(seuil("ca_mois_precedent", 100_000)), modeles: modelesVides(), nombreSimulations: 500 });
    assert.equal(sim.partPresence.get("rec"), 1);
    assert.ok(finaux(sim).every((v) => v === 150_000 - 3 * 4_500));
  });

  test("condition non satisfaite : CA M-1 > 200 000 € -> la ligne n'existe pas", () => {
    const sim = simuler({ soldeInitial: 0, dateDepart: DEPART, horizonJours: 90, ...recrutement(seuil("ca_mois_precedent", 200_000)), modeles: modelesVides(), nombreSimulations: 500 });
    assert.equal(sim.partPresence.get("rec"), 0);
    assert.ok(finaux(sim).every((v) => v === 150_000));
  });

  test("la condition est évaluée dans chaque simulation : CA incertain à 50 %", () => {
    const sim = simuler({
      soldeInitial: 0,
      dateDepart: DEPART,
      horizonJours: 90,
      lignes: [ligne("ca", { probabilite: 50 }), ligne("rec", { condition: seuil("ca_mois_precedent", 100_000), modeDate: "debut" })],
      evenements: [ca, evt("rec", J_DEC, -4_500)],
      modeles: modelesVides(),
      nombreSimulations: 20_000,
      graine: 8,
    });
    const valeurs = new Set(finaux(sim));
    // Jamais de recrutement sans CA : les seuls soldes possibles sont 0 et 145 500.
    assert.deepEqual([...valeurs].sort((a, b) => a - b), [0, 145_500]);
    assert.ok(Math.abs((sim.partPresence.get("rec") ?? 0) - 0.5) < 0.02);
  });

  test("probabilité propre et condition se combinent", () => {
    const sim = simuler({
      soldeInitial: 0,
      dateDepart: DEPART,
      horizonJours: 90,
      ...recrutement(seuil("ca_mois_precedent", 100_000), { probabilite: 75 }),
      modeles: modelesVides(),
      nombreSimulations: 20_000,
      graine: 4,
    });
    assert.ok(Math.abs((sim.partPresence.get("rec") ?? 0) - 0.75) < 0.02);
  });

  test("trésorerie > seuil, évaluée la veille du démarrage", () => {
    const base = { lignes: [ligne("dep", { condition: seuil("tresorerie", 50_000) })], modeles: modelesVides(), nombreSimulations: 100, dateDepart: DEPART, horizonJours: 30 };
    assert.equal(simuler({ ...base, soldeInitial: 60_000, evenements: [evt("dep", 10, -5_000)] }).partPresence.get("dep"), 1);
    assert.equal(simuler({ ...base, soldeInitial: 40_000, evenements: [evt("dep", 10, -5_000)] }).partPresence.get("dep"), 0);
    // « inférieur à » : un découvert autorisé ne se tire que si la trésorerie est basse.
    const sous = { ...base, lignes: [ligne("dec", { condition: seuil("tresorerie", 10_000, "<") })] };
    assert.equal(simuler({ ...sous, soldeInitial: 5_000, evenements: [evt("dec", 10, 20_000)] }).partPresence.get("dec"), 1);
  });

  test("marge brute du mois précédent > 30 %", () => {
    const avecCouts = (couts: number) =>
      simuler({
        soldeInitial: 0,
        dateDepart: DEPART,
        horizonJours: 60,
        lignes: [ligne("ca"), ligne("achats"), ligne("prime", { condition: seuil("marge_brute_mois_precedent", 30) })],
        evenements: [evt("ca", 5, 100_000), evt("achats", 8, -couts, { etage: "gross_margin" }), evt("prime", J_DEC + 5, -2_000)],
        modeles: modelesVides(),
        nombreSimulations: 50,
      }).partPresence.get("prime");
    assert.equal(avecCouts(80_000), 0); // marge 20 %
    assert.equal(avecCouts(60_000), 1); // marge 40 %
  });

  test("événement conditionnel à date incertaine : condition évaluée au démarrage simulé", () => {
    const sim = simuler({
      soldeInitial: 0,
      dateDepart: DEPART,
      horizonJours: 120,
      lignes: [ligne("ca"), ligne("rec", { condition: seuil("ca_mois_precedent", 100_000), modeDate: "debut" })],
      evenements: [ca, evt("rec", J_DEC, -4_500, { fiabiliteDate: 50 as FiabiliteDate }), evt("rec", J_JAN, -4_500, { fiabiliteDate: 50 as FiabiliteDate })],
      // Moitié des démarrages à l'heure (décembre : CA de novembre connu), moitié 40 jours plus tard
      // (janvier : décembre sans CA, la condition échoue).
      modeles: { client: calibrerModele([], "client", DEPART), fournisseur: calibrerModele(observations([...Array(20).fill(0), ...Array(20).fill(40)], "fournisseur"), "fournisseur", DEPART) },
      nombreSimulations: 5_000,
      graine: 6,
    });
    const presence = sim.partPresence.get("rec") ?? 0;
    assert.ok(presence > 0.45 && presence < 0.65, `présence ${presence}`);
  });
});

describe("Dépend de : événement et dépendance temporelle", () => {
  test("à partir du mois suivant l'ouverture du site", () => {
    // Ouverture le 20 novembre (jour 8), certaine ; loyer prévu au 15 novembre -> démarre le 1er décembre.
    const sim = simuler({
      soldeInitial: 0,
      dateDepart: DEPART,
      horizonJours: 60,
      lignes: [ligne("site"), ligne("loyer", { condition: { type: "apres_evenement", parentCle: "site", decalageMois: 0 }, modeDate: "debut" })],
      evenements: [evt("site", 8, 1, { etage: null }), evt("loyer", 3, -2_000), evt("loyer", 33, -2_000)],
      modeles: modelesVides(),
      nombreSimulations: 10,
    });
    const s0 = (j: number) => sim.soldes[j * sim.nombre];
    assert.equal(s0(J_DEC - 1), 1);
    assert.equal(s0(J_DEC), 1 - 2_000);
    assert.equal(s0(J_DEC + 30), 1 - 4_000);
  });

  test("décalage de mois et parent incertain", () => {
    const sim = simuler({
      soldeInitial: 0,
      dateDepart: DEPART,
      horizonJours: 120,
      lignes: [ligne("site", { probabilite: 50 }), ligne("loyer", { condition: { type: "apres_evenement", parentCle: "site", decalageMois: 1 } })],
      evenements: [evt("site", 8, 1, { etage: null }), evt("loyer", 3, -2_000)],
      modeles: modelesVides(),
      nombreSimulations: 10_000,
      graine: 5,
    });
    assert.ok(Math.abs((sim.partPresence.get("loyer") ?? 0) - 0.5) < 0.02);
    for (let s = 0; s < sim.nombre; s++) {
      assert.equal(sim.soldes[(J_JAN - 1) * sim.nombre + s] < 0, false, "jamais avant le 1er janvier");
    }
  });
});

describe("Dates de début de série", () => {
  test("date de début certaine par défaut : la série reste à ses dates", () => {
    const sim = simuler({
      soldeInitial: 10_000,
      dateDepart: DEPART,
      horizonJours: 90,
      lignes: [ligne("sal", { modeDate: "debut" })],
      evenements: [evt("sal", J_DEC, -4_500), evt("sal", J_JAN, -4_500)],
      modeles: modelesVides(),
      nombreSimulations: 100,
    });
    assert.ok(finaux(sim).every((v) => v === 1_000));
    assert.equal(sim.soldes[(J_DEC - 1) * sim.nombre], 10_000);
  });

  test("début incertain : toute la série glisse d'un même décalage, la fréquence est conservée", () => {
    const sim = simuler({
      soldeInitial: 0,
      dateDepart: DEPART,
      horizonJours: 120,
      lignes: [ligne("sal", { modeDate: "debut" })],
      evenements: [evt("sal", J_DEC, -4_500, { fiabiliteDate: 50 }), evt("sal", J_JAN, -4_500, { fiabiliteDate: 50 })],
      modeles: { client: calibrerModele([], "client", DEPART), fournisseur: calibrerModele(observations([0, 5, 10, 15, 20, 25].flatMap((x) => Array(10).fill(x)), "fournisseur"), "fournisseur", DEPART) },
      nombreSimulations: 500,
      graine: 9,
    });
    const ecarts = new Set<number>();
    for (let s = 0; s < sim.nombre; s++) {
      const jours: number[] = [];
      for (let j = 1; j < sim.jours; j++) if (sim.soldes[j * sim.nombre + s] < sim.soldes[(j - 1) * sim.nombre + s]) jours.push(j);
      if (jours.length === 2) ecarts.add(jours[1] - jours[0]);
      assert.ok(jours[0] >= J_DEC);
    }
    assert.deepEqual([...ecarts], [J_JAN - J_DEC]);
  });
});
