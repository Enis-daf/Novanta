import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calibrerModele } from "./probaCalibration";
import { cleTiers, ObservationRetard } from "./probaHistorique";
import { EvenementTresorerie, LigneProbabiliste, construireEvenements } from "./probaEvenements";
import { analyserRisques, FactureAnalysee, mesurer, ParametresRisques, plausibiliteRetard, ResultatRisques } from "./probaRisques";
import { creerEvaluateur, preparerSimulation } from "./probaSimulation";
import { listerFluxProjetes } from "./cash-engine";
import { decalerDateISO } from "./dates";

// Départ le 20/11/2026 : le 25 novembre est le jour 5, le 30 novembre le jour 10, le 1er décembre le jour 11.
const DEPART = "2026-11-20";
const j = (jour: number) => decalerDateISO(DEPART, jour);
const J30NOV = 10;

const modeleVide = () => calibrerModele([], "client", DEPART);
const modelesVides = () => ({ client: modeleVide(), fournisseur: calibrerModele([], "fournisseur", DEPART) });

function ligne(cle: string, autres: Partial<LigneProbabiliste> = {}): LigneProbabiliste {
  return { cle, probabilite: 100, condition: null, fiabiliteMontant: 100, modeDate: "echeance", aRenseigner: false, ...autres };
}
function evt(cle: string, jour: number, montant: number, autres: Partial<EvenementTresorerie> = {}): EvenementTresorerie {
  return {
    id: `${cle}#0`,
    cleLigne: cle,
    libelle: cle,
    montant: Math.abs(montant),
    sens: montant >= 0 ? "encaissement" : "decaissement",
    datePrevue: j(jour),
    dateEcheance: null,
    fiabiliteDate: 50,
    tiers: cle,
    etage: montant >= 0 ? "revenue" : null,
    ...autres,
  };
}
const facture = (cle: string, autres: Partial<FactureAnalysee> = {}): FactureAnalysee => ({ cleLigne: cle, type: "facture_client", numero: cle.toUpperCase(), client: `Client ${cle}`, dateEcheance: null, ...autres });

function analyser(
  soldeInitial: number,
  flux: [string, number, number, Partial<EvenementTresorerie>?][],
  factures: string[],
  autres: Partial<ParametresRisques> = {},
  lignesSup: Record<string, Partial<LigneProbabiliste>> = {}
): ResultatRisques {
  const params: ParametresRisques = {
    soldeInitial,
    dateDepart: DEPART,
    horizonJours: 30,
    lignes: flux.map(([cle]) => ligne(cle, lignesSup[cle])),
    evenements: flux.map(([cle, jour, montant, e]) => evt(cle, jour, montant, e)),
    modeles: modelesVides(),
    factures: factures.map((f) => facture(f)),
    ...autres,
  };
  return analyserRisques(params, autres.modeles?.client ?? params.modeles.client);
}
const alertes = (r: ResultatRisques) => r.groupes.flatMap((g) => g.alertes);
const solde = (s: { soldes: number[] }, jour: number) => s.soldes[jour];

// ---------------------------------------------------------------------------------------------
// Cas de référence obligatoire
// ---------------------------------------------------------------------------------------------

describe("Cas de référence : 35 000 €, A 20 000 € le 25/11, B 15 000 € le 27/11, décaissement 45 000 € le 30/11", () => {
  const FLUX: [string, number, number][] = [
    ["a", 5, 20_000],
    ["b", 7, 15_000],
    ["dec", J30NOV, -45_000],
  ];

  test("soldes au 30 novembre des quatre situations (A au 2/12, B au 3/12, comme dans le cadrage)", () => {
    const params = { soldeInitial: 35_000, dateDepart: DEPART, horizonJours: 30, lignes: FLUX.map(([c]) => ligne(c)), evenements: FLUX.map(([c, d, m]) => evt(c, d, m)), modeles: modelesVides() };
    const evaluer = creerEvaluateur(preparerSimulation(params));
    const a = 0;
    const b = 1;
    assert.equal(evaluer().soldes[J30NOV], 25_000);
    assert.equal(evaluer(new Map([[a, 12]])).soldes[J30NOV], 5_000);
    assert.equal(evaluer(new Map([[b, 13]])).soldes[J30NOV], 10_000);
    assert.equal(evaluer(new Map([[a, 12], [b, 13]])).soldes[J30NOV], -10_000);
  });

  test("le duo est détecté, sans facture critique seule ; déficit 10 000 €, pas 35 000 €", () => {
    const r = analyser(35_000, FLUX, ["a", "b"]);
    const liste = alertes(r);
    assert.equal(liste.length, 1);
    const duo = liste[0];
    assert.equal(duo.type, "duo");
    assert.deepEqual(duo.factures.map((f) => f.cleLigne), ["a", "b"]);
    assert.equal(duo.mesures.deficitMax, 10_000);
    assert.equal(r.groupes[0].dateTension, "2026-11-30");
    // Retard testé identique (6 jours) : A testée le 1/12, B le 3/12 — « après le 30/11 » et « après le 2/12 ».
    assert.deepEqual(duo.factures.map((f) => [f.dateReference, f.dateTestee, f.retardJours]), [
      ["2026-11-25", "2026-12-01", 6],
      ["2026-11-27", "2026-12-03", 6],
    ]);
    // Les quatre situations : un seul des deux paiements à temps suffit à éviter le creux.
    assert.deepEqual(duo.situations.map((s) => s.libelle), ["Référence", "A seule retardée", "B seule retardée", "Les deux retardées"]);
    assert.deepEqual(duo.situations.map((s) => solde(s, J30NOV)), [25_000, 5_000, 10_000, -10_000]);
    assert.equal(duo.situations[1].mesures.premierNegatif, null);
    assert.equal(duo.situations[2].mesures.premierNegatif, null);
    assert.equal(duo.mesures.premierNegatif, J30NOV);
    // Le décaissement du jour est montré comme contexte.
    assert.deepEqual(duo.decaissementsDuJour, [{ libelle: "dec", montant: 45_000 }]);
  });

  test("indicateurs : premier passage, minimum, durée jusqu'au retour (A le 1/12)", () => {
    const duo = alertes(analyser(35_000, FLUX, ["a", "b"]))[0];
    // −10 000 le 30/11, +10 000 le 1/12 (A encaissée) : un jour de déficit.
    assert.deepEqual([duo.mesures.episodeDebut, duo.mesures.episodeFin, duo.mesures.dureeJours, duo.mesures.retourPositif], [10, 10, 1, true]);
  });
});

// ---------------------------------------------------------------------------------------------
// Détection
// ---------------------------------------------------------------------------------------------

describe("Détection", () => {
  test("facture critique seule : premier retard qui fait passer sous zéro", () => {
    const r = analyser(10_000, [["a", 5, 20_000], ["dec", J30NOV, -25_000]], ["a"]);
    const [alerte] = alertes(r);
    assert.equal(alerte.type, "seule");
    assert.equal(alerte.factures[0].dateTestee, "2026-12-01"); // payée après le 30/11
    assert.equal(alerte.mesures.deficitMax, 15_000);
  });

  test("deux factures critiques chacune séparément : un groupe, aucun duo redondant", () => {
    const r = analyser(5_000, [["a", 5, 20_000], ["b", 6, 20_000], ["dec", J30NOV, -40_000]], ["a", "b"]);
    assert.equal(r.groupes.length, 1);
    assert.equal(r.groupes[0].type, "seules_multiples");
    assert.deepEqual(r.groupes[0].alertes.map((a) => a.type), ["seule", "seule"]);
  });

  test("solde exactement nul : pas de franchissement ; seul le retard conjoint en crée un", () => {
    const r = analyser(10_000, [["a", 5, 5_000], ["b", 7, 5_000], ["dec", J30NOV, -15_000]], ["a", "b"]);
    const liste = alertes(r);
    assert.deepEqual(liste.map((a) => a.type), ["duo"]);
    assert.equal(liste[0].situations[1].soldes[J30NOV], 0, "A seule retardée : solde nul, pas négatif");
  });

  test("petite paire critique, que n'aurait pas vue un tri sur les montants", () => {
    const r = analyser(1_000, [["gros", 20, 50_000], ["p1", 3, 600], ["p2", 4, 600], ["dec", 6, -1_500]], ["gros", "p1", "p2"]);
    const duo = alertes(r).find((a) => a.type === "duo")!;
    assert.deepEqual(duo.factures.map((f) => f.cleLigne), ["p1", "p2"]);
    assert.equal(duo.mesures.deficitMax, 500);
  });

  test("une facture critique avec un long retard reste analysée en duo pour des retards plus courts", () => {
    // Au 30/11 : A seule ou B seule retardée -> 3 000 € ; les deux -> −5 000 €.
    // Au 15/12 (jour 25) : marge de 2 000 € ; A seule payée après cette date -> −6 000 €.
    const r = analyser(
      10_000,
      [["a", 5, 8_000], ["b", 6, 8_000], ["dec", J30NOV, -15_000], ["c", 12, 10_000], ["dec2", 25, -19_000]],
      ["a", "b"]
    );
    const parType = (t: string) => alertes(r).filter((x) => x.type === t);
    assert.deepEqual(parType("seule").map((x) => [x.factures[0].cleLigne, x.retardJours]), [["a", 21], ["b", 20]]);
    assert.deepEqual(parType("duo").map((x) => [x.factures.map((f) => f.cleLigne), x.retardJours]), [[["a", "b"], 6]]);
  });

  test("tension déjà prévue : aggravation, jamais déclenchement", () => {
    const r = analyser(0, [["dec", 3, -5_000], ["a", 5, 20_000]], ["a"]);
    assert.equal(r.reference.mesures.premierNegatif, 3);
    const [alerte] = alertes(r);
    assert.equal(alerte.type, "aggravation");
    assert.equal(alerte.mesures.dureeJours > 2, true, "épisode prolongé");
  });

  test("aucun franchissement dans l'horizon : aucune alerte, analyse complète", () => {
    const r = analyser(100_000, [["a", 5, 20_000], ["dec", J30NOV, -45_000]], ["a"]);
    assert.deepEqual(r.groupes, []);
    assert.equal(r.couverture.partielle, false);
  });

  test("paiement décalé au-delà de l'horizon : encaissé après, jamais supprimé ; pas de retour avant la fin", () => {
    const r = analyser(1_000, [["a", 25, 5_000], ["dec", 28, -5_000]], ["a"]);
    const [alerte] = alertes(r);
    assert.equal(alerte.type, "seule");
    assert.equal(alerte.factures[0].dateTestee, "2026-12-19", "testée le lendemain du décaissement");
    const auDela = analyser(1_000, [["a", 29, 5_000], ["dec", 30, -5_000]], ["a"]);
    const f = alertes(auDela)[0].factures[0];
    assert.equal(f.dateTestee, null, "au-delà de l'horizon");
    assert.equal(alertes(auDela)[0].mesures.retourPositif, false);
  });
});

// ---------------------------------------------------------------------------------------------
// Flux et dates
// ---------------------------------------------------------------------------------------------

describe("Flux et dates", () => {
  const PROJECTION = {
    facturesClients: [
      { id: "f1", facture: "FC-1", client: "Dupont", montant: 8_000, dateEcheance: "2026-11-10", dateEncaissementAnticipee: "2026-11-25", litigieuse: false, payee: false, paidAt: null },
      { id: "f2", facture: "FC-2", client: "Martin", montant: 5_000, dateEcheance: "2026-11-15", dateEncaissementAnticipee: "2026-11-26", litigieuse: false, payee: true, paidAt: "2026-11-18T00:00:00Z" },
    ],
    facturesFournisseurs: [],
    chargesFixes: [],
    autresDepenses: [],
    financements: [],
    rentreesRegulieres: [],
    facturesPrevisionnelles: [
      // Rapprochée de FC-1 : ne compte plus (pas de double compte avec la vraie facture).
      { id: "p1", client: "Dupont", montant: 8_000, dateFacturationPrevue: "", dateEncaissementPrevue: "2026-11-25", rapprochement: { factureClientId: "f1", factureNumero: "FC-1", facturePennylaneId: null, montantFacture: 8_000, rapprocheLe: "2026-11-19T00:00:00Z" }, facturesIgnorees: [] },
    ],
    dateDepart: DEPART,
    horizonJours: 30,
  };

  test("reste à encaisser seul, facture soldée absente, prévisionnelle rapprochée non recomptée", () => {
    const flux = listerFluxProjetes(PROJECTION).concat([{ source: "autre_depense", sourceId: "d", libelle: "Dépense", date: j(J30NOV), montant: -10_000 }]);
    const { lignes, evenements } = construireEvenements(flux, PROJECTION, []);
    assert.deepEqual(evenements.filter((e) => e.sens === "encaissement").map((e) => [e.cleLigne, e.montant]), [["facture_client:f1", 8_000]]);
    const r = analyserRisques(
      { soldeInitial: 5_000, dateDepart: DEPART, horizonJours: 30, lignes, evenements, modeles: modelesVides(), factures: [facture("facture_client:f1", { dateEcheance: "2026-11-10" }), facture("facture_client:f2")] },
      modeleVide()
    );
    const [alerte] = alertes(r);
    assert.equal(r.couverture.facturesAnalysees, 1, "la facture soldée n'est pas analysée");
    assert.equal(alerte.factures[0].montantRestant, 8_000);
    // Retard déjà intégré : la référence est la date d'encaissement anticipée, pas l'échéance passée.
    assert.deepEqual([alerte.factures[0].dateEcheance, alerte.factures[0].dateReference], ["2026-11-10", "2026-11-25"]);
    assert.equal(alerte.factures[0].dateTestee, "2026-12-01");
    assert.equal(alerte.factures[0].retardJours, 6);
  });

  test("le test de sensibilité ne modifie ni les échéances ni les hypothèses reçues", () => {
    const params: ParametresRisques = {
      soldeInitial: 35_000,
      dateDepart: DEPART,
      horizonJours: 30,
      lignes: [ligne("a"), ligne("b"), ligne("dec")],
      evenements: [evt("a", 5, 20_000), evt("b", 7, 15_000), evt("dec", J30NOV, -45_000)],
      modeles: modelesVides(),
      factures: [facture("a"), facture("b")],
    };
    const avant = JSON.stringify({ lignes: params.lignes, evenements: params.evenements, factures: params.factures });
    analyserRisques(params, modeleVide());
    assert.equal(JSON.stringify({ lignes: params.lignes, evenements: params.evenements, factures: params.factures }), avant);
  });
});

describe("Conditions d'activation", () => {
  test("condition sur la trésorerie réévaluée dans le scénario (réévaluation complète)", () => {
    // Achat de 30 000 € le 28/11 seulement si la trésorerie dépasse 40 000 € la veille.
    // Référence : 35 000 + 20 000 = 55 000 -> achat réalisé -> 25 000. A retardée : 35 000 -> pas d'achat.
    const r = analyser(
      35_000,
      [["a", 5, 20_000], ["achat", 8, -30_000], ["dec", J30NOV, -20_000]],
      ["a"],
      {},
      { achat: { condition: { type: "seuil", indicateur: "tresorerie", comparateur: ">", valeur: 40_000 } } }
    );
    assert.equal(r.couverture.methode, "reevaluation_complete");
    // Référence : 55 000 − 30 000 − 20 000 = 5 000 ≥ 0. A retardée : pas d'achat, 35 000 − 20 000 = 15 000 ≥ 0.
    assert.equal(r.reference.soldes[J30NOV], 5_000);
    assert.deepEqual(alertes(r), [], "retarder A annule l'achat conditionnel : pas de tension");
  });

  test("un retard de paiement ne décale pas le CA : condition sur le CA du mois précédent inchangée", () => {
    // Prime de 9 000 € le 3/12 si le CA de novembre dépasse 15 000 €. A (20 000 €, le 25/11) retardée en décembre.
    const r = analyser(
      0,
      [["a", 5, 20_000], ["prime", 13, -9_000], ["dec", 12, -10_000]],
      ["a"],
      {},
      { prime: { condition: { type: "seuil", indicateur: "ca_mois_precedent", comparateur: ">", valeur: 15_000 } } }
    );
    assert.equal(r.reference.soldes[30], 1_000, "référence : 20 000 − 10 000 − 9 000");
    const alerte = alertes(r).find((a) => a.type === "seule")!;
    assert.equal(alerte.factures[0].dateTestee, "2026-12-03", "A payée après le décaissement du 2/12");
    // Le CA de novembre reste de 20 000 € : la prime reste versée, le solde final est inchangé.
    const scenario = alerte.situations[1].soldes;
    assert.equal(scenario[scenario.length - 1], 1_000);
  });

  test("méthode rapide = réévaluation complète, au centime, sans condition dépendante", () => {
    const flux: [string, number, number][] = [["a", 3, 7_000], ["b", 9, 4_000], ["c", 12, 2_500], ["dec", 10, -12_000], ["dec2", 20, -6_000]];
    const rapide = analyser(5_000, flux, ["a", "b", "c"]);
    // Même analyse forcée en réévaluation complète par une condition sans effet (ligne absente de l'horizon).
    const complet = analyser(5_000, [...flux, ["neutre", 40, -1]], ["a", "b", "c"], {}, { neutre: { condition: { type: "seuil", indicateur: "tresorerie", comparateur: ">", valeur: 0 } } });
    assert.equal(rapide.couverture.methode, "exacte_rapide");
    assert.equal(complet.couverture.methode, "reevaluation_complete");
    assert.deepEqual(JSON.stringify(rapide.groupes), JSON.stringify(complet.groupes));
  });

  test("budget atteint : analyse signalée partielle", () => {
    const flux: [string, number, number][] = [["a", 3, 7_000], ["b", 9, 4_000], ["c", 12, 2_500], ["dec", 10, -12_000], ["neutre", 40, -1]];
    const r = analyser(5_000, flux, ["a", "b", "c"], { budgetEvaluations: 20 }, { neutre: { condition: { type: "seuil", indicateur: "tresorerie", comparateur: ">", valeur: 0 } } });
    assert.equal(r.couverture.partielle, true);
  });
});

// ---------------------------------------------------------------------------------------------
// Plausibilité
// ---------------------------------------------------------------------------------------------

function obs(retards: number[], tiers: string): ObservationRetard[] {
  return retards.map((retard, i) => ({ cote: "client", tiers, cleTiers: cleTiers(tiers), montant: 5_000, echeance: decalerDateISO("2026-05-01", i), dateReglement: decalerDateISO(decalerDateISO("2026-05-01", i), retard), retard }));
}

describe("Plausibilité du retard", () => {
  test("historique du client disponible : sa propre distribution", () => {
    const modele = calibrerModele([...obs(Array(40).fill(30), "Dupont"), ...obs(Array(40).fill(0), "Autres")], "client", DEPART);
    const p = plausibiliteRetard(modele, { tiers: "Dupont", montant: 5_000, jourReference: 5, jourEcheance: 5 }, 11);
    assert.equal(p.estimee, true);
    if (p.estimee) {
      assert.equal(p.source, "client");
      assert.ok(p.part > 0.9, `Dupont paie à 30 j : un paiement après 6 jours est quasi certain (${p.part})`);
    }
  });

  test("client inconnu : repli sur le compte", () => {
    const modele = calibrerModele(obs(Array(80).fill(0), "Autres"), "client", DEPART);
    const p = plausibiliteRetard(modele, { tiers: "Nouveau", montant: 5_000, jourReference: 5, jourEcheance: 5 }, 11);
    assert.equal(p.estimee, true);
    if (p.estimee) {
      assert.equal(p.source, "compte");
      assert.ok(p.part < 0.1);
    }
  });

  test("sans historique : plausibilité non estimée, jamais un pourcentage inventé", () => {
    const p = plausibiliteRetard(modeleVide(), { tiers: "X", montant: 5_000, jourReference: 5, jourEcheance: 5 }, 11);
    assert.deepEqual(p, { estimee: false, raison: "peu_calibre" });
  });

  test("facture déjà échue : retard tiré sachant qu'elle n'est pas réglée aujourd'hui", () => {
    const modele = calibrerModele(obs([...Array(40).fill(10), ...Array(40).fill(40)], "Dupont"), "client", DEPART);
    // Échue il y a 20 jours : seuls les retards ≥ 20 j restent possibles (ceux de 40 j) ; une facture
    // à échéance future peut encore être réglée à 10 jours.
    const echue = plausibiliteRetard(modele, { tiers: "Dupont", montant: 5_000, jourReference: 1, jourEcheance: -20 }, 15);
    const future = plausibiliteRetard(modele, { tiers: "Dupont", montant: 5_000, jourReference: 1, jourEcheance: 1 }, 15);
    assert.ok(echue.estimee && future.estimee && echue.part > future.part + 0.25, JSON.stringify({ echue, future }));
  });

  test("duo d'un même client : signalé, sans probabilité conjointe", () => {
    const r = analyser(10_000, [["a", 5, 5_000, { tiers: "Dupont" }], ["b", 7, 5_000, { tiers: "dupont" }], ["dec", J30NOV, -15_000]], ["a", "b"]);
    const duo = alertes(r)[0];
    assert.equal(duo.memeClient, true);
    assert.equal("probabiliteConjointe" in duo, false);
  });

  test("date marquée certaine : le stress reste analysé, signalé comme hypothétique", () => {
    const r = analyser(10_000, [["a", 5, 20_000, { fiabiliteDate: 100 }], ["dec", J30NOV, -25_000]], ["a"]);
    assert.equal(alertes(r)[0].factures[0].dateCertaine, true);
  });
});

describe("Mesures", () => {
  test("épisode nouveau vs tension de référence", () => {
    const ref = Float64Array.from([5, 5, -1, 5, 5, 5]);
    assert.equal(mesurer(Float64Array.from([5, 5, -1, 5, -2, 5]), ref).nature, "declenchement");
    assert.equal(mesurer(Float64Array.from([5, 5, -1, -1, 5, 5]), ref).nature, "aggravation");
    assert.equal(mesurer(Float64Array.from([5, 5, -1, 5, 5, 5]), ref).nature, "aucun");
    assert.equal(mesurer(Float64Array.from([5, 0, 5, 5, 5, 5]), Float64Array.from([5, 5, 5, 5, 5, 5])).nature, "aucun");
  });
});
