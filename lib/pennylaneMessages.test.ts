import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  MESSAGE_INDISPONIBLE,
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
    assert.equal(messageErreurConnexionInitiale("unavailable"), MESSAGE_MOCK_INJOIGNABLE);
    assert.equal(messageErreurUtilisationPennylane("unavailable"), MESSAGE_MOCK_INJOIGNABLE);
    assert.equal(messageErreurConnexionInitiale("rate_limited"), MESSAGE_INDISPONIBLE);
  });

  test("production : jamais de message de mock, même si la variable est définie", () => {
    delete process.env.NEXT_PUBLIC_NOVANTA_ENV;
    process.env.PENNYLANE_API_BASE_URL = "http://localhost:4010";
    assert.equal(messageErreurConnexionInitiale("unavailable"), MESSAGE_INDISPONIBLE);
  });
});
