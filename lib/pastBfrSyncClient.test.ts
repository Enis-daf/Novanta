import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MAX_APPELS_SYNCHRO, synchroniserFacturesBfr } from "./pastBfrSyncClient";

// Serveur simulé : une réponse par appel, et les étapes demandées, dans l'ordre.
function serveur(reponses: { status?: number; corps: Record<string, unknown> }[]) {
  const etapes: string[] = [];
  const envoyer = (async (_url: string, init: { body: string }) => {
    etapes.push(JSON.parse(init.body).etape);
    const r = reponses[Math.min(etapes.length - 1, reponses.length - 1)];
    return new Response(JSON.stringify(r.corps), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { envoyer, etapes };
}

describe("Synchro unique — étape factures et règlements", () => {
  test("les factures, puis les règlements tant qu'il en reste ; chaque étape est annoncée", async () => {
    const { envoyer, etapes } = serveur([
      { corps: { factures: 1397, aDater: 500, complete: true } },
      { corps: { datees: 300, restantes: 200 } },
      { corps: { datees: 200, restantes: 0 } },
    ]);
    const messages: string[] = [];
    const r = await synchroniserFacturesBfr("jeton", (m) => messages.push(m), envoyer, "s1");
    assert.deepEqual(r, { statut: "termine", factures: 1397, listeComplete: true, restantes: 0 });
    assert.deepEqual(etapes, ["factures", "reglements", "reglements"]);
    assert.deepEqual(messages, ["Récupération des factures Pennylane…", "Récupération des règlements : 500 factures à dater…", "Récupération des règlements : 200 factures à dater…"]);
  });

  test("rien à dater : un seul appel", async () => {
    const { envoyer, etapes } = serveur([{ corps: { factures: 10, aDater: 0 } }]);
    const r = await synchroniserFacturesBfr("jeton", () => {}, envoyer, "s1");
    assert.equal(r.statut, "termine");
    assert.deepEqual(etapes, ["factures"]);
  });

  test("deux lots vides de suite : arrêt propre, le reste à dater est dit", async () => {
    const { envoyer, etapes } = serveur([{ corps: { factures: 10, aDater: 5 } }, { corps: { datees: 0, restantes: 5 } }]);
    const r = await synchroniserFacturesBfr("jeton", () => {}, envoyer, "s1");
    assert.deepEqual(r, { statut: "termine", factures: 10, listeComplete: true, restantes: 5 });
    assert.equal(etapes.length, 3);
  });

  test("nombre d'appels borné", async () => {
    const { envoyer, etapes } = serveur([{ corps: { factures: 10, aDater: 9_999 } }, { corps: { datees: 1, restantes: 9_000 } }]);
    await synchroniserFacturesBfr("jeton", () => {}, envoyer, "s1");
    assert.equal(etapes.length, MAX_APPELS_SYNCHRO + 1);
  });

  test("offre sans BFR : pas une erreur, rien à synchroniser", async () => {
    const { envoyer } = serveur([{ status: 403, corps: { code: "offre_requise", error: "Disponible avec l'offre Pilotage." } }]);
    assert.deepEqual(await synchroniserFacturesBfr("jeton", () => {}, envoyer, "s1"), { statut: "hors_offre" });
  });

  test("autre refus : l'erreur du serveur remonte", async () => {
    const { envoyer } = serveur([{ status: 400, corps: { error: "Token invalide." } }]);
    await assert.rejects(synchroniserFacturesBfr("jeton", () => {}, envoyer, "s1"), /Token invalide/);
  });
});
