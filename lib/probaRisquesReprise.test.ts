/**
 * Reprise de Gestion des risques : duos à retards différents (dont le cas asymétrique obligatoire,
 * vérifié contre une exploration exhaustive des couples de dates), couverture en quatre limites,
 * et chaîne complète des factures clientes en retard (préparation commune -> analyse).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calibrerModele, ModeleRetards } from "./probaCalibration";
import { cleTiers, ObservationRetard } from "./probaHistorique";
import { cleLigne, construireEvenements, EvenementTresorerie, LigneProbabiliste } from "./probaEvenements";
import { analyserRisques, FactureAnalysee, mesurer, NatureImpact, ParametresRisques, PerimetreFactures, ResultatRisques } from "./probaRisques";
import { creerEvaluateur, preparerSimulation, simuler } from "./probaSimulation";
import { calculerProjectionCash, listerFluxProjetes, ParametresProjectionCash } from "./cash-engine";
import { estimerDateEncaissement, estimerDates, facturesEnRetard } from "./probaEstimation";
import { creerAlea } from "./probaAlea";
import { decalerDateISO } from "./dates";
import type { FactureClient } from "./types";

const DEPART = "2026-11-20";
const j = (jour: number) => decalerDateISO(DEPART, jour);
const modeleVide = () => calibrerModele([], "client", DEPART);
const modelesVides = () => ({ client: modeleVide(), fournisseur: calibrerModele([], "fournisseur", DEPART) });
const ligne = (cle: string, autres: Partial<LigneProbabiliste> = {}): LigneProbabiliste => ({
  cle,
  probabilite: 100,
  condition: null,
  fiabiliteMontant: 100,
  modeDate: "echeance",
  aRenseigner: false,
  ...autres,
});
const evt = (cle: string, jour: number, montant: number): EvenementTresorerie => ({
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
});
const facture = (cle: string): FactureAnalysee => ({ cleLigne: cle, type: "facture_client", numero: cle.toUpperCase(), client: cle, dateEcheance: null });

type Flux = [string, number, number][];
function parametres(solde: number, flux: Flux, factures: string[], autres: Partial<ParametresRisques> = {}, lignesSup: Record<string, Partial<LigneProbabiliste>> = {}): ParametresRisques {
  return {
    soldeInitial: solde,
    dateDepart: DEPART,
    horizonJours: 30,
    lignes: flux.map(([c]) => ligne(c, lignesSup[c])),
    evenements: flux.map(([c, d, m]) => evt(c, d, m)),
    modeles: modelesVides(),
    factures: factures.map(facture),
    ...autres,
  };
}
const analyser = (...args: Parameters<typeof parametres>) => analyserRisques(parametres(...args), modeleVide());
const alertes = (r: ResultatRisques) => r.groupes.flatMap((g) => g.alertes);

// ---------------------------------------------------------------------------------------------
// Cas obligatoire : duo à retards différents
// ---------------------------------------------------------------------------------------------

describe("Duo asymétrique (cas obligatoire)", () => {
  // 35 000 € ; A +20 000 € à J1 ; B +15 000 € à J10 ; −45 000 € à J11 ; −15 000 € à J15.
  const FLUX: Flux = [
    ["a", 1, 20_000],
    ["b", 10, 15_000],
    ["d1", 11, -45_000],
    ["d2", 15, -15_000],
  ];
  const minimum = (s: Float64Array) => Math.min(...s);

  test("les quatre situations données au calcul : 10 000 / 5 000 / 10 000 / −10 000 € à J11", () => {
    const evaluer = creerEvaluateur(preparerSimulation(parametres(35_000, FLUX, [])));
    const reference = evaluer().soldes;
    const aSeule = evaluer(new Map([[0, 12]])).soldes;
    const bSeule = evaluer(new Map([[1, 12]])).soldes;
    const deux = evaluer(new Map([[0, 12], [1, 12]])).soldes;
    assert.deepEqual([minimum(reference), minimum(aSeule), minimum(bSeule), minimum(deux)], [10_000, 5_000, 10_000, -10_000]);
    assert.equal(deux[11], -10_000);
  });

  test("la recherche TROUVE la combinaison (A +11 jours, B +2 jours) sans qu'on lui fournisse les dates", () => {
    const r = analyser(35_000, FLUX, ["a", "b"]);
    const duos = alertes(r).filter((x) => x.type === "duo");
    assert.equal(duos.length, 1);
    const duo = duos[0];
    assert.deepEqual(
      duo.factures.map((f) => [f.cleLigne, f.dateReference, f.dateTestee, f.retardJours]),
      [
        ["a", j(1), j(12), 11],
        ["b", j(10), j(12), 2],
      ]
    );
    assert.deepEqual(duo.situations.map((s) => s.mesures.minimum), [10_000, 5_000, 10_000, -10_000]);
    assert.equal(duo.mesures.episodeDebut, 11);
    assert.equal(duo.mesures.deficitMax, 10_000);
  });

  test("déduplication : B critique seule sous un retard commun long, la combinaison asymétrique reste", () => {
    // Avec un retard commun de 11 jours, B (encaissée à J21) passe seule sous zéro à J15.
    const evaluer = creerEvaluateur(preparerSimulation(parametres(35_000, FLUX, [])));
    assert.ok(Math.min(...evaluer(new Map([[1, 21]])).soldes) < 0);
    const r = analyser(35_000, FLUX, ["a", "b"]);
    assert.ok(alertes(r).some((x) => x.type === "seule" && x.factures[0].cleLigne === "b"), "B critique seule (autre épisode, J15)");
    assert.ok(alertes(r).some((x) => x.type === "duo"), "le duo asymétrique de J11 n'est pas masqué");
  });
});

// ---------------------------------------------------------------------------------------------
// Méthode optimisée = exploration exhaustive des couples de dates (cas sans condition)
// ---------------------------------------------------------------------------------------------

/** Référence de test indépendante : tous les couples (kA, kB), avec le moteur complet. */
function duosExhaustifs(p: ParametresRisques): Set<string> {
  const prep = preparerSimulation(p);
  const evaluer = creerEvaluateur(prep);
  const ref = evaluer();
  const jours = prep.jours;
  const cands = p.factures
    .map((f) => {
      const k = prep.sources.findIndex((e) => e.cleLigne === f.cleLigne);
      return k >= 0 && ref.jours[k] < jours ? { cle: f.cleLigne, k, p: ref.jours[k] } : null;
    })
    .filter((c): c is { cle: string; k: number; p: number } => c !== null);
  const nature = (forces: Map<number, number>): NatureImpact => mesurer(evaluer(forces).soldes, ref.soldes).nature;
  const seule = cands.map((c) => Array.from({ length: jours - c.p + 1 }, (_, k) => (k === 0 ? "aucun" : nature(new Map([[c.k, c.p + k]])))));
  const trouves = new Set<string>();
  for (let a = 0; a < cands.length; a++) {
    for (let b = a + 1; b < cands.length; b++) {
      for (let ka = 1; ka <= jours - cands[a].p; ka++) {
        for (let kb = 1; kb <= jours - cands[b].p; kb++) {
          if (seule[a][ka] === "declenchement" || seule[b][kb] === "declenchement") continue;
          if (nature(new Map([[cands[a].k, cands[a].p + ka], [cands[b].k, cands[b].p + kb]])) === "declenchement") trouves.add(`${cands[a].cle}|${cands[b].cle}`);
        }
      }
    }
  }
  return trouves;
}

describe("Exploration exhaustive de référence", () => {
  test("mêmes duos détectés que l'exploration de tous les couples de dates, sur 150 petits cas aléatoires", () => {
    const alea = creerAlea(2026);
    let avecDuo = 0;
    for (let cas = 0; cas < 150; cas++) {
      const n = 3 + alea.entier(2);
      const flux: Flux = [];
      for (let i = 0; i < n; i++) flux.push([`f${i}`, alea.entier(10), 1_000 + alea.entier(9) * 1_000]);
      for (let d = 0; d < 3; d++) flux.push([`d${d}`, 3 + alea.entier(12), -(2_000 + alea.entier(12) * 1_000)]);
      const p = { ...parametres(2_000 + alea.entier(10) * 1_000, flux, flux.filter(([c]) => c.startsWith("f")).map(([c]) => c)), horizonJours: 16 };
      const r = analyserRisques(p, modeleVide());
      assert.equal(r.couverture.methode, "exacte");
      const optimises = new Set(
        r.groupes.flatMap((g) => [...g.alertes.filter((a) => a.type === "duo").map((a) => a.factures.map((f) => f.cleLigne).join("|")), ...(g.type === "duo" ? g.autres.map((x) => x.factures.map((f) => f.cleLigne).join("|")) : [])])
      );
      const exhaustifs = duosExhaustifs(p);
      if (exhaustifs.size > 0) avecDuo++;
      assert.deepEqual([...optimises].sort(), [...exhaustifs].sort(), `cas ${cas} : ${JSON.stringify(flux)}`);
    }
    assert.ok(avecDuo >= 15, `assez de cas avec duo (${avecDuo})`);
  });
});

// ---------------------------------------------------------------------------------------------
// Épisodes multiples, petite paire, conditions
// ---------------------------------------------------------------------------------------------

describe("Attribution et cas particuliers", () => {
  test("une même paire, deux épisodes distincts : deux alertes, chacune son épisode et ses dates", () => {
    // Marge de 9 000 € à J5 et de 7 000 € à J20 (rebond entre les deux) : aucune facture seule ne
    // suffit (5 000 € chacune), les deux ensemble oui, à chacune des deux dates.
    const r = analyser(10_000, [["a", 1, 5_000], ["b", 2, 5_000], ["d1", 5, -11_000], ["c", 8, 30_000], ["d2", 20, -32_000]], ["a", "b"]);
    const duos = alertes(r).filter((x) => x.type === "duo");
    assert.deepEqual(
      duos.map((d) => d.mesures.episodeDebut).sort((x, y) => (x ?? 0) - (y ?? 0)),
      [5, 20]
    );
    assert.equal(new Set(duos.map((d) => d.id)).size, 2);
  });

  test("petite paire critique avec des retards différents", () => {
    const r = analyser(1_000, [["gros", 25, 50_000], ["p1", 1, 600], ["p2", 5, 600], ["dec", 6, -1_500]], ["gros", "p1", "p2"]);
    const duo = alertes(r).find((x) => x.type === "duo")!;
    assert.deepEqual(duo.factures.map((f) => [f.cleLigne, f.retardJours]), [["p1", 6], ["p2", 2]]);
  });

  test("condition dépendant de la trésorerie : méthode restreinte déclarée, analyse partielle", () => {
    const r = analyser(5_000, [["a", 3, 7_000], ["b", 9, 4_000], ["dec", 10, -12_000], ["neutre", 40, -1]], ["a", "b"], {}, {
      neutre: { condition: { type: "seuil", indicateur: "tresorerie", comparateur: ">", valeur: 0 } },
    });
    assert.equal(r.couverture.methode, "retards_minimaux");
    assert.ok(r.couverture.restrictionMethode);
    assert.equal(r.couverture.partielle, true);
    assert.equal(r.couverture.arret, null, "méthode restreinte, mais calcul mené jusqu'au bout");
  });
});

// ---------------------------------------------------------------------------------------------
// Couverture : quatre limites distinctes
// ---------------------------------------------------------------------------------------------

describe("Couverture", () => {
  const FLUX: Flux = [["a", 3, 7_000], ["b", 9, 4_000], ["c", 12, 2_500], ["dec", 10, -12_000]];

  test("analyse complète : aucune limite, partielle à false", () => {
    const c = analyser(5_000, FLUX, ["a", "b", "c"]).couverture;
    assert.deepEqual([c.partielle, c.methode, c.arret, c.pairesNonExplorees, c.perimetre.aActualiser.length], [false, "exacte", null, 0, 0]);
    assert.equal(c.pairesExplorees + c.pairesEcarteesSansRisque, c.pairesPossibles);
  });

  test("données : une facture à actualiser rend l'analyse partielle, même si le calcul est complet", () => {
    const perimetre: PerimetreFactures = { enRetardEstimees: 0, aActualiser: [{ cleLigne: "facture_client:x", numero: "FC-X", client: "X", montant: 9_000, raison: "historique" }], litigieusesExclues: 0, horsHorizon: 0 };
    const c = analyser(5_000, FLUX, ["a", "b", "c"], { perimetre }).couverture;
    assert.deepEqual([c.partielle, c.arret, c.restrictionMethode], [true, null, null]);
  });

  test("calcul arrêté : cause et périmètre non exploré déclarés", () => {
    const r = analyser(5_000, [...FLUX, ["neutre", 40, -1]], ["a", "b", "c"], { budgetEvaluations: 30 }, {
      neutre: { condition: { type: "seuil", indicateur: "tresorerie", comparateur: ">", valeur: 0 } },
    });
    assert.equal(r.couverture.arret?.cause, "budget_evaluations");
    assert.ok(r.couverture.pairesNonExplorees + r.couverture.facturesSeulesIncompletes > 0);
    assert.equal(r.couverture.partielle, true);
  });

  test("affichage : plafond de détail sans effet sur le résultat calculé", () => {
    // 14 petites factures, chacune critique seule pour la même tension : 14 alertes calculées.
    const flux: Flux = [...Array.from({ length: 14 }, (_, i): [string, number, number] => [`f${i}`, 1, 1_000]), ["dec", 5, -14_500]];
    const r = analyser(0, flux, flux.slice(0, 14).map(([c]) => c));
    const c = r.couverture;
    assert.equal(c.affichage.alertesCalculees, 14);
    assert.equal(c.affichage.alertesDetaillees, 10);
    assert.equal(c.affichage.combinaisonsListees, 4);
    assert.equal(r.groupes[0].nombreTotal, 14);
    assert.equal(c.partielle, false, "un affichage condensé n'est pas une analyse partielle");
  });

  test("portée de la référence : flux incertains, financement incertain, hypothèses à renseigner", () => {
    const r = analyser(5_000, [...FLUX, ["financement:pret", 4, 20_000], ["autre_depense:x", 6, -1_000]], ["a", "b", "c"], {}, {
      "financement:pret": { probabilite: 50 },
      "autre_depense:x": { aRenseigner: true },
    });
    assert.deepEqual([r.reference.fluxIncertains, r.reference.financementsIncertains, r.reference.hypothesesARenseigner], [1, 1, 1]);
  });
});

// ---------------------------------------------------------------------------------------------
// Chaîne complète des factures clientes en retard
// ---------------------------------------------------------------------------------------------

function fc(id: string, champs: Partial<FactureClient>): FactureClient {
  return { id, facture: `FC-${id}`, client: `Client ${id}`, montant: 10_000, dateEcheance: j(-30), dateEncaissementAnticipee: j(-10), litigieuse: false, payee: false, paidAt: null, ...champs };
}
function obs(retards: number[], tiers: string): ObservationRetard[] {
  return retards.map((retard, i) => ({ cote: "client", tiers, cleTiers: cleTiers(tiers), montant: 10_000, echeance: decalerDateISO("2026-03-01", i), dateReglement: decalerDateISO(decalerDateISO("2026-03-01", i), retard), retard }));
}
const projectionDe = (facturesClients: FactureClient[], autres: Partial<ParametresProjectionCash> = {}): Omit<ParametresProjectionCash, "soldeInitial"> => ({
  facturesClients,
  facturesFournisseurs: [],
  chargesFixes: [],
  autresDepenses: [{ id: "dep", libelle: "Échéance de prêt", montant: 20_000, datePrevue: j(25), type: "certaine", facturee: false, payee: false }],
  financements: [],
  rentreesRegulieres: [],
  dateDepart: DEPART,
  horizonJours: 30,
  ...autres,
});

describe("Factures en retard : périmètre et date de référence", () => {
  const historique = (tiers = "Client late"): ModeleRetards => calibrerModele([...obs(Array(40).fill(40), tiers), ...obs(Array(40).fill(5), "Autres")], "client", DEPART);

  test("une facture ouverte à date passée n'est plus écartée : elle entre dans le périmètre", () => {
    const factures = [fc("late", { client: "Client late" }), fc("ok", { dateEncaissementAnticipee: j(5) }), fc("payee", { payee: true }), fc("litige", { litigieuse: true })];
    assert.deepEqual(facturesEnRetard(factures, DEPART).map((f) => f.id), ["late"]);
  });

  test("date actualisée à venir : elle fait foi, aucune estimation", () => {
    const flux = listerFluxProjetes({ ...projectionDe([fc("ok", { dateEncaissementAnticipee: j(5) })]), datesEstimees: new Map([["ok", j(20)]]) });
    assert.deepEqual(flux.filter((f) => f.source === "facture_client").map((f) => [f.date, f.dateEstimee ?? false]), [[j(5), false]]);
  });

  test("estimation du délai restant par l'historique du client, sachant la facture impayée aujourd'hui", () => {
    // Échue depuis 30 jours ; le client paie à 40 jours : paiement attendu vers J+10, jamais avant aujourd'hui.
    const e = estimerDateEncaissement({ id: "late", numero: "FC-late", client: "Client late", montant: 10_000, dateEcheance: j(-30), dateEncaissementAnticipee: j(-10) }, historique(), DEPART);
    assert.equal(e.statut, "estimee");
    if (e.statut === "estimee") {
      assert.equal(e.origine, "client");
      const jour = Math.round((Date.parse(e.date) - Date.parse(DEPART)) / 86_400_000);
      assert.ok(jour >= 7 && jour <= 13, `paiement estimé vers J+10 (${e.date})`);
    }
  });

  test("repli sur le compte quand le client est inconnu", () => {
    const modele = calibrerModele(obs([...Array(40).fill(10), ...Array(40).fill(50)], "Autres"), "client", DEPART);
    const e = estimerDateEncaissement({ id: "x", numero: "FC-x", client: "Nouveau client", montant: 10_000, dateEcheance: j(-20), dateEncaissementAnticipee: null }, modele, DEPART);
    assert.equal(e.statut === "estimee" && e.origine, "compte");
  });

  test("sans historique : à actualiser, jamais de date inventée ni de premier jour", () => {
    const e = estimerDateEncaissement({ id: "x", numero: "FC-x", client: "X", montant: 10_000, dateEcheance: j(-20), dateEncaissementAnticipee: j(-5) }, modeleVide(), DEPART);
    assert.deepEqual(e, { factureId: "x", statut: "a_actualiser", raison: "historique_insuffisant" });
    const flux = listerFluxProjetes(projectionDe([fc("x", {})]));
    assert.equal(flux.some((f) => f.source === "facture_client"), false, "pas de placement d'office au premier jour");
  });

  test("retard constaté au-delà de l'historique : à actualiser", () => {
    const e = estimerDateEncaissement({ id: "x", numero: "FC-x", client: "Client late", montant: 10_000, dateEcheance: j(-200), dateEncaissementAnticipee: null }, historique(), DEPART);
    assert.deepEqual(e, { factureId: "x", statut: "a_actualiser", raison: "retard_hors_historique" });
  });

  test("ni échéance ni date : à actualiser", () => {
    const e = estimerDateEncaissement({ id: "x", numero: "FC-x", client: "Client late", montant: 10_000, dateEcheance: null, dateEncaissementAnticipee: null }, historique(), DEPART);
    assert.equal(e.statut === "a_actualiser" && e.raison, "sans_reference");
  });

  test("chaîne complète : préparation commune -> événements -> analyse ; reste à encaisser, pas de double compte", () => {
    const factures = [
      fc("late", { client: "Client late", montant: 6_000 }), // reste dû après un paiement partiel
      fc("vide", { client: "Inconnu", dateEcheance: "", dateEncaissementAnticipee: "" }), // non estimable
      fc("payee", { payee: true }),
    ];
    const prevision = {
      id: "p1",
      client: "Client late",
      montant: 6_000,
      dateFacturationPrevue: "",
      dateEncaissementPrevue: j(10),
      rapprochement: { factureClientId: "late", factureNumero: "FC-late", facturePennylaneId: null, montantFacture: 6_000, rapprocheLe: "2026-11-01T00:00:00Z" },
      facturesIgnorees: [],
    };
    const estimations = estimerDates(facturesEnRetard(factures, DEPART), historique(), DEPART);
    assert.deepEqual(estimations.map((e) => [e.factureId, e.statut]), [["late", "estimee"], ["vide", "a_actualiser"]]);
    const datesEstimees = new Map(estimations.flatMap((e) => (e.statut === "estimee" ? [[e.factureId, e.date] as [string, string]] : [])));
    const projection = { ...projectionDe(factures, { facturesPrevisionnelles: [prevision] }), datesEstimees };
    const flux = listerFluxProjetes(projection);
    const encaissements = flux.filter((f) => f.montant > 0);
    assert.deepEqual(encaissements.map((f) => [f.sourceId, f.montant, f.dateEstimee]), [["late", 6_000, true]], "seul le reste dû, prévisionnelle rapprochée non recomptée");
    // Même date dans la courbe de référence (calculerProjectionCash) que dans la liste des flux.
    const serie = calculerProjectionCash({ soldeInitial: 15_000, ...projection }).serie;
    assert.equal(serie.find((p) => p.date === encaissements[0].date)!.solde - serie.find((p) => p.date === decalerDateISO(encaissements[0].date, -1))!.solde, 6_000);

    const { lignes, evenements } = construireEvenements(flux, projection, []);
    assert.equal(evenements.find((e) => e.cleLigne === "facture_client:late")!.dateEstimee, true);
    const perimetre: PerimetreFactures = { enRetardEstimees: 1, aActualiser: [{ cleLigne: "facture_client:vide", numero: "FC-vide", client: "Inconnu", montant: 10_000, raison: "x" }], litigieusesExclues: 0, horsHorizon: 0 };
    const r = analyserRisques(
      { soldeInitial: 15_000, dateDepart: DEPART, horizonJours: 30, lignes, evenements, modeles: { client: historique(), fournisseur: calibrerModele([], "fournisseur", DEPART) }, factures: [{ cleLigne: "facture_client:late", type: "facture_client", numero: "FC-late", client: "Client late", dateEcheance: j(-30) }], perimetre },
      historique()
    );
    assert.equal(r.couverture.facturesAnalysees, 1);
    assert.equal(r.couverture.partielle, true, "facture à actualiser : couverture incomplète");
    const alerte = alertes(r)[0];
    assert.equal(alerte.factures[0].montantRestant, 6_000);
    assert.equal(alerte.factures[0].dateReferenceEstimee, true);
    assert.equal(alerte.factures[0].dateReference, encaissements[0].date);
  });

  test("Monte Carlo : une date estimée peut tomber dès aujourd'hui, pas seulement après la médiane", () => {
    const e: EvenementTresorerie = { ...evt("facture_client:late", 10, 6_000), cleLigne: "facture_client:late", tiers: "Client late", dateEcheance: j(-30), dateEstimee: true };
    const modele = calibrerModele([...obs([...Array(40).fill(32), ...Array(40).fill(48)], "Client late")], "client", DEPART);
    const sim = simuler({ soldeInitial: 0, dateDepart: DEPART, horizonJours: 30, lignes: [ligne("facture_client:late")], evenements: [e], modeles: { client: modele, fournisseur: calibrerModele([], "fournisseur", DEPART) }, nombreSimulations: 2_000 });
    let avantMediane = 0;
    for (let s = 0; s < sim.nombre; s++) if (sim.soldes[9 * sim.nombre + s] > 0) avantMediane++;
    assert.ok(avantMediane / sim.nombre > 0.2, `encaissée avant J10 dans une part des simulations (${avantMediane / sim.nombre})`);
  });
});
