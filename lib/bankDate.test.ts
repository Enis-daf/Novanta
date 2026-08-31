import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { analyserDateBancaire } from "./bankDate";

describe("analyserDateBancaire", () => {
  test("vraie date Excel (objet Date)", () => {
    assert.equal(analyserDateBancaire(new Date(2026, 7, 31)), "2026-08-31");
  });

  test("objet Date invalide -> null", () => {
    assert.equal(analyserDateBancaire(new Date(NaN)), null);
  });

  test("DD/MM/YYYY", () => {
    assert.equal(analyserDateBancaire("01/01/2026"), "2026-01-01");
  });

  test("DD/MM/YY", () => {
    assert.equal(analyserDateBancaire("01/01/26"), "2026-01-01");
  });

  test("DD.MM.YYYY", () => {
    assert.equal(analyserDateBancaire("01.01.2026"), "2026-01-01");
  });

  test("DD.MM.YY", () => {
    assert.equal(analyserDateBancaire("01.01.26"), "2026-01-01");
  });

  test("DD-MM-YYYY", () => {
    assert.equal(analyserDateBancaire("01-01-2026"), "2026-01-01");
  });

  test("DD-MM-YY", () => {
    assert.equal(analyserDateBancaire("01-01-26"), "2026-01-01");
  });

  test("ne bascule jamais en interprétation MM/DD (US)", () => {
    // 03/04/2026 doit rester le 3 avril, jamais le 4 mars.
    assert.equal(analyserDateBancaire("03/04/2026"), "2026-04-03");
  });

  test("date invalide (jour hors bornes) -> null", () => {
    assert.equal(analyserDateBancaire("32/01/2026"), null);
  });

  test("date invalide (30 février, débordement silencieux) -> null", () => {
    assert.equal(analyserDateBancaire("30/02/2026"), null);
  });

  test("texte non reconnu -> null", () => {
    assert.equal(analyserDateBancaire("le 3 avril"), null);
  });

  test("cellule vide -> null", () => {
    assert.equal(analyserDateBancaire(""), null);
    assert.equal(analyserDateBancaire(undefined), null);
  });
});
