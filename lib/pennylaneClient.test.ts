import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getMe, listTransactions, PennylaneApiError } from "./pennylaneClient";
import { PennylaneCredentialProvider } from "./pennylaneCredentialProvider";

const TOKEN_FACTICE = "pnl_test_token_ne_doit_jamais_apparaitre";

function provider(token = TOKEN_FACTICE): PennylaneCredentialProvider {
  return { getBearerToken: async () => token };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

let fetchOriginal: typeof fetch;
let appelsCaptures: { url: string; headers: Record<string, string> }[];

beforeEach(() => {
  fetchOriginal = global.fetch;
  appelsCaptures = [];
});

afterEach(() => {
  global.fetch = fetchOriginal;
});

function installerFetchMock(reponses: Response[]) {
  let index = 0;
  global.fetch = (async (url: string, init?: RequestInit) => {
    appelsCaptures.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} });
    const reponse = reponses[Math.min(index, reponses.length - 1)];
    index++;
    return reponse;
  }) as typeof fetch;
}

describe("getMe — GET /api/external/v2/me", () => {
  test("A. 200 : le token est valide, ne lève pas", async () => {
    installerFetchMock([jsonResponse(200, { user: {}, company: {} })]);
    await assert.doesNotReject(() => getMe(provider()));
  });

  test("B. 401 : token absent/invalide -> PennylaneApiError('invalid_token'), jamais une exception générique", async () => {
    installerFetchMock([jsonResponse(401, { error: "unauthorized" })]);
    await assert.rejects(() => getMe(provider()), (err: unknown) => {
      assert.ok(err instanceof PennylaneApiError);
      assert.equal(err.reason, "invalid_token");
      assert.equal(err.httpStatus, 401);
      return true;
    });
  });

  test("403 : droits insuffisants -> reason 'insufficient_scope'", async () => {
    installerFetchMock([jsonResponse(403, { error: "forbidden" })]);
    await assert.rejects(() => getMe(provider()), (err: unknown) => {
      assert.ok(err instanceof PennylaneApiError);
      assert.equal(err.reason, "insufficient_scope");
      return true;
    });
  });

  test("404 : endpoint/base URL incorrect -> reason 'unknown', jamais imputé au token de l'utilisateur", async () => {
    installerFetchMock([jsonResponse(404, {})]);
    await assert.rejects(() => getMe(provider()), (err: unknown) => {
      assert.ok(err instanceof PennylaneApiError);
      assert.equal(err.reason, "unknown");
      assert.equal(err.httpStatus, 404);
      return true;
    });
  });

  test("5xx : Pennylane indisponible -> reason 'unavailable'", async () => {
    installerFetchMock([jsonResponse(503, {})]);
    await assert.rejects(() => getMe(provider()), (err: unknown) => {
      assert.ok(err instanceof PennylaneApiError);
      assert.equal(err.reason, "unavailable");
      return true;
    });
  });

  test("le token n'apparaît jamais ailleurs que dans le header Authorization de la requête sortante", async () => {
    installerFetchMock([jsonResponse(200, {})]);
    await getMe(provider());
    assert.equal(appelsCaptures.length, 1);
    const authHeader = (appelsCaptures[0].headers as Record<string, string>).Authorization;
    assert.equal(authHeader, `Bearer ${TOKEN_FACTICE}`);
    // L'URL elle-même (souvent journalisée par des proxys/CDN) ne doit jamais contenir le token.
    assert.equal(appelsCaptures[0].url.includes(TOKEN_FACTICE), false);
  });
});

describe("listTransactions — GET /api/external/v2/transactions", () => {
  test("C. 403 sur transactions (après un token par ailleurs valide) -> reason 'insufficient_scope'", async () => {
    installerFetchMock([jsonResponse(403, {})]);
    await assert.rejects(() => listTransactions(provider(), "2026-08-01", "2026-08-01"), (err: unknown) => {
      assert.ok(err instanceof PennylaneApiError);
      assert.equal(err.reason, "insufficient_scope");
      return true;
    });
  });

  test("pagination : plusieurs pages sont concaténées jusqu'à has_more=false", async () => {
    installerFetchMock([
      jsonResponse(200, { items: [{ id: 1, date: "2026-08-01", label: "A", amount: "-10" }], has_more: true, next_cursor: "abc" }),
      jsonResponse(200, { items: [{ id: 2, date: "2026-08-02", label: "B", amount: "20" }], has_more: false, next_cursor: null }),
    ]);
    const resultat = await listTransactions(provider(), "2026-08-01", "2026-08-02");
    assert.equal(resultat.length, 2);
    assert.equal(appelsCaptures.length, 2);
  });

  test("429 : nouvelle tentative après le délai indiqué (retry-after), puis succès", async () => {
    installerFetchMock([
      jsonResponse(429, {}, { "retry-after": "1" }),
      jsonResponse(200, { items: [], has_more: false, next_cursor: null }),
    ]);
    const resultat = await listTransactions(provider(), "2026-08-01", "2026-08-01");
    assert.equal(resultat.length, 0);
    assert.equal(appelsCaptures.length, 2);
  });

  test("réponse vide : tableau vide, jamais une erreur", async () => {
    installerFetchMock([jsonResponse(200, { items: [], has_more: false, next_cursor: null })]);
    const resultat = await listTransactions(provider(), "2026-08-01", "2026-08-01");
    assert.deepEqual(resultat, []);
  });
});
