import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { comptesParNumero, depuisCompteBrut, depuisSoldeBrut, FormatComptableInattendu, sourcePennylane } from "./comptaPennylaneAdapter";
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

  test("un mois entier, comptes auxiliaires compris, par curseur, en GET", async () => {
    const { soldes, complete } = await source.lireBalanceDuMois("2026-02");
    assert.deepEqual(soldes.map((s) => s.compte), ["607000", "706000"]);
    assert.equal(complete, true);
    assert.equal(appels.length, 2);
    assert.ok(appels.every((a) => a.method === "GET"));
    const url = new URL(appels[0].url);
    assert.equal(url.pathname, "/api/external/v2/trial_balance");
    assert.equal(url.searchParams.get("period_start"), "2026-02-01");
    assert.equal(url.searchParams.get("period_end"), "2026-02-28");
    assert.equal(url.searchParams.get("is_auxiliary"), "true");
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

test("synchronisation réelle éteinte par défaut", () => {
  assert.equal(synchroComptableReelleActive(), false);
});
