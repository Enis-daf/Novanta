import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { analyserMontantCellule, resoudreColonneMontants, resoudreMontantAmbigu } from "./bankMontant";

describe("analyserMontantCellule", () => {
  test("vraie valeur numérique Excel : utilisée telle quelle", () => {
    const r = analyserMontantCellule(-39.17);
    assert.equal(r.ok, true);
    assert.equal(r.valeur, -39.17);
  });

  test('"1 200,92" (espace milliers, virgule décimale)', () => {
    assert.equal(analyserMontantCellule("1 200,92").valeur, 1200.92);
  });

  test('"1.200,92" (point milliers, virgule décimale)', () => {
    assert.equal(analyserMontantCellule("1.200,92").valeur, 1200.92);
  });

  test('"1,200.92" (virgule milliers, point décimal)', () => {
    assert.equal(analyserMontantCellule("1,200.92").valeur, 1200.92);
  });

  test('"1200,92"', () => {
    assert.equal(analyserMontantCellule("1200,92").valeur, 1200.92);
  });

  test('"1200.92"', () => {
    assert.equal(analyserMontantCellule("1200.92").valeur, 1200.92);
  });

  test('"1 200,92 €" (symbole monétaire)', () => {
    assert.equal(analyserMontantCellule("1 200,92 €").valeur, 1200.92);
  });

  test('"-1 200,92"', () => {
    assert.equal(analyserMontantCellule("-1 200,92").valeur, -1200.92);
  });

  test('"+1 200,92"', () => {
    assert.equal(analyserMontantCellule("+1 200,92").valeur, 1200.92);
  });

  test('"(1 200,92)" (parenthèses comptables = négatif)', () => {
    assert.equal(analyserMontantCellule("(1 200,92)").valeur, -1200.92);
  });

  test("espace insécable (U+00A0) et espace fine insécable (U+202F)", () => {
    assert.equal(analyserMontantCellule("1 200,92").valeur, 1200.92);
    assert.equal(analyserMontantCellule("1 200,92").valeur, 1200.92);
  });

  test('"1,200" isolé : ambigu, ne devine jamais seul', () => {
    const r = analyserMontantCellule("1,200");
    assert.equal(r.ok, false);
    assert.equal(r.ambigu, true);
  });

  test("cellule vide -> invalide (pas ambigu)", () => {
    const r = analyserMontantCellule("");
    assert.equal(r.ok, false);
    assert.equal(r.ambigu, false);
  });

  test("texte non numérique -> invalide", () => {
    const r = analyserMontantCellule("abc");
    assert.equal(r.ok, false);
    assert.equal(r.ambigu, false);
  });
});

describe("resoudreMontantAmbigu", () => {
  test('"1,200" avec convention virgule-décimale de la colonne -> 1.2', () => {
    assert.equal(resoudreMontantAmbigu("1,200", ","), 1.2);
  });

  test('"1,200" avec convention point-décimal de la colonne (virgule = milliers) -> 1200', () => {
    assert.equal(resoudreMontantAmbigu("1,200", "."), 1200);
  });
});

describe("resoudreColonneMontants", () => {
  test("colonne cohérente en virgule décimale : résout la cellule ambiguë via le contexte", () => {
    // "39,17" révèle la convention "virgule = décimale" ; "1,200" est alors 1.2.
    const resultat = resoudreColonneMontants(["39,17", "1,200", "42,50"]);
    assert.equal(resultat.ok, true);
    assert.deepEqual(resultat.valeurs, [39.17, 1.2, 42.5]);
  });

  test("colonne cohérente en point décimal : résout la cellule ambiguë via le contexte", () => {
    const resultat = resoudreColonneMontants(["39.17", "1,200", "42.50"]);
    assert.equal(resultat.ok, true);
    assert.deepEqual(resultat.valeurs, [39.17, 1200, 42.5]);
  });

  test("aucune cellule ne permet de trancher : colonne globalement ambiguë, bloquée", () => {
    const resultat = resoudreColonneMontants(["1,200", "2,300"]);
    assert.equal(resultat.ok, false);
  });

  test("cellules non ambiguës isolées ne posent pas de problème", () => {
    const resultat = resoudreColonneMontants(["39,17", "42,50", "-15,00"]);
    assert.equal(resultat.ok, true);
    assert.deepEqual(resultat.valeurs, [39.17, 42.5, -15]);
  });
});
