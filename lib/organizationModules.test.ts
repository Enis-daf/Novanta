import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ligneModuleActive } from "./organizationModules";

describe("ligneModuleActive — entitlement d'un module pour une organisation", () => {
  test("aucune ligne : module inactif", () => {
    assert.equal(ligneModuleActive(null), false);
    assert.equal(ligneModuleActive(undefined), false);
  });

  test("ligne présente mais désactivée : module inactif", () => {
    assert.equal(ligneModuleActive({ enabled: false }), false);
  });

  test("seul enabled === true active le module (fail-closed)", () => {
    assert.equal(ligneModuleActive({ enabled: true }), true);
    assert.equal(ligneModuleActive({ enabled: "true" }), false);
    assert.equal(ligneModuleActive({ enabled: null }), false);
    assert.equal(ligneModuleActive({}), false);
  });
});
