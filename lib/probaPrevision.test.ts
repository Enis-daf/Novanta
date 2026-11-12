import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { creerAlea } from "./probaAlea";
import {
  calibrerModele,
  CONFIG_CALIBRATION,
  echantillonneurPour,
  poidsPour,
  profilPaiement,
  quantileTrie,
  statistiquesRetard,
  traiterValeursExtremes,
} from "./probaCalibration";
import { cleTiers, construireHistorique, ObservationRetard, retardObserve } from "./probaHistorique";
import { construireEvenements, descendants, EvenementTresorerie, FiabiliteDate, LigneProbabiliste, ordonnerLignes } from "./probaEvenements";
import { NOMBRE_SIMULATIONS_PAR_DEFAUT, simuler, simulerJour } from "./probaSimulation";
import { calculerIndicateurs, periodesDeTension, quantileConservateur } from "./probaIndicateurs";
import { FactureBfr } from "./pastBfr";
import { decalerDateISO } from "./dates";
import { validerHypothese, validerRequeteSimulation } from "./probaApi";
import { capacitesDeLOffre } from "./offres";

const AUJOURDHUI = "2026-11-12";
const DEPART = "2026-11-12";

// ---------------------------------------------------------------------------------------------
// Aides
// ---------------------------------------------------------------------------------------------

function observations(retards: number[], tiers = "Client Alpha", montant = 1_000, cote: "client" | "fournisseur" = "client"): ObservationRetard[] {
  return retards.map((retard, i) => ({
    cote,
    tiers,
    cleTiers: cleTiers(tiers),
    montant,
    echeance: decalerDateISO("2026-06-01", i),
    dateReglement: decalerDateISO(decalerDateISO("2026-06-01", i), retard),
    retard,
  }));
}

const repete = (valeurs: number[], fois: number) => Array.from({ length: fois }, () => valeurs).flat();

const modeleVide = (cote: "client" | "fournisseur") => calibrerModele([], cote, AUJOURDHUI);

function modeles(client: ObservationRetard[] = [], fournisseur: ObservationRetard[] = []) {
  return { client: calibrerModele(client, "client", AUJOURDHUI), fournisseur: calibrerModele(fournisseur, "fournisseur", AUJOURDHUI) };
}

let numero = 0;
function evenement(champs: Partial<EvenementTresorerie> & { cleLigne?: string } = {}): EvenementTresorerie {
  numero++;
  return {
    id: `e${numero}`,
    cleLigne: champs.cleLigne ?? `l${numero}`,
    libelle: "Événement",
    montant: 1_000,
    sens: "encaissement",
    datePrevue: decalerDateISO(DEPART, 10),
    dateEcheance: null,
    fiabiliteDate: 100,
    tiers: null,
    ...champs,
  };
}

const ligne = (cle: string, probabilite = 100, parentCle: string | null = null): LigneProbabiliste => ({ cle, probabilite, parentCle });

/** Une simulation à un seul événement ; renvoie la part des simulations où il est encaissé avant l'horizon. */
function partEncaissee(probabilite: number, n = 20_000, graine = 7): number {
  const e = evenement({ cleLigne: "l", montant: 100 });
  const sim = simuler({
    soldeInitial: 0,
    dateDepart: DEPART,
    horizonJours: 30,
    lignes: [ligne("l", probabilite)],
    evenements: [e],
    modeles: modeles(),
    nombreSimulations: n,
    graine,
  });
  let encaisse = 0;
  for (let s = 0; s < sim.nombre; s++) if (sim.soldes[(sim.jours - 1) * sim.nombre + s] > 0) encaisse++;
  return encaisse / sim.nombre;
}

/** Retards simulés (en jours après la date prévue) d'un encaissement selon sa fiabilité. */
function retardsSimules(modele: ReturnType<typeof modeleVide>, fiabilite: FiabiliteDate, tiers: string | null = null, n = 20_000): number[] {
  const alea = creerAlea(11);
  const facteur = { 100: 0, 75: 0.5, 50: 1, 25: 2 }[fiabilite];
  const ech = echantillonneurPour(modele, tiers, 1_000);
  const resultat: number[] = [];
  for (let i = 0; i < n; i++) resultat.push(simulerJour({ jourPrevu: 0, jourBase: 0, facteur, echantillonneur: ech }, alea));
  return resultat.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------------
// Historique
// ---------------------------------------------------------------------------------------------

describe("Historique des retards", () => {
  test("retard = max(0, règlement − échéance) : un paiement anticipé n'est jamais un retard négatif", () => {
    assert.equal(retardObserve("2026-10-01", "2026-10-16"), 15);
    assert.equal(retardObserve("2026-10-01", "2026-09-20"), 0);
    assert.equal(retardObserve("2026-10-01", "2026-10-01"), 0);
  });

  test("factures Pennylane et Futur fusionnées sans double compte, factures sans échéance écartées", () => {
    const pennylane: FactureBfr = {
      pennylaneId: "p1",
      type: "client",
      numero: "F1",
      tiers: "ACME",
      dateEmission: "2026-08-01",
      echeance: "2026-09-01",
      devise: "EUR",
      montantTtc: 1_200,
      montantHt: 1_000,
      resteTtc: 0,
      resteHt: 0,
      exclusion: null,
      factureAvoireeId: null,
      reglements: [{ date: "2026-09-21", montant: 1_200 }],
    };
    const historique = construireHistorique(
      [pennylane, { ...pennylane, pennylaneId: "p2", echeance: null }],
      {
        clients: [
          { tiers: "ACME", montant: 1_200, dateEcheance: "2026-09-01", settledOn: "2026-09-21", pennylaneId: "p1" }, // déjà connue
          { tiers: "Dupont", montant: 500, dateEcheance: "2026-10-01", settledOn: "2026-10-04", pennylaneId: null },
          { tiers: "Dupont", montant: 500, dateEcheance: "2026-10-01", settledOn: null, pennylaneId: null }, // pas réglée
        ],
        fournisseurs: [],
      },
      AUJOURDHUI
    );
    assert.deepEqual(
      historique.client.map((o) => [o.tiers, o.retard]),
      [
        ["ACME", 20],
        ["Dupont", 3],
      ]
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------------------------

describe("Profil de paiement", () => {
  test("statistiques du profil", () => {
    const stats = statistiquesRetard([0, 0, 5, 10, 40, 70])!;
    assert.equal(stats.nombre, 6);
    assert.equal(stats.retardMedian, 7.5);
    assert.equal(stats.partALHeure, 0.3333);
    assert.equal(stats.partPlus7, 0.5);
    assert.equal(stats.partPlus30, 0.3333);
    assert.equal(stats.partPlus60, 0.1667);
    assert.equal(stats.retardMax, 70);
    assert.ok(stats.p95 >= stats.p90 && stats.p90 >= stats.p75 && stats.p75 >= stats.p50);
  });

  test("un retard extrême isolé est écrêté ; une longue traîne récurrente est conservée", () => {
    const isole = traiterValeursExtremes([...repete([2, 3, 4, 5], 5), 90]);
    assert.equal(isole.ecretees, 1);
    assert.ok(isole.valeurs[isole.valeurs.length - 1] < 90);
    const recurrent = traiterValeursExtremes([...repete([2, 3, 4, 5], 5), 90, 92, 95]);
    assert.equal(recurrent.ecretees, 0);
    assert.equal(recurrent.longueTraineConservee, true);
    assert.equal(recurrent.valeurs[recurrent.valeurs.length - 1], 95);
  });

  test("le profil stocke les statistiques par compte, segment et client", () => {
    const obs = [...observations(repete([0, 3, 10], 4), "ACME", 2_000), ...observations([30, 45], "Dupont", 30_000)];
    const profil = profilPaiement(obs, "client", AUJOURDHUI);
    assert.equal(profil.nombreFactures, 14);
    assert.equal(profil.segments.length, CONFIG_CALIBRATION.bornesSegments.length + 1);
    assert.equal(profil.segments[0].statistiques?.nombre, 12);
    assert.equal(profil.segments[2].statistiques?.nombre, 2);
    assert.deepEqual(
      profil.clients.map((c) => [c.tiers, c.statistiques.nombre]),
      [
        ["ACME", 12],
        ["Dupont", 2],
      ]
    );
  });

  test("démarrage à froid : peu calibré sans historique, confiance croissante avec le volume", () => {
    const vide = calibrerModele([], "client", AUJOURDHUI);
    assert.equal(vide.confiance.niveau, "peu_calibre");
    assert.equal(vide.confiance.score, 0);
    assert.deepEqual(poidsPour(vide, "ACME", 1_000), { client: 0, segment: 0, compte: 0, defaut: 1 });
    const scores = [5, 20, 80, 300].map((n) => calibrerModele(observations(Array(n).fill(3)), "client", AUJOURDHUI).confiance.score);
    for (let i = 1; i < scores.length; i++) assert.ok(scores[i] > scores[i - 1]);
    assert.equal(calibrerModele(observations(Array(300).fill(3)), "client", AUJOURDHUI).confiance.niveau, "calibre");
  });

  test("les données d'un compte ne calibrent jamais un autre : le modèle ne lit que les observations reçues", () => {
    const compteA = calibrerModele(observations(Array(50).fill(60)), "client", AUJOURDHUI);
    const compteB = calibrerModele(observations(Array(50).fill(2)), "client", AUJOURDHUI);
    const retardsB = retardsSimules(compteB, 50);
    assert.ok(quantileTrie(retardsB, 0.9) <= 5, "B garde ses propres délais courts");
    assert.ok(quantileTrie(retardsSimules(compteA, 50), 0.5) >= 40);
  });
});

describe("Modèle hiérarchique (shrinkage)", () => {
  const compte = observations(repete([0, 2, 5, 8], 25), "Autres clients", 1_000); // 100 factures, retards courts

  test("client avec suffisamment d'historique : sa propre distribution domine", () => {
    const acme = observations(Array(60).fill(45), "ACME", 1_000);
    const modele = calibrerModele([...compte, ...acme], "client", AUJOURDHUI);
    const poids = poidsPour(modele, "ACME", 1_000);
    assert.ok(poids.client > 0.9, `poids client ${poids.client}`);
    const retards = retardsSimules(modele, 50, "ACME");
    assert.ok(quantileTrie(retards, 0.5) >= 40, `médiane ${quantileTrie(retards, 0.5)}`);
  });

  test("client avec deux factures : le comportement du compte reste majoritaire", () => {
    const acme = observations([60, 60], "ACME", 1_000);
    const modele = calibrerModele([...compte, ...acme], "client", AUJOURDHUI);
    const poids = poidsPour(modele, "acme", 1_000);
    assert.ok(poids.client > 0 && poids.client < 0.3, `poids client ${poids.client}`);
    const retards = retardsSimules(modele, 50, "ACME");
    assert.ok(quantileTrie(retards, 0.5) <= 8, `médiane ${quantileTrie(retards, 0.5)}`);
    const partLongs = retards.filter((r) => r >= 45).length / retards.length;
    assert.ok(partLongs > 0.15 && partLongs < 0.35, `légèrement ajusté par ACME : ${partLongs}`);
  });

  test("client sans historique : segment puis compte", () => {
    const gros = observations(Array(40).fill(30), "Gros client", 50_000);
    const modele = calibrerModele([...compte, ...gros], "client", AUJOURDHUI);
    const poidsInconnuGros = poidsPour(modele, "Inconnu", 60_000);
    assert.equal(poidsInconnuGros.client, 0);
    assert.ok(poidsInconnuGros.segment > 0.75);
    assert.ok(quantileTrie(retardsSimules(modele, 50, "Inconnu"), 0.5) <= 8, "petite facture : segment des petites factures");
    const alea = creerAlea(3);
    const ech = echantillonneurPour(modele, "Inconnu", 60_000);
    const tirages = Array.from({ length: 5_000 }, () => ech.tirer(alea)).sort((a, b) => a - b);
    assert.ok(quantileTrie(tirages, 0.5) >= 24, "grosse facture : segment des grosses factures");
  });

  test("les poids somment à 1", () => {
    const modele = calibrerModele([...compte, ...observations([10, 20], "ACME")], "client", AUJOURDHUI);
    for (const [tiers, montant] of [["ACME", 1_000], ["X", 100_000], [null, 10]] as const) {
      const p = poidsPour(modele, tiers, montant);
      assert.ok(Math.abs(p.client + p.segment + p.compte + p.defaut - 1) < 1e-9);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Dates simulées et fiabilité
// ---------------------------------------------------------------------------------------------

describe("Dates d'encaissement simulées", () => {
  test("date certaine (Ferme) : toujours à la date prévue", () => {
    const modele = calibrerModele(observations(Array(50).fill(30)), "client", AUJOURDHUI);
    const retards = retardsSimules(modele, 100);
    assert.equal(retards[0], 0);
    assert.equal(retards[retards.length - 1], 0);
  });

  test("compte à très faible dispersion : distribution étroite", () => {
    const modele = calibrerModele(observations(repete([0, 1, 2, 3, 5], 20)), "client", AUJOURDHUI);
    const retards = retardsSimules(modele, 50);
    assert.ok(quantileTrie(retards, 0.95) <= 7, `P95 ${quantileTrie(retards, 0.95)}`);
  });

  test("compte à retards très longs : distribution large, longue traîne conservée", () => {
    const modele = calibrerModele(observations(repete([10, 30, 45, 60, 90], 20)), "client", AUJOURDHUI);
    const retards = retardsSimules(modele, 50);
    assert.ok(quantileTrie(retards, 0.5) >= 35 && quantileTrie(retards, 0.5) <= 55);
    assert.ok(quantileTrie(retards, 0.95) >= 80, `P95 ${quantileTrie(retards, 0.95)}`);
  });

  test("la fiabilité module la distribution du compte, sans délai absolu", () => {
    const modele = calibrerModele(observations(repete([0, 10, 20, 30], 25)), "client", AUJOURDHUI);
    const p90 = (f: FiabiliteDate) => quantileTrie(retardsSimules(modele, f), 0.9);
    assert.equal(p90(100), 0);
    assert.ok(p90(75) < p90(50) && p90(50) < p90(25));
    assert.ok(Math.abs(p90(50) - 30) <= 4, "50 % reproduit le comportement observé");
  });

  test("facture déjà échue : jamais une date passée, retard tiré sachant qu'elle n'est pas réglée", () => {
    const modele = calibrerModele(observations(repete([0, 5, 20, 40], 25)), "client", AUJOURDHUI);
    const ech = echantillonneurPour(modele, null, 1_000);
    const alea = creerAlea(5);
    for (let i = 0; i < 2_000; i++) {
      const jour = simulerJour({ jourPrevu: 3, jourBase: -10, facteur: 1, echantillonneur: ech }, alea);
      assert.ok(jour >= 3);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Moteur
// ---------------------------------------------------------------------------------------------

describe("Probabilité d'occurrence", () => {
  test("événement à 100 % : toujours présent", () => {
    assert.equal(partEncaissee(100, 5_000), 1);
  });

  test("événement à 0 % : jamais présent", () => {
    assert.equal(partEncaissee(0, 5_000), 0);
  });

  for (const p of [25, 50, 75]) {
    test(`événement à ${p} % : présent dans ${p} % des simulations (± 3 écarts-types)`, () => {
      const n = 20_000;
      const tolerance = 3 * Math.sqrt(((p / 100) * (1 - p / 100)) / n);
      assert.ok(Math.abs(partEncaissee(p, n) - p / 100) < tolerance);
    });
  }
});

describe("Dépendances", () => {
  test("contrat non signé : sous-traitance et commission n'arrivent pas non plus", () => {
    const contrat = evenement({ cleLigne: "contrat", montant: 100_000, datePrevue: decalerDateISO(DEPART, 5) });
    const sousTraitance = evenement({ cleLigne: "st", montant: 35_000, sens: "decaissement", datePrevue: decalerDateISO(DEPART, 6) });
    const commission = evenement({ cleLigne: "com", montant: 10_000, sens: "decaissement", datePrevue: decalerDateISO(DEPART, 7) });
    const sim = simuler({
      soldeInitial: 0,
      dateDepart: DEPART,
      horizonJours: 10,
      lignes: [ligne("st", 100, "contrat"), ligne("com", 100, "contrat"), ligne("contrat", 50)],
      evenements: [contrat, sousTraitance, commission],
      modeles: modeles(),
      nombreSimulations: 5_000,
      graine: 1,
    });
    const finaux = new Set<number>();
    for (let s = 0; s < sim.nombre; s++) finaux.add(sim.soldes[(sim.jours - 1) * sim.nombre + s]);
    assert.deepEqual([...finaux].sort((a, b) => a - b), [0, 55_000]);
    assert.equal(sim.premierJourNegatif.every((j) => j === -1), true);
  });

  test("probabilités en chaîne : P(enfant) = P(parent) × P(enfant | parent)", () => {
    const e = evenement({ cleLigne: "enfant", montant: 1 });
    const sim = simuler({
      soldeInitial: 0,
      dateDepart: DEPART,
      horizonJours: 20,
      lignes: [ligne("parent", 50), ligne("enfant", 50, "parent")],
      evenements: [e, evenement({ cleLigne: "parent", montant: 1_000 })],
      modeles: modeles(),
      nombreSimulations: 20_000,
      graine: 9,
    });
    let enfant = 0;
    for (let s = 0; s < sim.nombre; s++) if (sim.soldes[(sim.jours - 1) * sim.nombre + s] % 1_000 === 1) enfant++;
    assert.ok(Math.abs(enfant / sim.nombre - 0.25) < 3 * Math.sqrt((0.25 * 0.75) / sim.nombre));
  });

  test("dépendances invalides ignorées et signalées, jamais bloquantes", () => {
    const { ordre, dependancesIgnorees } = ordonnerLignes([ligne("a", 100, "b"), ligne("b", 100, "a"), ligne("c", 100, "absent"), ligne("d", 100, "a")]);
    assert.equal(ordre.length, 4);
    assert.ok(ordre.findIndex((l) => l.cle === "a") < ordre.findIndex((l) => l.cle === "d"));
    assert.deepEqual(dependancesIgnorees.map((d) => d.raison).sort(), ["cycle", "parent_absent"]);
    assert.deepEqual([...descendants([ligne("a"), ligne("b", 100, "a"), ligne("c", 100, "b")], "a")].sort(), ["b", "c"]);
  });
});

describe("Reproductibilité", () => {
  const parametres = (graine: number) => ({
    soldeInitial: 10_000,
    dateDepart: DEPART,
    horizonJours: 60,
    lignes: [ligne("a", 75), ligne("b", 50)],
    evenements: [evenement({ cleLigne: "a", montant: 5_000, fiabiliteDate: 25 }), evenement({ cleLigne: "b", sens: "decaissement", montant: 12_000, fiabiliteDate: 50 })],
    modeles: modeles(observations(repete([0, 10, 30], 10)), observations(repete([0, 3], 10), "F", 1_000, "fournisseur")),
    nombreSimulations: 2_000,
    graine,
  });

  test("même graine -> résultats identiques", () => {
    const a = simuler(parametres(42));
    const b = simuler(parametres(42));
    assert.deepEqual(Array.from(a.soldes), Array.from(b.soldes));
    assert.deepEqual(calculerIndicateurs(a), calculerIndicateurs(b));
  });

  test("graine différente -> tirages différents", () => {
    assert.notDeepEqual(Array.from(simuler(parametres(1)).soldes), Array.from(simuler(parametres(2)).soldes));
  });

  test("10 000 simulations par défaut", () => {
    const { nombreSimulations, ...sansNombre } = parametres(1);
    void nombreSimulations;
    assert.equal(simuler(sansNombre).nombre, NOMBRE_SIMULATIONS_PAR_DEFAUT);
    assert.equal(NOMBRE_SIMULATIONS_PAR_DEFAUT, 10_000);
  });
});

describe("Cohérence statistique", () => {
  test("sans aléa, la simulation redonne la projection déterministe", () => {
    const sim = simuler({
      soldeInitial: 1_000,
      dateDepart: DEPART,
      horizonJours: 10,
      lignes: [ligne("a"), ligne("b")],
      evenements: [evenement({ cleLigne: "a", montant: 500, datePrevue: decalerDateISO(DEPART, 2) }), evenement({ cleLigne: "b", sens: "decaissement", montant: 2_000, datePrevue: decalerDateISO(DEPART, 4) })],
      modeles: modeles(),
      nombreSimulations: 100,
    });
    const ind = calculerIndicateurs(sim);
    assert.deepEqual(
      ind.serie.map((p) => p.p50),
      [1_000, 1_000, 1_500, 1_500, -500, -500, -500, -500, -500, -500, -500]
    );
    assert.ok(ind.serie.every((p) => p.p10 === p.p50 && p.p90 === p.p50));
    assert.equal(ind.probaNegatifHorizon, 1);
    assert.equal(ind.serie[3].probaNegatifAvant, 0);
    assert.equal(ind.serie[4].besoin99, 500);
    assert.equal(ind.serie[3].besoin90, 0);
    assert.deepEqual(ind.minimum, { p10: -500, p50: -500, p90: -500 });
  });

  test("moyenne et percentiles conformes à la loi sur un grand nombre de simulations", () => {
    // 20 encaissements indépendants de 1 000 € à 50 % : somme ~ Binomiale(20, 0,5) × 1 000.
    const lignes = Array.from({ length: 20 }, (_, i) => ligne(`l${i}`, 50));
    const evenements = lignes.map((l) => evenement({ cleLigne: l.cle, montant: 1_000 }));
    const sim = simuler({ soldeInitial: 0, dateDepart: DEPART, horizonJours: 15, lignes, evenements, modeles: modeles(), nombreSimulations: 10_000, graine: 3 });
    const finaux = Array.from({ length: sim.nombre }, (_, s) => sim.soldes[(sim.jours - 1) * sim.nombre + s]);
    const moyenne = finaux.reduce((a, b) => a + b, 0) / finaux.length;
    assert.ok(Math.abs(moyenne - 10_000) < 3 * (Math.sqrt(5) * 1_000) / Math.sqrt(sim.nombre) + 1);
    const ind = calculerIndicateurs(sim);
    const dernier = ind.serie[ind.serie.length - 1];
    assert.equal(dernier.p50, 10_000);
    assert.equal(dernier.p10, 7_000); // quantiles de B(20, 0,5) : 10 % -> 7, 90 % -> 13
    assert.equal(dernier.p90, 13_000);
  });

  test("probabilité de passer sous zéro et besoin de financement cohérents", () => {
    // Solde 0, décaissement certain de 1 000 € au jour 5, encaissement de 1 000 € à 50 % au jour 2.
    const sim = simuler({
      soldeInitial: 0,
      dateDepart: DEPART,
      horizonJours: 10,
      lignes: [ligne("enc", 50), ligne("dec")],
      evenements: [evenement({ cleLigne: "enc", datePrevue: decalerDateISO(DEPART, 2) }), evenement({ cleLigne: "dec", sens: "decaissement", datePrevue: decalerDateISO(DEPART, 5) })],
      modeles: modeles(),
      nombreSimulations: 10_000,
      graine: 4,
    });
    const ind = calculerIndicateurs(sim);
    assert.ok(Math.abs(ind.probaNegatifHorizon - 0.5) < 0.03);
    assert.equal(ind.dateProbaNegatifMax, decalerDateISO(DEPART, 5));
    assert.equal(ind.serie[10].besoin90, 1_000); // 50 % des cas à −1 000 : il faut 1 000 € pour 90 %
    assert.equal(ind.serie[4].besoin99, 0);
    assert.equal(ind.minimum.p10, -1_000);
    assert.equal(ind.minimum.p90, 0);
    assert.equal(ind.periodesTension.length, 1);
    assert.equal(ind.periodesTension[0].debut, decalerDateISO(DEPART, 5));
  });

  test("les percentiles quotidiens restent ordonnés P10 ≤ P50 ≤ P90", () => {
    const sim = simuler({
      soldeInitial: 5_000,
      dateDepart: DEPART,
      horizonJours: 90,
      lignes: [ligne("a", 75), ligne("b", 25), ligne("c")],
      evenements: [
        evenement({ cleLigne: "a", montant: 8_000, fiabiliteDate: 25, dateEcheance: DEPART, datePrevue: decalerDateISO(DEPART, 20) }),
        evenement({ cleLigne: "b", montant: 3_000, fiabiliteDate: 50 }),
        evenement({ cleLigne: "c", sens: "decaissement", montant: 9_000, datePrevue: decalerDateISO(DEPART, 30) }),
      ],
      modeles: modeles(observations(repete([0, 15, 45, 75], 10))),
      nombreSimulations: 3_000,
    });
    for (const p of calculerIndicateurs(sim).serie) assert.ok(p.p10 <= p.p50 && p.p50 <= p.p90);
  });
});

describe("Indicateurs", () => {
  test("quantile conservateur du besoin", () => {
    assert.equal(quantileConservateur([-5, 0, 10, 20], 0.5), 0);
    assert.equal(quantileConservateur([-5, 0, 10, 20], 0.75), 10);
    assert.equal(quantileConservateur([-5, 0, 10, 20], 0.99), 20);
  });

  test("périodes de tension : plages consécutives au-dessus du seuil", () => {
    const point = (date: string, probaNegatif: number) => ({ date, p10: 0, p50: 0, p90: 0, probaNegatif, probaNegatifAvant: 0, besoin90: 0, besoin95: 0, besoin99: 0 });
    const periodes = periodesDeTension([point("d1", 0), point("d2", 0.2), point("d3", 0.4), point("d4", 0.05), point("d5", 0.6)], 0.1);
    assert.deepEqual(periodes, [
      { debut: "d5", fin: "d5", probaMax: 0.6, dateProbaMax: "d5" },
      { debut: "d2", fin: "d3", probaMax: 0.4, dateProbaMax: "d3" },
    ]);
  });
});

describe("Construction des événements", () => {
  test("hypothèses par défaut, hypothèses saisies, tiers et échéance des factures", () => {
    const { lignes, evenements } = construireEvenements(
      [
        { source: "facture_client", sourceId: "fc1", libelle: "F1 — ACME", date: "2026-12-01", montant: 1_000 },
        { source: "charge_fixe", sourceId: "cf1", libelle: "Loyer", date: "2026-12-01", montant: -500 },
        { source: "charge_fixe", sourceId: "cf1", libelle: "Loyer", date: "2027-01-01", montant: -500 },
        { source: "rentree_reguliere", sourceId: "r1", libelle: "Contrat", date: "2026-12-05", montant: 2_000 },
      ],
      { facturesClients: [{ id: "fc1", client: "ACME", dateEcheance: "2026-11-25" }], facturesFournisseurs: [] },
      [{ source: "rentree_reguliere", sourceId: "r1", probabilite: 75, fiabiliteDate: 25, parentSource: "facture_client", parentSourceId: "fc1" }]
    );
    assert.deepEqual(lignes, [
      { cle: "facture_client:fc1", probabilite: 100, parentCle: null },
      { cle: "charge_fixe:cf1", probabilite: 100, parentCle: null },
      { cle: "rentree_reguliere:r1", probabilite: 75, parentCle: "facture_client:fc1" },
    ]);
    assert.equal(evenements.length, 4);
    assert.deepEqual(
      evenements.map((e) => [e.id, e.sens, e.montant, e.fiabiliteDate, e.tiers, e.dateEcheance]),
      [
        ["facture_client:fc1#0", "encaissement", 1_000, 50, "ACME", "2026-11-25"],
        ["charge_fixe:cf1#0", "decaissement", 500, 100, null, null],
        ["charge_fixe:cf1#1", "decaissement", 500, 100, null, null],
        ["rentree_reguliere:r1#0", "encaissement", 2_000, 25, null, null],
      ]
    );
  });

  test("modèle vide : tirages par défaut prudents uniquement", () => {
    const modele = modeleVide("client");
    const retards = retardsSimules(modele, 50);
    assert.ok(retards.some((r) => r === 0) && retards.some((r) => r > 0));
  });
});

// ---------------------------------------------------------------------------------------------
// API et offre
// ---------------------------------------------------------------------------------------------


describe("Offre Pilotage", () => {
  test("seule l'offre Pilotage ouvre la prévision probabiliste", () => {
    assert.equal(capacitesDeLOffre("essential").canViewProbabilisticForecast, false);
    assert.equal(capacitesDeLOffre("forecast").canViewProbabilisticForecast, false);
    assert.equal(capacitesDeLOffre("steering").canViewProbabilisticForecast, true);
  });
});

describe("Validation des requêtes", () => {
  const requete = {
    soldeInitial: 1_000,
    dateDepart: "2026-11-12",
    horizonJours: 90,
    lignes: [{ cle: "facture_client:a", probabilite: 75, parentCle: null }],
    evenements: [{ id: "facture_client:a#0", cleLigne: "facture_client:a", libelle: "F", montant: 10, sens: "encaissement", datePrevue: "2026-11-20", dateEcheance: null, fiabiliteDate: 50, tiers: "ACME" }],
  };

  test("requête valide acceptée, nombre de simulations borné", () => {
    const v = validerRequeteSimulation({ ...requete, nombreSimulations: 1_000_000 });
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.valeur.nombreSimulations, 20_000);
  });

  test("valeurs douteuses refusées", () => {
    assert.equal(validerRequeteSimulation({ ...requete, soldeInitial: "1000" }).ok, false);
    assert.equal(validerRequeteSimulation({ ...requete, horizonJours: 5_000 }).ok, false);
    assert.equal(validerRequeteSimulation({ ...requete, evenements: [{ ...requete.evenements[0], montant: -5 }] }).ok, false);
    assert.equal(validerRequeteSimulation({ ...requete, evenements: [{ ...requete.evenements[0], fiabiliteDate: 60 }] }).ok, false);
    assert.equal(validerRequeteSimulation({ ...requete, lignes: [{ cle: "x", probabilite: 120, parentCle: null }] }).ok, false);
  });

  test("hypothèse : valeurs proposées seulement, jamais sa propre dépendance", () => {
    const h = { source: "facture_client", sourceId: "a", probabilite: 75, fiabiliteDate: 25, parentSource: null, parentSourceId: null };
    assert.equal(validerHypothese(h).ok, true);
    assert.equal(validerHypothese({ ...h, probabilite: 60 }).ok, false);
    assert.equal(validerHypothese({ ...h, parentSource: "facture_client", parentSourceId: "a" }).ok, false);
    assert.equal(validerHypothese({ ...h, parentSource: "facture_client", parentSourceId: null }).ok, false);
    assert.equal(validerHypothese({ ...h, parentSource: "rentree_reguliere", parentSourceId: "r" }).ok, true);
  });
});
