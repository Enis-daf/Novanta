import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calibrerModele, ModeleRetards } from "./probaCalibration";
import { cleTiers, ObservationRetard } from "./probaHistorique";
import { cleLigne, construireEvenements, EvenementTresorerie, LigneProbabiliste } from "./probaEvenements";
import { analyserSemaine, ParametresSemaine, testerDecalage } from "./probaSemaine";
import { calculerIndicateurs, semainesDeLHorizon } from "./probaIndicateurs";
import { etatDeSimulation, preparerSimulation, rejouerSimulation, simuler } from "./probaSimulation";
import { listerFluxProjetes } from "./cash-engine";
import { estimerDates, facturesEnRetard } from "./probaEstimation";
import { decalerDateISO } from "./dates";
import type { FactureAnalysee } from "./probaRisques";
import type { FactureClient } from "./types";

// Départ le 30/11/2026 : la semaine du lundi 14 au dimanche 20 décembre = jours 14 à 20.
const DEPART = "2026-11-30";
const j = (n: number) => decalerDateISO(DEPART, n);
const SEMAINE = { debut: "2026-12-14", fin: "2026-12-20" };

function obs(retards: number[], tiers: string): ObservationRetard[] {
  return retards.map((retard, i) => ({ cote: "client", tiers, cleTiers: cleTiers(tiers), montant: 10_000, echeance: decalerDateISO("2026-03-01", i * 3), dateReglement: decalerDateISO(decalerDateISO("2026-03-01", i * 3), retard), retard }));
}
// Clients : « Alpha » paie entre 2 et 30 jours après l'échéance ; « Lent » entre 60 et 140 jours.
const historique = [...obs([2, 5, 8, 10, 12, 14, 16, 18, 20, 22, 25, 30].flatMap((x) => [x, x]), "Alpha"), ...obs([60, 75, 90, 100, 110, 120, 130, 140].flatMap((x) => [x, x, x]), "Lent")];
const modeleClients: ModeleRetards = calibrerModele(historique, "client", DEPART);
const modeles = { client: modeleClients, fournisseur: calibrerModele([], "fournisseur", DEPART) };

const ligne = (cle: string, autres: Partial<LigneProbabiliste> = {}): LigneProbabiliste => ({ cle, probabilite: 100, condition: null, fiabiliteMontant: 100, modeDate: "echeance", aRenseigner: false, ...autres });
function evt(cle: string, jour: number, montant: number, autres: Partial<EvenementTresorerie> = {}): EvenementTresorerie {
  return { id: `${cle}#0`, cleLigne: cle, libelle: cle, montant: Math.abs(montant), sens: montant >= 0 ? "encaissement" : "decaissement", datePrevue: j(jour), dateEcheance: null, fiabiliteDate: 100, tiers: null, etage: montant >= 0 ? "revenue" : null, ...autres };
}
const facture = (cle: string, echeance: string | null = null): FactureAnalysee => ({ cleLigne: cle, type: "facture_client", numero: cle.toUpperCase(), client: `Client ${cle}`, dateEcheance: echeance });

function params(solde: number, lignes: LigneProbabiliste[], evenements: EvenementTresorerie[], factures: string[], autres: Partial<ParametresSemaine> = {}): ParametresSemaine {
  return { soldeInitial: solde, dateDepart: DEPART, horizonJours: 60, lignes, evenements, modeles, nombreSimulations: 2_000, graine: 2020, factures: factures.map((f) => facture(f, evenements.find((e) => e.cleLigne === f)?.dateEcheance ?? null)), semaine: SEMAINE, ...autres };
}

// Cas obligatoire : facture échue le 4 déc., encaissement prévu le 8 déc., dépense de 40 000 € le 20 déc.
const F_ECHEANCE = "2026-12-04";
function casObligatoire(autres: Partial<ParametresSemaine> = {}) {
  const lignes = [ligne("f"), ligne("dec")];
  const evenements = [evt("f", 8, 35_000, { dateEcheance: F_ECHEANCE, fiabiliteDate: 50, tiers: "Alpha" }), evt("dec", 20, -40_000)];
  return params(10_000, lignes, evenements, ["f"], autres);
}

describe("Semaines de l'horizon", () => {
  test("lundi -> dimanche, bornées à l'horizon", () => {
    const dates = Array.from({ length: 31 }, (_, i) => decalerDateISO("2026-11-25", i)); // mercredi -> vendredi
    const s = semainesDeLHorizon(dates);
    assert.deepEqual(s[0], { debut: "2026-11-25", fin: "2026-11-29", debutIndex: 0, finIndex: 4 });
    assert.deepEqual(s[1], { debut: "2026-11-30", fin: "2026-12-06", debutIndex: 5, finIndex: 11 });
    assert.equal(s[s.length - 1].fin, "2026-12-25");
    assert.equal(new Date(`${s[2].debut}T00:00:00Z`).getUTCDay(), 1);
  });

  test("risque hebdomadaire : une simulation négative plusieurs jours n'est comptée qu'une fois ; cohérent avec les mêmes simulations", () => {
    const p = casObligatoire();
    const sim = simuler(p);
    const ind = calculerIndicateurs(sim);
    const semaine = ind.semaines.find((w) => w.debut === SEMAINE.debut)!;
    let attendu = 0;
    for (let s = 0; s < sim.nombre; s++) {
      let neg = false;
      for (let d = semaine.debutIndex; d <= semaine.finIndex; d++) if (sim.soldes[d * sim.nombre + s] < 0) neg = true;
      if (neg) attendu++;
    }
    assert.equal(semaine.simulationsNegatives, attendu);
    // Négative plusieurs jours (déficit le 20, toujours là le 21… mais la semaine s'arrête le 20) : une seule fois.
    assert.ok(semaine.probaNegatif <= 1 && semaine.probaNegatif > 0);
    // Distinct du risque journalier et du risque sur l'horizon.
    assert.ok(semaine.probaNegatif >= ind.serie[20].probaNegatif);
    assert.ok(semaine.probaNegatif <= ind.probaNegatifHorizon);
    // L'analyse de la semaine utilise exactement les mêmes simulations.
    const r = analyserSemaine(p);
    assert.equal(r.simulationsNegatives, semaine.simulationsNegatives);
    assert.equal(r.probaNegatifSemaine, semaine.probaNegatif);
  });
});

describe("Rejeu exact des simulations", () => {
  test("une simulation rejouée est identique à sa colonne dans les 2 000 simulations", () => {
    const p = casObligatoire();
    const sim = simuler({ ...p, capturer: true });
    const prep = preparerSimulation(p);
    for (const s of [0, 1, 999, 1999]) {
      const r = rejouerSimulation(prep, etatDeSimulation(sim.etats!, s));
      assert.deepEqual(Array.from(r.soldes), Array.from({ length: sim.jours }, (_, d) => sim.soldes[d * sim.nombre + s]));
    }
  });
});

describe("Cas obligatoire : facture échue le 4 déc., prévue le 8 déc., déficit le 20 déc.", () => {
  test("la facture reste candidate pour la semaine du 14 au 20 décembre et sa correction évite le déficit", () => {
    const r = analyserSemaine(casObligatoire());
    assert.ok(r.simulationsNegatives > 0);
    const f = r.factures.find((x) => x.cleLigne === "f")!;
    assert.ok(f, "candidate alors que son échéance (4 déc.) et sa date prévue (8 déc.) précèdent la semaine");
    assert.equal(f.dateEcheance, F_ECHEANCE);
    assert.equal(f.dateReference, "2026-12-08");
    assert.equal(f.evite, r.analysees, "chaque simulation négative de la semaine est évitée en encaissant f à sa date");
    assert.equal(r.repartition.facture, r.analysees);
    const sc = f.scenario!;
    assert.ok(sc.dateSimulee === null || sc.dateSimulee > SEMAINE.fin, `encaissée après le 20 déc. (${sc.dateSimulee})`);
    assert.equal(sc.datePassageSousZero, "2026-12-20");
    assert.equal(sc.deficitMaxSemaine, 30_000);
    assert.equal(sc.effet, "evite");
    // Date limite CALCULÉE : un encaissement jusqu'au 20 déc. (jour de la dépense) évite le creux.
    assert.equal(sc.dateLimite, "2026-12-20");
    // Trajectoires de la vraie simulation et de sa correction.
    assert.equal(sc.trajectoires.simulee[20], -30_000);
    assert.equal(sc.trajectoires.corrigee[20], 5_000);
  });

  test("tester un décalage : paiement le 22 déc. -> sous zéro le 20 déc. ; le 16 déc. -> pas de déficit ; rien d'enregistré", () => {
    const p = casObligatoire();
    const avant = JSON.stringify({ lignes: p.lignes, evenements: p.evenements });
    const r = analyserSemaine(p);
    const s = r.factures[0].scenario!.simulation;
    const tard = testerDecalage(p, s, "f", "2026-12-22", SEMAINE);
    assert.deepEqual([tard.deficitSemaine, tard.datePassageSousZero], [30_000, "2026-12-20"]);
    const tot = testerDecalage(p, s, "f", "2026-12-16", SEMAINE);
    assert.deepEqual([tot.deficitSemaine, tot.datePassageSousZero], [0, null]);
    assert.equal(JSON.stringify({ lignes: p.lignes, evenements: p.evenements }), avant, "hypothèses inchangées");
  });

  test("facture échue bien avant l'horizon, encore ouverte : date estimée, candidate sans fenêtre rétrospective", () => {
    // Échue le 15 juillet (138 jours avant J0), date anticipée dépassée ; client « Lent » (60-140 j).
    const factures: FactureClient[] = [
      { id: "vieille", facture: "FA-2026-031", client: "Lent", montant: 35_000, dateEcheance: "2026-07-15", dateEncaissementAnticipee: "2026-09-01", litigieuse: false, payee: false, paidAt: null },
    ];
    const estimations = estimerDates(facturesEnRetard(factures, DEPART), modeleClients, DEPART);
    assert.equal(estimations[0].statut, "estimee");
    const datesEstimees = new Map(estimations.flatMap((e) => (e.statut === "estimee" ? [[e.factureId, e.date] as [string, string]] : [])));
    const projection = { facturesClients: factures, facturesFournisseurs: [], chargesFixes: [], autresDepenses: [], financements: [], rentreesRegulieres: [], dateDepart: DEPART, horizonJours: 60, datesEstimees };
    const flux = [...listerFluxProjetes(projection), { source: "autre_depense" as const, sourceId: "dec", libelle: "Dépense", date: "2026-12-20", montant: -40_000 }];
    const { lignes, evenements } = construireEvenements(flux, projection, [{ source: "facture_client", sourceId: "vieille", probabilite: 100, fiabiliteDate: 50, fiabiliteMontant: null, montantCible: null, condition: null }]);
    const r = analyserSemaine({ ...params(10_000, lignes, evenements, []), factures: [{ cleLigne: cleLigne("facture_client", "vieille"), type: "facture_client", numero: "FA-2026-031", client: "Lent", dateEcheance: "2026-07-15" }] });
    const f = r.factures.find((x) => x.numero === "FA-2026-031");
    assert.ok(r.simulationsNegatives > 0);
    assert.ok(f, "candidate malgré une échéance 5 mois avant la semaine");
    assert.equal(f!.dateReferenceEstimee, true);
    assert.ok(f!.evite > 0);
  });
});

describe("Contribution vérifiée, pas corrélation", () => {
  test("facture retardée sans effet sur la semaine : jamais classée « évite »", () => {
    // g : petite facture du 28 déc., souvent retardée mais après la semaine — sans effet sur elle.
    const p = params(
      10_000,
      [ligne("f"), ligne("g"), ligne("dec")],
      [evt("f", 8, 35_000, { dateEcheance: F_ECHEANCE, fiabiliteDate: 50, tiers: "Alpha" }), evt("g", 28, 5_000, { fiabiliteDate: 25, tiers: "Alpha" }), evt("dec", 20, -40_000)],
      ["f", "g"]
    );
    const r = analyserSemaine(p);
    const g = r.factures.find((x) => x.cleLigne === "g");
    assert.equal(g, undefined, "retardée mais sans effet : pas listée");
    assert.equal(r.factures[0].cleLigne, "f");
  });

  test("correction qui réduit seulement un déficit existant (tension déjà présente dans la référence)", () => {
    // Référence déjà à −2 000 € le 20 déc. : corriger f réduit le déficit sans le supprimer.
    const p = params(10_000, [ligne("f"), ligne("dec")], [evt("f", 8, 35_000, { dateEcheance: F_ECHEANCE, fiabiliteDate: 50, tiers: "Alpha" }), evt("dec", 20, -47_000)], ["f"]);
    const r = analyserSemaine(p);
    const f = r.factures.find((x) => x.cleLigne === "f")!;
    assert.equal(f.evite, 0);
    assert.ok(f.reduit > 0);
    assert.equal(f.scenario!.effet, "reduit");
    assert.equal(f.scenario!.deficitApresCorrection, 2_000);
    assert.equal(f.scenario!.dateLimite, null);
  });

  test("retard simultané à retards différents : chacune seule ne crée rien, ensemble oui ; corriger l'une suffit", () => {
    // Marge de 12 000 € le 20 déc. : une facture de 10 000 € en retard ne suffit pas, les deux oui.
    const p = params(
      4_000,
      [ligne("a"), ligne("b"), ligne("dec")],
      [evt("a", 3, 10_000, { fiabiliteDate: 25, tiers: "Alpha" }), evt("b", 10, 10_000, { fiabiliteDate: 50, tiers: "Alpha" }), evt("dec", 20, -12_000)],
      ["a", "b"]
    );
    const r = analyserSemaine(p);
    assert.ok(r.simulationsNegatives > 0);
    assert.equal(r.repartition.simultane, r.analysees, "toute simulation négative a les deux retards ; corriger l'un suffit");
    assert.deepEqual([r.duos[0].factures, r.duos[0].nature], [["a", "b"], "une_suffit"]);
    // Retards différents dans le scénario présenté de chaque facture.
    const a = r.factures.find((x) => x.cleLigne === "a")!.scenario!;
    const b = r.factures.find((x) => x.cleLigne === "b")!.scenario!;
    assert.ok(a.retardJours > 0 && b.retardJours > 0);
  });

  test("duo où les deux corrections sont nécessaires", () => {
    // Marge de 8 000 € : chaque retard de 10 000 € crée déjà le déficit ; il faut corriger les deux.
    const p = params(
      0,
      [ligne("a"), ligne("b"), ligne("dec")],
      [evt("a", 3, 10_000, { fiabiliteDate: 25, tiers: "Alpha" }), evt("b", 10, 10_000, { fiabiliteDate: 50, tiers: "Alpha" }), evt("dec", 20, -12_000)],
      ["a", "b"]
    );
    const r = analyserSemaine(p);
    assert.ok(r.repartition.duo > 0, JSON.stringify(r.repartition));
    assert.ok(r.duos.some((d) => d.nature === "les_deux" && d.factures.join() === "a,b"));
    assert.ok(r.repartition.facture > 0, "et des simulations où une seule est retardée");
  });

  test("une facture présente dans deux paires suffisantes d'un même scénario n'y est comptée qu'une fois", () => {
    // Trois factures de 10 000 € ; dépense de 15 000 € : il en faut deux à temps, n'importe lesquelles.
    const p = params(
      0,
      [ligne("a"), ligne("b"), ligne("c"), ligne("dec")],
      [
        evt("a", 3, 10_000, { fiabiliteDate: 25, tiers: "Lent" }),
        evt("b", 5, 10_000, { fiabiliteDate: 25, tiers: "Lent" }),
        evt("c", 7, 10_000, { fiabiliteDate: 25, tiers: "Lent" }),
        evt("dec", 20, -15_000),
      ],
      ["a", "b", "c"]
    );
    const r = analyserSemaine(p);
    assert.ok(r.repartition.duo > 0, JSON.stringify(r.repartition));
    assert.ok(r.duos.filter((d) => d.nature === "les_deux").length >= 2, "plusieurs paires suffisantes");
    for (const f of r.factures) assert.ok(f.dansUnDuo <= r.repartition.duo, `${f.cleLigne} : ${f.dansUnDuo} > ${r.repartition.duo}`);
    // Les trois sont en retard dans chaque scénario « duo » et appartiennent chacune à deux paires suffisantes.
    for (const f of r.factures) assert.equal(f.dansUnDuo, r.repartition.duo, f.cleLigne);
  });

  test("plus de deux factures nécessaires : « plusieurs encaissements », pas d'explication réductrice à deux", () => {
    const noms = ["f1", "f2", "f3", "f4", "f5", "f6"];
    const p = params(
      7_000 - 18_000 + 7_000,
      [...noms.map((n) => ligne(n)), ligne("dec")],
      [...noms.map((n, i) => evt(n, 2 + i, 3_000, { fiabiliteDate: 25, tiers: "Alpha" })), evt("dec", 20, -(7_000 - 18_000 + 7_000 + 18_000 - 7_000))],
      noms
    );
    const r = analyserSemaine(p);
    assert.ok(r.repartition.plusieurs > 0, JSON.stringify(r.repartition));
  });

  test("risque dû à un financement non obtenu : attribué à ce facteur, pas aux factures", () => {
    const p = params(
      5_000,
      [ligne("pret", { probabilite: 50 }), ligne("f"), ligne("dec")],
      [evt("pret", 5, 30_000, { etage: "financing" }), evt("f", 8, 10_000), evt("dec", 20, -40_000)],
      ["f"]
    );
    const r = analyserSemaine(p);
    assert.ok(r.simulationsNegatives > 0);
    assert.equal(r.repartition.autres, r.analysees);
    const pret = r.autresFacteurs.find((x) => x.cleLigne === "pret")!;
    assert.equal(pret.nature, "non_obtenu");
    assert.equal(pret.evite, r.analysees);
    assert.equal(r.factures.length, 0, "facture à date ferme : jamais présentée comme cause");
  });

  test("facture à date ferme : vulnérabilité séparée, jamais cause Monte Carlo", () => {
    const p = params(10_000, [ligne("f"), ligne("dec")], [evt("f", 8, 35_000, { fiabiliteDate: 100 }), evt("dec", 20, -40_000)], ["f"]);
    const r = analyserSemaine(p);
    assert.equal(r.simulationsNegatives, 0);
    assert.equal(r.factures.length, 0);
    assert.deepEqual(r.vulnerabilites.map((v) => [v.cleLigne, v.dateTestee, v.datePassageSousZero, v.deficit]), [["f", "2026-12-21", "2026-12-20", 30_000]]);
  });
});
