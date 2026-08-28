import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normaliserLibelleBancaire } from "./bankTransaction";

describe("normaliserLibelleBancaire", () => {
  test("regroupe des variantes du même prélèvement avec référence technique variable", () => {
    const a = normaliserLibelleBancaire("PRLV SEPA ADOBE SYSTEMS IRELAND 8J2K39");
    const b = normaliserLibelleBancaire("PRLV SEPA ADOBE SYSTEMS IRELAND KJ29DK");
    const c = normaliserLibelleBancaire("PRLV SEPA ADOBE SYSTEMS IRELAND 92JD03");
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(a, "PRLV SEPA ADOBE SYSTEMS IRELAND");
  });

  test("insensible à la casse et aux accents", () => {
    assert.equal(normaliserLibelleBancaire("Électricité Générale"), normaliserLibelleBancaire("ELECTRICITE GENERALE"));
  });

  test("ne fusionne pas deux fournisseurs différents", () => {
    assert.notEqual(normaliserLibelleBancaire("NETFLIX.COM"), normaliserLibelleBancaire("SPOTIFY AB"));
  });

  test("ne retire pas un mot final qui n'est pas une référence technique plausible", () => {
    // "PARIS" est un mot, pas un mélange lettres+chiffres ni un long nombre : jamais retiré.
    assert.equal(normaliserLibelleBancaire("LOYER BUREAU PARIS"), "LOYER BUREAU PARIS");
  });

  test("chaîne vide reste vide", () => {
    assert.equal(normaliserLibelleBancaire(""), "");
  });
});
