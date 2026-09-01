import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chiffrerTokenPennylane, dechiffrerTokenPennylane } from "./pennylaneCrypto";

before(() => {
  // Clé de test dédiée, jamais utilisée en production (voir PENNYLANE_TOKEN_ENCRYPTION_KEY).
  process.env.PENNYLANE_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("chiffrerTokenPennylane / dechiffrerTokenPennylane", () => {
  test("round-trip : le texte déchiffré est identique au texte d'origine", () => {
    const original = "pnl_live_abcdefghijklmnopqrstuvwxyz0123456789";
    const chiffre = chiffrerTokenPennylane(original);
    assert.equal(dechiffrerTokenPennylane(chiffre), original);
  });

  test("le texte chiffré ne contient jamais le token en clair", () => {
    const original = "pnl_secret_token_TRES_IDENTIFIABLE";
    const chiffre = chiffrerTokenPennylane(original);
    assert.equal(chiffre.includes(original), false);
  });

  test("deux chiffrements du même token produisent des résultats différents (IV aléatoire)", () => {
    const original = "meme-token";
    assert.notEqual(chiffrerTokenPennylane(original), chiffrerTokenPennylane(original));
  });

  test("un texte chiffré altéré (tag d'authentification invalide) est rejeté, jamais silencieusement accepté", () => {
    const chiffre = chiffrerTokenPennylane("token-original");
    const parties = chiffre.split(":");
    // Altère un octet du ciphertext lui-même.
    const octets = Buffer.from(parties[3], "base64");
    octets[0] = octets[0] ^ 0xff;
    const altere = [parties[0], parties[1], parties[2], octets.toString("base64")].join(":");
    assert.throws(() => dechiffrerTokenPennylane(altere));
  });

  test("un format stocké invalide (pas 4 segments, ou mauvaise version) est rejeté", () => {
    assert.throws(() => dechiffrerTokenPennylane("pas-le-bon-format"));
    assert.throws(() => dechiffrerTokenPennylane("v2:aa:bb:cc"));
  });
});
