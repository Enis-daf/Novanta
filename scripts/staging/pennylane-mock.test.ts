import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { listCustomerInvoices, listSupplierInvoices, getMe, PennylaneApiError } from "../../lib/pennylaneClient";
import { calculerSynchronisation, candidatsFournisseursPennylane } from "../../lib/pennylaneInvoiceAdapter";
import { NOMBRE_FACTURES_REMPLISSAGE } from "./fixtures";

// Le vrai client HTTP Pennylane contre le serveur mock local : pagination, statuts et cycles.
const PORT = 4099;
const BASE = `http://localhost:${PORT}`;
const provider = { getBearerToken: async () => "jeton-mock" };

let serveur: ChildProcess;
let envOriginal: NodeJS.ProcessEnv;

async function cycle(numero: number): Promise<void> {
  await fetch(`${BASE}/__mock/cycle/${numero}`, { method: "POST" });
}

async function candidats() {
  return candidatsFournisseursPennylane(await listSupplierInvoices(provider)).candidats;
}

describe("serveur mock Pennylane", () => {
  before(async () => {
    envOriginal = { ...process.env };
    process.env.NEXT_PUBLIC_NOVANTA_ENV = "staging";
    process.env.PENNYLANE_API_BASE_URL = BASE;
    serveur = spawn(process.execPath, ["--import", "tsx", path.join(__dirname, "pennylane-mock.ts")], {
      env: { ...process.env, PENNYLANE_MOCK_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      serveur.stdout?.once("data", () => resolve());
      serveur.once("error", reject);
      serveur.once("exit", (code) => reject(new Error(`serveur mock arrêté (code ${code})`)));
    });
  });

  after(() => {
    serveur.kill();
    process.env = envOriginal;
  });

  test("un appel sans Bearer est refusé comme par Pennylane", async () => {
    await assert.rejects(getMe({ getBearerToken: async () => "" }), (erreur: unknown) => {
      return erreur instanceof PennylaneApiError && erreur.reason === "invalid_token";
    });
    await getMe(provider);
  });

  test("pagination : toutes les pages sont lues (plus de 200 factures)", async () => {
    await cycle(1);
    const items = await listSupplierInvoices(provider);
    assert.equal(items.length, 7 + NOMBRE_FACTURES_REMPLISSAGE);
    assert.equal(new Set(items.map((item) => item.id)).size, items.length);
    assert.equal((await listCustomerInvoices(provider)).length, 3);
  });

  test("cycle 1 : seules les factures ouvertes sont à importer, sans date et anciennes comprises", async () => {
    await cycle(1);
    const { aInserer } = calculerSynchronisation(await candidats(), []);
    assert.deepEqual(aInserer.map((c) => c.pennylaneId).sort(), ["1001", "1002", "1003", "1004", "1005", "1006"]);
    assert.equal(aInserer.find((c) => c.pennylaneId === "1005")?.dateEcheance, "");
    assert.equal(aInserer.find((c) => c.pennylaneId === "1006")?.dateEcheance, "2023-04-10");
  });

  test("cycle 2 : la facture Crocatus devient payée, sans nouvelle insertion", async () => {
    await cycle(1);
    const existantes = calculerSynchronisation(await candidats(), []).aInserer.map((c) => ({
      id: `novanta-${c.pennylaneId}`,
      pennylaneId: c.pennylaneId,
      payee: false,
    }));
    await cycle(2);
    const resultat = calculerSynchronisation(await candidats(), existantes);
    assert.deepEqual(resultat.aInserer, []);
    assert.deepEqual(resultat.idsAMettreAJourPayee, ["novanta-1001"]);
  });

  test("cycle 3 : nouvelles factures du mois suivant, version archivée retirée", async () => {
    await cycle(1);
    const existantes = calculerSynchronisation(await candidats(), []).aInserer.map((c) => ({
      id: `novanta-${c.pennylaneId}`,
      pennylaneId: c.pennylaneId,
      payee: c.pennylaneId === "1001",
    }));
    await cycle(3);
    const resultat = calculerSynchronisation(await candidats(), existantes);
    assert.deepEqual(resultat.aInserer.map((c) => c.pennylaneId).sort(), ["1008", "1010", "1011"]);
    assert.deepEqual(resultat.idsASupprimer, ["novanta-1004"]);
    assert.deepEqual(resultat.idsAMettreAJourPayee, []);
  });
});
