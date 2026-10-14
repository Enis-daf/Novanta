import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  MESSAGE_INDISPONIBLE,
  MESSAGE_INJOIGNABLE,
  MESSAGE_INTROUVABLE,
  MESSAGE_LIMITE_REQUETES,
  MESSAGE_REPONSE_INATTENDUE,
  messageAutorisationsFacturesManquantes,
  MESSAGE_MOCK_INJOIGNABLE,
  MESSAGE_SCOPE_INSUFFISANT,
  MESSAGE_TOKEN_INVALIDE,
  messageErreurConnexionInitiale,
  messageErreurUtilisationPennylane,
} from "./pennylaneMessages";

describe("messages d'erreur Pennylane selon le mode", () => {
  let envOriginal: NodeJS.ProcessEnv;

  beforeEach(() => {
    envOriginal = { ...process.env };
  });

  afterEach(() => {
    process.env = envOriginal;
  });

  const modeReelStaging = () => {
    process.env.NEXT_PUBLIC_NOVANTA_ENV = "staging";
    process.env.PENNYLANE_API_BASE_URL = "";
  };
  const modeMock = () => {
    process.env.NEXT_PUBLIC_NOVANTA_ENV = "staging";
    process.env.PENNYLANE_API_BASE_URL = "http://localhost:4010";
  };

  test("clé invalide : message clair, identique en production, en staging réel et en mock", () => {
    delete process.env.NEXT_PUBLIC_NOVANTA_ENV;
    assert.equal(messageErreurConnexionInitiale("invalid_token"), MESSAGE_TOKEN_INVALIDE);
    modeReelStaging();
    assert.equal(messageErreurConnexionInitiale("invalid_token"), MESSAGE_TOKEN_INVALIDE);
    assert.equal(messageErreurConnexionInitiale("insufficient_scope"), MESSAGE_SCOPE_INSUFFISANT);
    modeMock();
    assert.equal(messageErreurConnexionInitiale("invalid_token"), MESSAGE_TOKEN_INVALIDE);
  });

  test("staging en mode réel : une indisponibilité reste le message Pennylane habituel", () => {
    modeReelStaging();
    assert.equal(messageErreurConnexionInitiale("unavailable"), MESSAGE_INDISPONIBLE);
    assert.equal(messageErreurUtilisationPennylane("unavailable"), MESSAGE_INDISPONIBLE);
  });

  test("mode mock, serveur mock arrêté : le message dit la vraie cause, pas « Pennylane indisponible »", () => {
    modeMock();
    assert.equal(messageErreurConnexionInitiale("network"), MESSAGE_MOCK_INJOIGNABLE);
    assert.equal(messageErreurUtilisationPennylane("network"), MESSAGE_MOCK_INJOIGNABLE);
    assert.equal(messageErreurConnexionInitiale("unavailable"), MESSAGE_INDISPONIBLE);
  });

  test("production : jamais de message de mock, même si la variable est définie", () => {
    delete process.env.NEXT_PUBLIC_NOVANTA_ENV;
    process.env.PENNYLANE_API_BASE_URL = "http://localhost:4010";
    assert.equal(messageErreurConnexionInitiale("network"), MESSAGE_INJOIGNABLE);
  });
});

describe("une cause réelle, un message : l'autorisation manquante est nommée", () => {
  test("403 sur les transactions : seul cas du message « transactions bancaires »", () => {
    const transactions = messageErreurConnexionInitiale("insufficient_scope", "/api/external/v2/transactions");
    assert.match(transactions, /transactions bancaires/);
    assert.match(transactions, /transactions:readonly/);
    // Sans endpoint connu (ancien appelant) : le message historique, sur les transactions.
    assert.equal(messageErreurConnexionInitiale("insufficient_scope"), MESSAGE_SCOPE_INSUFFISANT);
  });

  test("403 sur les factures : le message nomme les factures et l'autorisation, jamais les transactions", () => {
    const fournisseurs = messageErreurUtilisationPennylane("insufficient_scope", "/api/external/v2/supplier_invoices");
    assert.match(fournisseurs, /factures fournisseurs/);
    assert.match(fournisseurs, /supplier_invoices:readonly/);
    assert.doesNotMatch(fournisseurs, /transactions/);
    const clients = messageErreurUtilisationPennylane("insufficient_scope", "/api/external/v2/customer_invoices");
    assert.match(clients, /customer_invoices:readonly/);
    const deux = messageAutorisationsFacturesManquantes();
    assert.match(deux, /factures clients ni les factures fournisseurs/);
    assert.doesNotMatch(deux, /transactions/);
  });

  test("aucune autre cause n'est présentée comme un manque d'autorisation", () => {
    delete process.env.NEXT_PUBLIC_NOVANTA_ENV;
    const attendus: Record<string, string> = {
      invalid_token: MESSAGE_TOKEN_INVALIDE,
      not_found: MESSAGE_INTROUVABLE,
      network: MESSAGE_INJOIGNABLE,
      rate_limited: MESSAGE_LIMITE_REQUETES,
      unavailable: MESSAGE_INDISPONIBLE,
      unknown: MESSAGE_REPONSE_INATTENDUE,
    };
    for (const [raison, message] of Object.entries(attendus)) {
      const obtenu = messageErreurConnexionInitiale(raison as never, "/api/external/v2/transactions");
      assert.equal(obtenu, message, raison);
      assert.doesNotMatch(obtenu, /autorisation/, raison);
    }
  });
});
