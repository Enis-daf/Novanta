import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { accessEnabledForStatus } from "./billing";

describe("accessEnabledForStatus — accès Novanta piloté par le statut Stripe", () => {
  test("active et trialing donnent accès, quel que soit l'état courant", () => {
    assert.equal(accessEnabledForStatus("active", false), true);
    assert.equal(accessEnabledForStatus("trialing", false), true);
  });

  test("canceled et incomplete_expired retirent l'accès, quel que soit l'état courant", () => {
    assert.equal(accessEnabledForStatus("canceled", true), false);
    assert.equal(accessEnabledForStatus("incomplete_expired", true), false);
  });

  test("paused (essai terminé sans moyen de paiement) retire l'accès", () => {
    assert.equal(accessEnabledForStatus("paused", true), false);
  });

  test("un abonnement qui reprend (paused -> trialing/active) redonne accès immédiatement", () => {
    const accesApresPause = accessEnabledForStatus("paused", true);
    assert.equal(accesApresPause, false);
    assert.equal(accessEnabledForStatus("active", accesApresPause), true);
  });

  test("past_due et unpaid ne changent rien à l'accès courant (pas de blocage brutal)", () => {
    assert.equal(accessEnabledForStatus("past_due", true), true);
    assert.equal(accessEnabledForStatus("past_due", false), false);
    assert.equal(accessEnabledForStatus("unpaid", true), true);
  });

  test("un statut inconnu ne change rien à l'accès courant", () => {
    assert.equal(accessEnabledForStatus("statut_futur_inconnu", true), true);
    assert.equal(accessEnabledForStatus("statut_futur_inconnu", false), false);
  });
});
