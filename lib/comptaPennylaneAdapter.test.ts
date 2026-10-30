import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { comptesParNumero, depuisCompteBrut, depuisExerciceBrut, depuisSoldeBrut, FormatComptableInattendu, sourcePennylane } from "./comptaPennylaneAdapter";
import { attenteApres429, listTrialBalance } from "./pennylaneClient";
import { synchroComptableReelleActive } from "./featureFlags";

// Forme observée lors du diagnostic réel, avec des valeurs inventées.
const SOLDE = { number: "607000", formatted_number: "607000", label: "Achats", debits: "100.50", credits: "0.00" };

describe("Lecture des champs observés", () => {
  test("ligne de balance", () => {
    assert.deepEqual(depuisSoldeBrut(SOLDE), { compte: "607000", libelle: "Achats", debit: 100.5, credit: 0 });
  });

  test("le numéro retenu est `number`, celui des écritures, pas `formatted_number`", () => {
    assert.equal(depuisSoldeBrut({ ...SOLDE, number: "607", formatted_number: "607000" }).compte, "607");
  });

  test("compte", () => {
    assert.deepEqual(depuisCompteBrut({ id: 7, number: "607000", label: "Achats", type: "generic", enabled: true }), { idSource: "7", numero: "607000", libelle: "Achats", type: "generic", actif: true });
  });

  test("un format inattendu s'arrête net, jamais un solde à 0", () => {
    assert.throws(() => depuisSoldeBrut({ ...SOLDE, debits: "abc" }), FormatComptableInattendu);
    assert.throws(() => depuisSoldeBrut({ ...SOLDE, credits: "" }), FormatComptableInattendu);
    assert.throws(() => depuisSoldeBrut({ ...SOLDE, number: "" }), FormatComptableInattendu);
    assert.throws(() => depuisCompteBrut({ id: 1, number: "" }), FormatComptableInattendu);
  });
});

describe("Exercices", () => {
  test("champs observés : start, finish, status brut", () => {
    assert.deepEqual(depuisExerciceBrut({ id: 4, start: "2026-01-01", finish: "2026-12-31", status: "open" }), { idSource: "4", debut: "2026-01-01", fin: "2026-12-31", statut: "open" });
  });

  test("statut absent : null, jamais une clôture supposée", () => {
    assert.equal(depuisExerciceBrut({ id: 4, start: "2026-01-01", finish: "2026-12-31" }).statut, null);
  });

  test("dates illisibles : arrêt net", () => {
    assert.throws(() => depuisExerciceBrut({ id: 4, start: "", finish: "2026-12-31" }), FormatComptableInattendu);
  });
});

describe("Numéros de compte en double", () => {
  const compte = (idSource: string, numero: string, actif: boolean) => ({ idSource, numero, libelle: idSource, type: null, actif });

  test("un seul compte par numéro : l'enregistrement ne peut plus échouer sur un doublon", () => {
    assert.deepEqual(comptesParNumero([compte("1", "606", true), compte("2", "606", true), compte("3", "607", true)]).map((c) => c.numero), ["606", "607"]);
  });

  test("le compte actif est préféré, dans les deux ordres", () => {
    assert.equal(comptesParNumero([compte("1", "606", false), compte("2", "606", true)])[0].idSource, "2");
    assert.equal(comptesParNumero([compte("1", "606", true), compte("2", "606", false)])[0].idSource, "1");
  });
});

describe("Source Pennylane, sur une réponse simulée", () => {
  const fetchOrigine = globalThis.fetch;
  const appels: { url: string; method: string | undefined; authorization: string }[] = [];

  beforeEach(() => {
    appels.length = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      appels.push({ url: String(url), method: init?.method, authorization: (init?.headers as Record<string, string>).Authorization });
      const u = new URL(String(url));
      const body = u.searchParams.get("cursor") ? { items: [{ ...SOLDE, number: "706000" }], has_more: false, next_cursor: null } : { items: [SOLDE], has_more: true, next_cursor: "suite" };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = fetchOrigine;
  });

  const source = sourcePennylane({ getBearerToken: async () => "jeton-de-test" });

  test("un mois entier, comptes auxiliaires regroupés, par curseur, limit=1000, en GET", async () => {
    const { soldes, complete } = await source.lireBalanceDuMois("2026-02");
    assert.deepEqual(soldes.map((s) => s.compte), ["607000", "706000"]);
    assert.equal(complete, true);
    assert.equal(appels.length, 2);
    assert.ok(appels.every((a) => a.method === "GET"));
    const url = new URL(appels[0].url);
    assert.equal(url.pathname, "/api/external/v2/trial_balance");
    assert.equal(url.searchParams.get("period_start"), "2026-02-01");
    assert.equal(url.searchParams.get("period_end"), "2026-02-28");
    assert.equal(url.searchParams.get("is_auxiliary"), "false");
    assert.equal(url.searchParams.get("limit"), "1000");
    assert.equal(new URL(appels[1].url).searchParams.get("cursor"), "suite");
  });

  test("le token ne sort jamais dans l'URL", async () => {
    await source.lireBalanceDuMois("2026-02");
    assert.ok(appels.every((a) => !a.url.includes("jeton-de-test") && a.authorization === "Bearer jeton-de-test"));
  });

  test("403 : l'absence de droit remonte telle quelle", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    await assert.rejects(source.lireBalanceDuMois("2026-02"), (e: Error & { reason?: string }) => e.reason === "insufficient_scope");
  });
});

describe("Pagination et débit de la balance", () => {
  const fetchOrigine = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = fetchOrigine;
  });
  const provider = { getBearerToken: async () => "jeton" };
  const page = (corps: object, statut = 200, entetes: Record<string, string> = {}) => new Response(JSON.stringify(corps), { status: statut, headers: entetes });

  test("plusieurs pages : toutes lues, complet", async () => {
    let n = 0;
    globalThis.fetch = (async () => page(n++ === 0 ? { items: [SOLDE], has_more: true, next_cursor: "a" } : { items: [SOLDE], has_more: false, next_cursor: null })) as typeof fetch;
    const r = await listTrialBalance(provider, "2026-01-01", "2026-01-31");
    assert.equal(r.soldes.length, 2);
    assert.equal(r.complete, true);
  });

  test("une suite annoncée sans curseur : incomplet, jamais présenté comme entier", async () => {
    globalThis.fetch = (async () => page({ items: [SOLDE], has_more: true, next_cursor: null })) as typeof fetch;
    assert.equal((await listTrialBalance(provider, "2026-01-01", "2026-01-31")).complete, false);
  });

  test("pages sans fin : borne atteinte, incomplet", async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n += 1;
      return page({ items: [SOLDE], has_more: true, next_cursor: `c${n}` });
    }) as typeof fetch;
    const r = await listTrialBalance(provider, "2026-01-01", "2026-01-31");
    assert.equal(r.complete, false);
    assert.equal(n, 20);
  });

  test("429 puis succès : la lecture aboutit", async () => {
    let n = 0;
    globalThis.fetch = (async () => (n++ === 0 ? page({}, 429, { "retry-after": "0.01" }) : page({ items: [SOLDE], has_more: false, next_cursor: null }))) as typeof fetch;
    assert.equal((await listTrialBalance(provider, "2026-01-01", "2026-01-31")).complete, true);
    assert.equal(n, 2);
  });

  test("429 persistant : erreur typée, jamais une balance partielle", async () => {
    globalThis.fetch = (async () => page({}, 429, { "retry-after": "0.01" })) as typeof fetch;
    await assert.rejects(listTrialBalance(provider, "2026-01-01", "2026-01-31"), (e: Error & { reason?: string }) => e.reason === "rate_limited");
  });

  test("attente après un 429 : retry-after, sinon ratelimit-reset (horodatage), sinon 2 s, plafonnée", () => {
    const maintenant = 1_800_000_000_000;
    assert.equal(attenteApres429("3", "9999999999", maintenant), 3000);
    assert.equal(attenteApres429(null, "1800000004", maintenant), 4000);
    assert.equal(attenteApres429(null, null, maintenant), 2000);
    assert.equal(attenteApres429("abc", "1", maintenant), 2000);
    assert.equal(attenteApres429("9999", null, maintenant), 60_000);
  });
});

test("synchronisation réelle éteinte par défaut", () => {
  assert.equal(synchroComptableReelleActive(), false);
});
