import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CompteSource, LectureBalance, SoldeSource, SourceComptable } from "./comptaSource";
import { Declencheur, ExerciceComptable } from "./comptaExercices";
import { BilanSynchro, controlerBalance, DepotSynchro, synchroniserSociete } from "./comptaSynchro";
import { calculerPnlComptable } from "./comptaPnl";
import { PennylaneApiError } from "./pennylaneClient";

const S = (compte: string, debit: number, credit: number): SoldeSource => ({ compte, libelle: null, debit, credit });
const EQUILIBREE: LectureBalance = { soldes: [S("706000", 0, 100), S("411000", 100, 0)], complete: true };
const E2025: ExerciceComptable = { idSource: "25", debut: "2025-01-01", fin: "2025-12-31", statut: "closed" };
const E2026: ExerciceComptable = { idSource: "26", debut: "2026-01-01", fin: "2026-12-31", statut: "open" };
const E2027: ExerciceComptable = { idSource: "27", debut: "2027-01-01", fin: "2027-12-31", statut: "open" };
const AUJOURDHUI = "2026-03-15";

/** Dépôt en mémoire, par société : une société n'a accès qu'à son propre registre. */
function fauxDepot(societe = "A", registre: Map<string, Map<string, SoldeSource[]>> = new Map()) {
  const moisDe = () => {
    const m = registre.get(societe) ?? new Map<string, SoldeSource[]>();
    registre.set(societe, m);
    return m;
  };
  const etat = { enCours: false, bilans: [] as BilanSynchro[], declencheurs: [] as Declencheur[], comptes: 0, exercicesEnregistres: 0, ecritures: [] as string[] };
  const depot: DepotSynchro = {
    async commencer(d) {
      if (etat.enCours) return null;
      etat.enCours = true;
      etat.declencheurs.push(d);
      return "run";
    },
    async terminer(_, bilan) {
      etat.enCours = false;
      etat.bilans.push(bilan);
    },
    async enregistrerExercices(e) {
      etat.exercicesEnregistres += e.length;
    },
    exercicesConnus: async () => [],
    async enregistrerComptes(c) {
      etat.comptes += 1;
      return c.length;
    },
    moisDejaRempli: async (m) => (moisDe().get(m)?.length ?? 0) > 0,
    async remplacerMois(m, soldes) {
      etat.ecritures.push(m);
      moisDe().set(m, soldes);
      return 0;
    },
  };
  return { depot, etat, registre, mois: moisDe };
}

function fausseSource(options: { exercices?: ExerciceComptable[] | Error; balance?: (m: string) => LectureBalance | Error; comptes?: CompteSource[] | Error } = {}) {
  const lus: string[] = [];
  const source: SourceComptable = {
    nom: "fixtures",
    async lireExercices() {
      const e = options.exercices ?? [E2025, E2026, E2027];
      if (e instanceof Error) throw e;
      return e;
    },
    async lireComptes() {
      const c = options.comptes ?? [];
      if (c instanceof Error) throw c;
      return c;
    },
    async lireBalanceDuMois(m) {
      lus.push(m);
      const b = options.balance ? options.balance(m) : EQUILIBREE;
      if (b instanceof Error) throw b;
      return b;
    },
  };
  return { source, lus };
}

const demande = (declencheur: Declencheur, extra = {}) => ({ declencheur, aujourdhui: AUJOURDHUI, ...extra });
const lancer = async (source: SourceComptable, depot: DepotSynchro, d = demande("hebdomadaire")) => {
  const r = await synchroniserSociete(source, depot, d);
  assert.ok(r.lancee);
  return r.bilan;
};

describe("Périmètres, de bout en bout", () => {
  test("quotidien : deux mois, sans relire le plan de comptes", async () => {
    const { source, lus } = fausseSource();
    const { depot, etat } = fauxDepot();
    const bilan = await lancer(source, depot, demande("quotidien"));
    assert.deepEqual(lus, ["2026-02", "2026-03"]);
    assert.equal(etat.comptes, 0);
    assert.equal(bilan.moisActualises, 2);
    assert.equal(bilan.statut, "success");
  });

  test("hebdomadaire : l'exercice ouvert commencé ; ni le clôturé, ni le futur", async () => {
    const { source, lus } = fausseSource();
    const { depot, etat } = fauxDepot();
    await lancer(source, depot);
    assert.deepEqual(lus, ["2026-01", "2026-02", "2026-03"]);
    assert.equal(etat.comptes, 1);
  });

  test("plusieurs exercices ouverts : tous", async () => {
    const { source, lus } = fausseSource({ exercices: [{ ...E2025, statut: "open" }, E2026] });
    await lancer(source, fauxDepot().depot);
    assert.equal(lus.length, 15);
  });

  test("manuel : même périmètre, déclencheur tracé", async () => {
    const { source, lus } = fausseSource();
    const { depot, etat } = fauxDepot();
    await lancer(source, depot, demande("manuel"));
    assert.equal(lus.length, 3);
    assert.deepEqual(etat.declencheurs, ["manuel"]);
  });

  test("exceptionnelle : l'exercice clôturé désigné, explicitement", async () => {
    const { source, lus } = fausseSource();
    await lancer(source, fauxDepot().depot, demande("exceptionnel", { idExercice: "25" }));
    assert.equal(lus.length, 12);
    assert.equal(lus[0], "2025-01");
  });

  test("exceptionnelle sur un exercice inconnu : rien n'est lu", async () => {
    const { source, lus } = fausseSource();
    const { depot, etat } = fauxDepot();
    const r = await synchroniserSociete(source, depot, demande("exceptionnel", { idExercice: "x" }));
    assert.deepEqual(r, { lancee: false, raison: "exercice_inconnu" });
    assert.equal(lus.length, 0);
    assert.equal(etat.enCours, false, "verrou relâché");
  });

  test("exercices illisibles : mois récents, signalé, statut partiel", async () => {
    const { source, lus } = fausseSource({ exercices: new PennylaneApiError("insufficient_scope", "x", 403) });
    const bilan = await lancer(source, fauxDepot().depot);
    assert.equal(lus.length, 2);
    assert.equal(bilan.statut, "partial");
    assert.ok(bilan.limites.includes("exercices_indisponibles"));
  });
});

describe("Remplacement, jamais d'addition", () => {
  test("relire un mois remplace : modification rétroactive prise en compte, sans cumul", async () => {
    const { depot, mois } = fauxDepot();
    await lancer(fausseSource().source, depot);
    await lancer(fausseSource({ balance: (m) => (m === "2026-01" ? { soldes: [S("706000", 0, 250), S("411000", 250, 0)], complete: true } : EQUILIBREE) }).source, depot);
    assert.equal(mois().get("2026-01")![0].credit, 250);
    const soldes = [...mois()].flatMap(([m, s]) => s.map((x) => ({ compte: x.compte, mois: m, debit: x.debit, credit: x.credit, nombreLignes: 0 })));
    const p = calculerPnlComptable({ soldes, regles: [{ prefixe: "70", destination: "revenue", categorie: "V" }] });
    assert.equal(p.chiffreAffaires, 250 + 100 + 100);
  });

  test("relancer deux fois donne le même résultat", async () => {
    const { depot, mois } = fauxDepot();
    await lancer(fausseSource().source, depot);
    const avant = JSON.stringify([...mois()]);
    await lancer(fausseSource().source, depot);
    assert.equal(JSON.stringify([...mois()]), avant);
  });
});

describe("Échecs : les données précédentes restent", () => {
  const avecDonnees = async () => {
    const f = fauxDepot();
    await lancer(fausseSource().source, f.depot);
    return f;
  };

  test("réponse tronquée : mois non écrit, valeurs précédentes intactes", async () => {
    const f = await avecDonnees();
    const bilan = await lancer(fausseSource({ balance: (m) => (m === "2026-02" ? { soldes: [S("706000", 0, 1)], complete: false } : EQUILIBREE) }).source, f.depot);
    assert.deepEqual(bilan.moisEnEchec, [{ mois: "2026-02", raison: "troncature" }]);
    assert.equal(f.mois().get("2026-02")![0].credit, 100);
    assert.equal(bilan.moisActualises, 2);
    assert.equal(bilan.statut, "partial");
  });

  test("balance déséquilibrée : refusée", async () => {
    const f = await avecDonnees();
    const bilan = await lancer(fausseSource({ balance: () => ({ soldes: [S("706000", 0, 1)], complete: true }) }).source, f.depot);
    assert.equal(bilan.moisEnEchec[0].raison, "desequilibre");
    assert.equal(bilan.statut, "error");
    assert.equal(f.mois().get("2026-01")![0].credit, 100);
  });

  test("mois rempli devenu vide : gardé et signalé, jamais remplacé par du vide", async () => {
    const f = await avecDonnees();
    const bilan = await lancer(fausseSource({ balance: () => ({ soldes: [], complete: true }) }).source, f.depot);
    assert.equal(bilan.moisEnEchec[0].raison, "balance_vide_suspecte");
    assert.equal(f.mois().get("2026-01")!.length, 2);
  });

  test("période sans données, jamais remplie : mois vide accepté, sans alerte", async () => {
    const { depot } = fauxDepot();
    const bilan = await lancer(fausseSource({ balance: () => ({ soldes: [], complete: true }) }).source, depot);
    assert.equal(bilan.statut, "success");
    assert.equal(bilan.moisEnEchec.length, 0);
  });

  test("erreur réseau sur un mois : les autres continuent", async () => {
    const f = await avecDonnees();
    const bilan = await lancer(fausseSource({ balance: (m) => (m === "2026-02" ? new PennylaneApiError("network", "x") : EQUILIBREE) }).source, f.depot);
    assert.deepEqual(bilan.moisEnEchec, [{ mois: "2026-02", raison: "lecture" }]);
    assert.equal(bilan.moisActualises, 2);
    assert.equal(bilan.codeErreur, "network");
  });

  test("débit épuisé : arrêt propre, le reste est dit non lu", async () => {
    const f = await avecDonnees();
    const { source, lus } = fausseSource({ balance: (m) => (m === "2026-02" ? new PennylaneApiError("rate_limited", "x", 429) : EQUILIBREE) });
    const bilan = await lancer(source, f.depot);
    assert.deepEqual(lus, ["2026-01", "2026-02"]);
    assert.deepEqual(bilan.moisEnEchec, [{ mois: "2026-02", raison: "lecture" }, { mois: "2026-03", raison: "non_lu" }]);
  });

  test("droit retiré sur la balance : arrêt, données conservées, statut en erreur si rien n'est actualisé", async () => {
    const f = await avecDonnees();
    const bilan = await lancer(fausseSource({ balance: () => new PennylaneApiError("insufficient_scope", "x", 403) }).source, f.depot);
    assert.equal(bilan.statut, "error");
    assert.equal(bilan.moisActualises, 0);
    assert.equal(f.mois().size, 3);
  });

  test("token invalide : erreur globale, aucun mois lu, verrou relâché", async () => {
    const { depot, etat } = fauxDepot();
    const { source, lus } = fausseSource({ exercices: new PennylaneApiError("invalid_token", "x", 401) });
    const bilan = await lancer(source, depot);
    assert.equal(bilan.statut, "error");
    assert.equal(bilan.codeErreur, "invalid_token");
    assert.equal(lus.length, 0);
    assert.equal(etat.enCours, false);
  });

  test("écriture en échec sur un mois : compté, les autres continuent", async () => {
    const f = fauxDepot();
    const remplacer = f.depot.remplacerMois;
    f.depot.remplacerMois = async (m, s, r) => {
      if (m === "2026-02") throw new Error("base");
      return remplacer(m, s, r);
    };
    const bilan = await lancer(fausseSource().source, f.depot);
    assert.deepEqual(bilan.moisEnEchec, [{ mois: "2026-02", raison: "ecriture" }]);
    assert.equal(bilan.moisActualises, 2);
  });

  test("plan de comptes illisible : la balance est lue quand même, et c'est signalé", async () => {
    const bilan = await lancer(fausseSource({ comptes: new PennylaneApiError("insufficient_scope", "x", 403) }).source, fauxDepot().depot);
    assert.equal(bilan.moisActualises, 3);
    assert.ok(bilan.limites.includes("plan_de_comptes_indisponible"));
  });

  test("reprise après échec : le passage suivant répare sans état particulier", async () => {
    const f = await avecDonnees();
    await lancer(fausseSource({ balance: () => new PennylaneApiError("network", "x") }).source, f.depot);
    const bilan = await lancer(fausseSource({ balance: () => ({ soldes: [S("706000", 0, 999), S("411000", 999, 0)], complete: true }) }).source, f.depot);
    assert.equal(bilan.statut, "success");
    assert.equal(f.mois().get("2026-01")![0].credit, 999);
  });

  test("contrôle du nombre de périodes : demandées, actualisées, en échec", async () => {
    const bilan = await lancer(fausseSource({ balance: (m) => (m === "2026-01" ? new PennylaneApiError("network", "x") : EQUILIBREE) }).source, fauxDepot().depot);
    assert.equal(bilan.moisDemandes, 3);
    assert.equal(bilan.moisActualises + bilan.moisEnEchec.length, bilan.moisDemandes);
  });
});

describe("Concurrence et isolation", () => {
  test("deux synchronisations simultanées : la seconde est refusée, sans aucune lecture", async () => {
    const { depot } = fauxDepot();
    const { source, lus } = fausseSource();
    await depot.commencer("manuel");
    const r = await synchroniserSociete(source, depot, demande("manuel"));
    assert.deepEqual(r, { lancee: false, raison: "deja_en_cours" });
    assert.equal(lus.length, 0);
  });

  test("le verrou est relâché après un passage, même en échec", async () => {
    const { depot, etat } = fauxDepot();
    await lancer(fausseSource({ balance: () => new Error("réseau") }).source, depot);
    assert.equal(etat.enCours, false);
    assert.ok((await synchroniserSociete(fausseSource().source, depot, demande("manuel"))).lancee);
  });

  test("deux sociétés : aucune donnée ne passe de l'une à l'autre", async () => {
    const registre = new Map<string, Map<string, SoldeSource[]>>();
    const a = fauxDepot("A", registre);
    const b = fauxDepot("B", registre);
    await lancer(fausseSource({ balance: () => ({ soldes: [S("706000", 0, 1), S("411000", 1, 0)], complete: true }) }).source, a.depot);
    await lancer(fausseSource({ balance: () => ({ soldes: [S("706000", 0, 2), S("411000", 2, 0)], complete: true }) }).source, b.depot);
    assert.equal(a.mois().get("2026-01")![0].credit, 1);
    assert.equal(b.mois().get("2026-01")![0].credit, 2);
  });
});

describe("Contrôle d'une balance", () => {
  test("centimes : pas de faux déséquilibre flottant", () => {
    assert.equal(controlerBalance({ soldes: [S("1", 0.1, 0), S("2", 0.2, 0), S("3", 0, 0.3)], complete: true }), null);
  });

  test("incomplète avant équilibre", () => {
    assert.equal(controlerBalance({ soldes: [], complete: false }), "troncature");
  });
});
