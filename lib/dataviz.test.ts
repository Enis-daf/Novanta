import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FAMILLE_BLEU_VERT, FAMILLE_ROSE, graduationsAxe, TEINTE_AUTRES, TEINTES_CATEGORIES, teintesDesParts, teintesParCategorie } from "./dataviz";
import { CLE_AUTRES, PartStructure, PnlCategorie } from "./pastPnl";

const cat = (id: string, etage: PnlCategorie["etage"], montant: number): PnlCategorie => ({
  sourceCategoryId: id,
  sourceCategoryName: id,
  etage,
  montant,
});
const part = (cle: string): PartStructure => ({ cle, nom: cle, montant: -1, part: 0.1 });

describe("palette dataviz centrale", () => {
  test("les teintes de catégories viennent de la palette et alternent les deux familles", () => {
    const rose: readonly string[] = FAMILLE_ROSE;
    const bleuVert: readonly string[] = FAMILLE_BLEU_VERT;
    TEINTES_CATEGORIES.forEach((teinte, index) => {
      assert.ok((index % 2 === 0 ? rose : bleuVert).includes(teinte), `${teinte} en position ${index}`);
    });
    assert.equal(new Set(TEINTES_CATEGORIES).size, TEINTES_CATEGORIES.length);
    assert.ok(!(TEINTES_CATEGORIES as readonly string[]).includes(TEINTE_AUTRES));
  });

  test("une catégorie a une teinte attitrée, par rang dans son étage", () => {
    const teintes = teintesParCategorie([
      cat("loyer", "ebitda", -300),
      cat("salaires", "ebitda", -900),
      cat("stripe", "revenue", 5000),
    ]);
    assert.equal(teintes.get("salaires"), TEINTES_CATEGORIES[0]);
    assert.equal(teintes.get("loyer"), TEINTES_CATEGORIES[1]);
    assert.equal(teintes.get("stripe"), TEINTES_CATEGORIES[0]);
  });

  test("la teinte attitrée suit la catégorie quand un filtre change l'ordre des parts", () => {
    const attitrees = new Map([
      ["a", TEINTES_CATEGORIES[0]],
      ["b", TEINTES_CATEGORIES[1]],
    ]);
    assert.deepEqual(teintesDesParts([part("b"), part("a")], attitrees), [TEINTES_CATEGORIES[1], TEINTES_CATEGORIES[0]]);
    assert.deepEqual(teintesDesParts([part("b")], attitrees), [TEINTES_CATEGORIES[1]]);
  });

  test("jamais deux parts de la même couleur ; « Autres » toujours gris", () => {
    // Deux catégories de premier rang dans deux étages différents, réunies dans un même camembert.
    const attitrees = new Map([
      ["a", TEINTES_CATEGORIES[0]],
      ["b", TEINTES_CATEGORIES[0]],
    ]);
    const teintes = teintesDesParts([part("a"), part("b"), part("sans-teinte"), part(CLE_AUTRES)], attitrees);
    assert.deepEqual(teintes, [TEINTES_CATEGORIES[0], TEINTES_CATEGORIES[1], TEINTES_CATEGORIES[2], TEINTE_AUTRES]);
  });
});

describe("graduations d'axe", () => {
  test("pas ronds, zéro toujours inclus, bornes englobant les données", () => {
    assert.deepEqual(graduationsAxe([27_500, 54_600, 12_000]), [0, 20_000, 40_000, 60_000]);
    assert.deepEqual(graduationsAxe([-590, -290, -440]), [-600, -400, -200, 0]);
    assert.deepEqual(graduationsAxe([47_400, -4_900]), [-20_000, 0, 20_000, 40_000, 60_000]);
    assert.deepEqual(graduationsAxe([0, 0]), [0, 1]);
    assert.deepEqual(graduationsAxe([]), [0, 1]);
  });
});
