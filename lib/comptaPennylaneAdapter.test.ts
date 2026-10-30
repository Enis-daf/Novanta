import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { depuisCompteBrut, depuisLigneBrute, FormatComptableInattendu, sourcePennylane } from "./comptaPennylaneAdapter";
import { synchroComptableReelleActive } from "./featureFlags";

const LIGNE = {
  id: 12,
  debit: "100.50",
  credit: "0.00",
  label: "Facture",
  date: "2026-03-15",
  ledger_account: { id: 7, number: "607000" },
  journal: { id: 3 },
  ledger_entry: { id: 99 },
  created_at: "2026-03-16T10:00:00Z",
  updated_at: "2026-03-16T10:00:00Z",
};

describe("Lecture des champs documentés", () => {
  test("ligne d'écriture", () => {
    const ligne = depuisLigneBrute(LIGNE);
    assert.deepEqual([ligne.idSource, ligne.idEcriture, ligne.idJournal, ligne.compte, ligne.date, ligne.debit, ligne.credit], ["12", "99", "3", "607000", "2026-03-15", 100.5, 0]);
    assert.equal(ligne.exclue, undefined, "aucun statut documenté : aucune exclusion supposée");
    assert.equal(ligne.statutSource, null);
  });

  test("compte", () => {
    assert.deepEqual(depuisCompteBrut({ id: 7, number: "607000", label: "Achats", type: "expense", enabled: true }), { idSource: "7", numero: "607000", libelle: "Achats", type: "expense", actif: true });
  });

  test("un format inattendu s'arrête net, jamais une ligne à 0", () => {
    assert.throws(() => depuisLigneBrute({ ...LIGNE, debit: "abc" }), FormatComptableInattendu);
    assert.throws(() => depuisLigneBrute({ ...LIGNE, credit: "" }), FormatComptableInattendu);
    assert.throws(() => depuisLigneBrute({ ...LIGNE, ledger_account: null }), FormatComptableInattendu);
    assert.throws(() => depuisLigneBrute({ ...LIGNE, date: "" }), FormatComptableInattendu);
    assert.throws(() => depuisCompteBrut({ id: 1, number: "" }), FormatComptableInattendu);
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
      const body = u.searchParams.get("cursor") ? { items: [{ ...LIGNE, id: 13 }], has_more: false, next_cursor: null } : { items: [LIGNE], has_more: true, next_cursor: "suite" };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = fetchOrigine;
  });

  const source = sourcePennylane({ getBearerToken: async () => "jeton-de-test" });

  test("pagination par curseur, filtre de date documenté, GET uniquement", async () => {
    const { lignes, complete } = await source.lirePeriode({ debut: "2026-03-01", fin: "2026-03-31" });
    assert.deepEqual(lignes.map((l) => l.idSource), ["12", "13"]);
    assert.equal(complete, true);
    assert.equal(appels.length, 2);
    assert.ok(appels.every((a) => a.method === "GET"));
    const url = new URL(appels[0].url);
    assert.equal(url.pathname, "/api/external/v2/ledger_entry_lines");
    assert.deepEqual(JSON.parse(url.searchParams.get("filter")!), [
      { field: "date", operator: "gteq", value: "2026-03-01" },
      { field: "date", operator: "lteq", value: "2026-03-31" },
    ]);
    assert.equal(url.searchParams.get("cursor"), null);
    assert.equal(new URL(appels[1].url).searchParams.get("cursor"), "suite");
  });

  test("le token ne sort jamais dans l'URL", async () => {
    await source.lirePeriode({ debut: "2026-03-01", fin: "2026-03-31" });
    assert.ok(appels.every((a) => !a.url.includes("jeton-de-test") && a.authorization === "Bearer jeton-de-test"));
  });

  test("403 : l'absence de droit remonte telle quelle", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    await assert.rejects(source.lireComptes(), (e: Error & { reason?: string }) => e.reason === "insufficient_scope");
  });
});

test("synchronisation réelle éteinte par défaut", () => {
  assert.equal(synchroComptableReelleActive(), false);
});
