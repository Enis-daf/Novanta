import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { capacitesDeLOffre } from "./offres";

describe("Module Action selon l'offre", () => {
  test("inclus dans Pilotage seulement", () => {
    assert.equal(capacitesDeLOffre("essential").canViewActions, false);
    assert.equal(capacitesDeLOffre("forecast").canViewActions, false);
    assert.equal(capacitesDeLOffre("steering").canViewActions, true);
  });

  test("hors Pilotage, la page affiche l'offre verrouillée au lieu du module", () => {
    const page = readFileSync(join(process.cwd(), "app/action/page.tsx"), "utf8");
    assert.match(page, /droits\.capacites\.canViewActions \?/);
    assert.match(page, /<OffreVerrouillee\s+capacite="canViewActions"/);
  });
});
