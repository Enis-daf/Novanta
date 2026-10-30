import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MODELE_CORRESPONDANCE, RegleCorrespondance } from "./comptaCorrespondance";
import { ExerciceComptable } from "./comptaExercices";
import { ChoixSource, ImportFec, regrouperConflits, resoudreSources, SoldeProvenance } from "./comptaSources";
import { assemblerVueComptable, DonneesVueComptable, exercicesDeLecture, periodeALire } from "./comptaVue";
import { AjustementComptable, ChoixStock, erreurAjustement } from "./comptaStocks";
import { analyserFec, preparerImportFec, soldesDepuisImportFec } from "./fecParseur";
import { exerciceSynthetique, fecDepuisLignes } from "./fecFixtures";
import { lignesDeComparaison, resumeSources } from "./comptaLecture";
import { calculerPnlCashEstime } from "./pastPnlCashEstime";
import { indexerMappings } from "./pastCategoryMapping";

const S = (source: SoldeProvenance["source"], mois: string, compte: string, debit: number, credit: number): SoldeProvenance => ({ source, mois, compte, debit, credit, nombreLignes: 0 });
const IMPORT_2024: ImportFec = { id: "i24", nomFichier: "FEC2024.txt", debut: "2024-01-01", fin: "2024-12-31", cloture: true, statut: "active", importeLe: "2025-05-01T00:00:00Z", resume: {} };
const choix = (source: ChoixSource["source"], debut = "2024-01-01", fin = "2024-12-31", choisiLe = "2025-06-01T00:00:00Z"): ChoixSource => ({ debut, fin, source, choisiLe });

describe("Une seule source par mois", () => {
  const fec = S("fec", "2024-03", "706000", 0, 100);
  const api = S("pennylane", "2024-03", "706000", 0, 90);

  test("uniquement FEC, ou uniquement API : la source présente", () => {
    assert.equal(resoudreSources([fec], []).soldes[0].credit, 100);
    assert.equal(resoudreSources([api], []).soldes[0].credit, 90);
    assert.equal(resoudreSources([fec], []).sourceParMois.get("2024-03"), "fec");
  });

  test("chevauchement sans décision : jamais additionné, mois hors calcul, conflit signalé", () => {
    const r = resoudreSources([fec, api], []);
    assert.deepEqual(r.moisEnConflit, ["2024-03"]);
    assert.equal(r.soldes.length, 0);
  });

  test("aucune source n'a de priorité : l'ordre de lecture ne change rien", () => {
    assert.deepEqual(resoudreSources([api, fec], []).moisEnConflit, ["2024-03"]);
  });

  test("décision : la source retenue seule, l'autre écartée", () => {
    assert.equal(resoudreSources([fec, api], [choix("fec")]).soldes[0].credit, 100);
    assert.equal(resoudreSources([fec, api], [choix("pennylane")]).soldes[0].credit, 90);
    assert.equal(resoudreSources([fec, api], [choix("fec")]).soldes.length, 1);
  });

  test("changement de source : le dernier choix fait foi, l'historique reste", () => {
    const r = resoudreSources([fec, api], [choix("fec", "2024-01-01", "2024-12-31", "2025-01-01T00:00:00Z"), choix("pennylane", "2024-01-01", "2024-12-31", "2025-02-01T00:00:00Z")]);
    assert.equal(r.soldes[0].credit, 90);
  });

  test("source retenue : un mois sans écriture chez elle reste vide, l'autre n'y entre pas", () => {
    const r = resoudreSources([fec, S("pennylane", "2024-04", "706000", 0, 90)], [choix("fec")]);
    assert.deepEqual(r.soldes.map((s) => s.mois), ["2024-03"]);
    assert.equal(r.sourceParMois.get("2024-04"), "fec");
  });

  test("hors de la période du choix : pas d'effet", () => {
    const r = resoudreSources([S("fec", "2025-03", "706000", 0, 1), S("pennylane", "2025-03", "706000", 0, 2)], [choix("fec")]);
    assert.deepEqual(r.moisEnConflit, ["2025-03"]);
  });

  test("source choisie retirée depuis : le choix tombe, l'autre source reprend", () => {
    assert.equal(resoudreSources([api], [choix("fec")]).soldes[0].credit, 90);
  });

  test("conflits regroupés par import : c'est sur sa période qu'on tranche", () => {
    assert.deepEqual(regrouperConflits(["2024-03", "2024-04"], [IMPORT_2024]), [{ debut: "2024-01-01", fin: "2024-12-31", mois: ["2024-03", "2024-04"], fichier: "FEC2024.txt" }]);
  });

  test("résumé des sources de la période", () => {
    assert.match(resumeSources({ "2024-01": "fec", "2024-02": "fec", "2024-03": "pennylane" })!, /FEC : .*janvier 2024.*février 2024.*Pennylane : mars 2024/);
    assert.equal(resumeSources({}), null);
  });
});

describe("Exercices lus", () => {
  const P26: ExerciceComptable = { idSource: "p26", debut: "2026-01-01", fin: "2026-12-31", statut: "open" };

  test("FEC seul : son exercice existe, clôturé seulement si déclaré", () => {
    assert.equal(exercicesDeLecture([], [IMPORT_2024], new Map())[0].statut, "closed");
    assert.equal(exercicesDeLecture([], [{ ...IMPORT_2024, cloture: false }], new Map())[0].statut, "open");
  });

  test("un import retiré ne compte plus", () => {
    assert.equal(exercicesDeLecture([], [{ ...IMPORT_2024, statut: "withdrawn" }], new Map()).length, 0);
  });

  test("même exercice des deux côtés : celui de la source retenue", () => {
    const fec26: ImportFec = { ...IMPORT_2024, id: "i26", debut: "2026-01-01", fin: "2026-12-31" };
    assert.equal(exercicesDeLecture([P26], [fec26], new Map([["2026-03", "pennylane"]]))[0].idSource, "p26");
    assert.equal(exercicesDeLecture([P26], [fec26], new Map([["2026-03", "fec"]]))[0].idSource, "fec:i26");
  });

  test("lecture élargie à l'exercice entier pour un mois affiché", () => {
    assert.deepEqual(periodeALire({ debut: "2024-03-01", fin: "2024-03-31" }, [], [IMPORT_2024]), { debut: "2024-01-01", fin: "2024-12-31" });
  });
});

const vide = (): DonneesVueComptable => ({
  exercicesPennylane: [],
  imports: [],
  choixSources: [],
  regles: [...MODELE_CORRESPONDANCE],
  comptes: [],
  stocks: [],
  choixStock: new Map(),
  choixAmortissement: new Map(),
  ajustementsSaisis: [],
  synchros: { derniere: null, derniereReussie: null },
  premiereEcriture: null,
});

async function soldesFec(annee = 2024) {
  const a = await analyserFec(async function* () {
    yield new TextEncoder().encode(fecDepuisLignes(exerciceSynthetique({ annee })));
  }, `123456789FEC${annee}1231.txt`);
  assert.equal(a.bloquant, false);
  const p = preparerImportFec(a, { debut: `${annee}-01-01`, fin: `${annee}-12-31`, cloture: true });
  return soldesDepuisImportFec(p.lignes).map((s): SoldeProvenance => ({ ...s, source: "fec" }));
}
const ANNEE = { debut: "2024-01-01", fin: "2024-12-31" };
const RESULTAT = 1_198_000 - 480_000 + 30_000 - 300_000 - 24_000 - 50_000;

describe("Critère de réussite : FEC seul, sans aucun appel à Pennylane", () => {
  test("du fichier au P&L analytique, exercice clôturé non provisoire", async () => {
    const v = assemblerVueComptable({ ...vide(), imports: [IMPORT_2024] }, await soldesFec(), ANNEE);
    assert.equal(v.pnl.chiffreAffaires, 1_198_000);
    assert.equal(v.pnl.resultatNet, RESULTAT);
    assert.equal(v.pnl.controle.equilibre, true);
    assert.equal(v.provisoire.provisoire, false);
    assert.equal(v.conflitsSource.length, 0);
    assert.equal(v.derniereSynchro, null);
    assert.equal(v.sourceParMois["2024-06"], "fec");
  });

  test("FEC d'un exercice déclaré non clôturé : provisoire", async () => {
    const v = assemblerVueComptable({ ...vide(), imports: [{ ...IMPORT_2024, cloture: false }] }, await soldesFec(), ANNEE);
    assert.equal(v.provisoire.provisoire, true);
  });

  test("comptes hors règles : alerte, jamais ignorés en silence", async () => {
    const regles: RegleCorrespondance[] = MODELE_CORRESPONDANCE.filter((r) => r.prefixe !== "64");
    const v = assemblerVueComptable({ ...vide(), imports: [IMPORT_2024], regles }, await soldesFec(), ANNEE);
    assert.equal(v.pnl.nonAffectes.comptes[0].compte, "641100");
    assert.equal(v.pnl.nonAffectes.significatif, true);
    assert.equal(v.pnl.complet, false);
  });

  test("modifier une correspondance recalcule sans réimporter", async () => {
    const soldes = await soldesFec();
    const avant = assemblerVueComptable({ ...vide(), imports: [IMPORT_2024] }, soldes, ANNEE);
    const regles = MODELE_CORRESPONDANCE.map((r) => (r.prefixe === "61" ? { ...r, destination: "direct_costs" as const } : r));
    const apres = assemblerVueComptable({ ...vide(), imports: [IMPORT_2024], regles }, soldes, ANNEE);
    assert.equal(apres.pnl.resultatNet, avant.pnl.resultatNet);
    assert.equal(apres.pnl.margeBrute, avant.pnl.margeBrute - 60_000);
  });

  test("mêmes règles sur plusieurs exercices", async () => {
    const soldes = [...(await soldesFec(2023)), ...(await soldesFec(2024))];
    const imports = [{ ...IMPORT_2024, id: "i23", debut: "2023-01-01", fin: "2023-12-31" }, IMPORT_2024];
    const a = assemblerVueComptable({ ...vide(), imports }, soldes, { debut: "2023-01-01", fin: "2023-12-31" });
    const b = assemblerVueComptable({ ...vide(), imports }, soldes, ANNEE);
    assert.equal(a.pnl.resultatNet, RESULTAT);
    assert.equal(b.pnl.resultatNet, RESULTAT);
    assert.equal(lignesDeComparaison(a.pnl, b.pnl).find((l) => l.cle === "resultat_net")?.a, RESULTAT);
  });

  test("période à cheval sur deux exercices FEC : cumul exact, sans double comptage", async () => {
    const soldes = [...(await soldesFec(2023)), ...(await soldesFec(2024))];
    const imports = [{ ...IMPORT_2024, id: "i23", debut: "2023-01-01", fin: "2023-12-31" }, IMPORT_2024];
    const v = assemblerVueComptable({ ...vide(), imports }, soldes, { debut: "2023-01-01", fin: "2024-12-31" });
    assert.equal(v.pnl.resultatNet, 2 * RESULTAT);
  });
});

describe("Coexistence avec l'API", () => {
  const api = [S("pennylane", "2024-03", "706000", 0, 7), S("pennylane", "2024-03", "411000", 7, 0)];

  test("chevauchement : mois en conflit, résultat incomplet, aucun cumul", async () => {
    const v = assemblerVueComptable({ ...vide(), imports: [IMPORT_2024] }, [...(await soldesFec()), ...api], ANNEE);
    assert.deepEqual(v.conflitsSource[0].mois, ["2024-03"]);
    assert.equal(v.pnl.complet, false);
    assert.equal(v.pnl.chiffreAffaires, 1_198_000 - 100_000);
  });

  test("décision FEC ou API : un seul chiffre, celui de la source", async () => {
    const soldes = [...(await soldesFec()), ...api];
    const fec = assemblerVueComptable({ ...vide(), imports: [IMPORT_2024], choixSources: [choix("fec")] }, soldes, ANNEE);
    const pennylane = assemblerVueComptable({ ...vide(), imports: [IMPORT_2024], choixSources: [choix("pennylane")] }, soldes, ANNEE);
    assert.equal(fec.pnl.chiffreAffaires, 1_198_000);
    assert.equal(fec.conflitsSource.length, 0);
    assert.equal(pennylane.pnl.chiffreAffaires, 7);
    assert.equal(pennylane.sourceParMois["2024-03"], "pennylane");
  });

  test("le FEC historique et l'API courante cohabitent sans décision", async () => {
    const courant = [S("pennylane", "2025-03", "706000", 0, 7), S("pennylane", "2025-03", "411000", 7, 0)];
    const v = assemblerVueComptable({ ...vide(), imports: [IMPORT_2024] }, [...(await soldesFec()), ...courant], { debut: "2024-01-01", fin: "2025-12-31" });
    assert.equal(v.conflitsSource.length, 0);
    assert.equal(v.pnl.chiffreAffaires, 1_198_000 + 7);
  });
});

describe("Ajustements sur l'exercice N", () => {
  const ajust = (mois: string, montant: number, nature: AjustementComptable["nature"] = "amortissement", ligne: AjustementComptable["ligne"] = "depreciation"): AjustementComptable => ({ id: `${mois}-${nature}`, date: `${mois}-28`, ligne, libelle: "x", montant, notes: null, nature });
  const douze = Array.from({ length: 12 }, (_, i) => ajust(`2024-${String(i + 1).padStart(2, "0")}`, -2_500));
  const decision = (source: ChoixStock["source"]) => new Map([["2024-01-01", { source, montantPennylane: null, montantNovanta: null, choisiLe: "x" }]]);

  test("stocks mensuels Novanta et variation comptable annuelle du FEC : conflit, une seule source", async () => {
    const stocks = Array.from({ length: 12 }, (_, i) => ({ mois: `2024-${String(i + 1).padStart(2, "0")}`, valeur: 1_000 * (i + 1) }));
    const soldes = await soldesFec();
    const sans = assemblerVueComptable({ ...vide(), imports: [IMPORT_2024], stocks }, soldes, ANNEE);
    assert.equal(sans.decisionsStock[0].conflit, true);
    assert.equal(sans.pnl.variationStocks, 30_000);
    const novanta = assemblerVueComptable({ ...vide(), imports: [IMPORT_2024], stocks, choixStock: decision("novanta") }, soldes, ANNEE);
    assert.equal(novanta.pnl.variationStocks, 11_000);
    assert.equal(novanta.pnl.margeBrute, 1_198_000 - 480_000 + 11_000);
  });

  test("dotations estimées seules : réparties comme saisies, résultat mensuel", async () => {
    const soldes = (await soldesFec()).filter((s) => !s.compte.startsWith("681") && !s.compte.startsWith("281"));
    const v = assemblerVueComptable({ ...vide(), imports: [{ ...IMPORT_2024, cloture: false }], ajustementsSaisis: douze }, soldes, { debut: "2024-03-01", fin: "2024-03-31" });
    assert.equal(v.pnl.amortissements, -2_500);
    assert.equal(v.decisionsAmortissement[0].conflit, false);
  });

  test("dotation annuelle comptable et estimées : conflit, jamais compté deux fois", async () => {
    const v = assemblerVueComptable({ ...vide(), imports: [IMPORT_2024], ajustementsSaisis: douze }, await soldesFec(), ANNEE);
    assert.equal(v.decisionsAmortissement[0].conflit, true);
    assert.equal(v.pnl.amortissements, -24_000);
    assert.equal(v.ajustementsEcartes.length, 12);
  });

  test("arbitrage : dotations estimées retenues, la dotation comptable ne compte plus", async () => {
    const v = assemblerVueComptable({ ...vide(), imports: [IMPORT_2024], ajustementsSaisis: douze, choixAmortissement: decision("novanta") }, await soldesFec(), ANNEE);
    assert.equal(v.pnl.amortissements, -30_000);
    assert.equal(v.decisionsAmortissement[0].conflit, false);
    assert.equal(v.pnl.controle.equilibre, true);
  });

  test("arbitrage : dotation comptable retenue", async () => {
    const v = assemblerVueComptable({ ...vide(), imports: [IMPORT_2024], ajustementsSaisis: douze, choixAmortissement: decision("pennylane") }, await soldesFec(), ANNEE);
    assert.equal(v.pnl.amortissements, -24_000);
    assert.equal(v.decisionsAmortissement[0].conflit, false);
  });

  test("modification d'une source après arbitrage : décision conservée, changement signalé", async () => {
    const choixMontants = new Map([["2024-01-01", { source: "pennylane" as const, montantPennylane: -20_000, montantNovanta: -30_000, choisiLe: "x" }]]);
    const v = assemblerVueComptable({ ...vide(), imports: [IMPORT_2024], ajustementsSaisis: douze, choixAmortissement: choixMontants }, await soldesFec(), ANNEE);
    assert.equal(v.decisionsAmortissement[0].source, "pennylane");
    assert.equal(v.decisionsAmortissement[0].sourceModifieeDepuisChoix, true);
  });

  test("cut-off : appliqué, même si la comptabilité a le même compte : un numéro ne prouve pas l'équivalence", async () => {
    const cutoff = ajust("2024-03", -1_000, "charge_a_rattacher", "structure_costs");
    const v = assemblerVueComptable({ ...vide(), imports: [{ ...IMPORT_2024, cloture: false }], ajustementsSaisis: [cutoff] }, await soldesFec(), ANNEE);
    assert.equal(v.pnl.coutsStructure, -300_000 - 1_000);
    assert.equal(v.ajustementsEcartes.length, 0);
    assert.equal(v.ajustementsAVerifier.length, 0);
  });

  test("cut-off sur un exercice clôturé : appliqué et signalé à vérifier", async () => {
    const cutoff = ajust("2024-03", -1_000, "charge_payee_d_avance", "structure_costs");
    const v = assemblerVueComptable({ ...vide(), imports: [IMPORT_2024], ajustementsSaisis: [cutoff] }, await soldesFec(), ANNEE);
    assert.equal(v.ajustementsAVerifier.length, 1);
    assert.equal(v.pnl.coutsStructure, -301_000);
  });

  test("la période couverte compte, pas seulement le mois de saisie", async () => {
    const cutoff = { ...ajust("2025-02", -1_000, "charge_a_rattacher", "structure_costs"), couvreDu: "2024-11-01", couvreAu: "2024-12-31" };
    const v = assemblerVueComptable({ ...vide(), imports: [IMPORT_2024], ajustementsSaisis: [cutoff] }, await soldesFec(), { debut: "2025-01-01", fin: "2025-12-31" });
    assert.equal(v.ajustementsAVerifier.length, 1);
  });

  test("le P&L cash estimé ne lit jamais ces ajustements ni le FEC", () => {
    const mapping = indexerMappings([{ sourceCategoryId: "v", sourceCategoryName: "V", sourceGroupId: "a", pnlStage: "revenue", vatRate: 20 }]);
    const t = { id: "t", sourceType: "pennylane" as const, transactionDate: "2024-03-10", label: "x", amount: 1200, currency: "EUR", affectations: [{ groupId: "a", categoryId: "v", categoryName: "V", weight: 1 }] };
    assert.equal(calculerPnlCashEstime([t], "a", mapping, []).soldeGestionEstime, 1000);
    assert.ok(calculerPnlCashEstime.length === 4);
  });

  test("saisie contrôlée : pas de stock ici, dotation sur sa ligne, montant non nul", () => {
    const ok = { date: "2024-03-31", ligne: "depreciation", libelle: "Dotation", montant: -100, nature: "amortissement" };
    assert.equal(erreurAjustement(ok), null);
    assert.match(erreurAjustement({ ...ok, ligne: "inventory_variation" })!, /stocks/);
    assert.match(erreurAjustement({ ...ok, ligne: "structure_costs" })!, /Amortissements/);
    assert.ok(erreurAjustement({ ...ok, montant: 0 }));
    assert.ok(erreurAjustement({ ...ok, libelle: " " }));
    assert.ok(erreurAjustement({ ...ok, nature: "x" }));
    assert.ok(erreurAjustement({ ...ok, couvreDu: "2024-12-01", couvreAu: "2024-01-01" }));
  });
});
