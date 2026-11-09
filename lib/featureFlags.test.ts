import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { moduleActionActif } from "./featureFlags";

const source = (chemin: string) => readFileSync(join(process.cwd(), chemin), "utf8");

describe("Module Action", () => {
  test("éteint par défaut : ni bouton de navigation, ni page", () => {
    assert.equal(moduleActionActif(), false);
    assert.match(source("components/NavigationModules.tsx"), /module\.cle !== "action" \|\| moduleActionActif\(\)/);
    assert.match(source("app/action/page.tsx"), /!supabaseConfigured \|\| !moduleActionActif\(\)/);
  });

  test("réservé à l'offre qui inclut canViewActions", () => {
    const page = source("app/action/page.tsx");
    assert.match(page, /droits\.capacites\.canViewActions \?/);
    assert.match(page, /<OffreVerrouillee\s+capacite="canViewActions"/);
  });
});
