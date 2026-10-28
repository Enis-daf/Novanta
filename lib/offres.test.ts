import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CAPACITES,
  Capacite,
  capacitesDeLOffre,
  droitsOrganisation,
  LIBELLES_OFFRES,
  messageOffreRequise,
  offreMinimale,
  refusOffre,
} from "./offres";

const MAINTENANT = new Date("2026-10-28T12:00:00Z");

function accessibles(plan: unknown): Capacite[] {
  const { capacites } = droitsOrganisation({ plan }, MAINTENANT);
  return CAPACITES.filter((c) => capacites[c]);
}

describe("matrice des offres", () => {
  test("Essentiel : reporting seulement", () => {
    assert.deepEqual(accessibles("essential"), ["canViewReporting"]);
  });

  test("Prévision : Essentiel + projection + analyse d'écarts, sans BFR / DSO / DPO / Actions", () => {
    assert.deepEqual(accessibles("forecast"), ["canViewReporting", "canViewForecast", "canViewVarianceAnalysis"]);
  });

  test("Pilotage : tout", () => {
    assert.deepEqual(accessibles("steering"), [...CAPACITES]);
  });

  test("chaque offre contient la précédente", () => {
    const essentiel = capacitesDeLOffre("essential");
    const prevision = capacitesDeLOffre("forecast");
    const pilotage = capacitesDeLOffre("steering");
    for (const c of CAPACITES) {
      if (essentiel[c]) assert.equal(prevision[c], true, c);
      if (prevision[c]) assert.equal(pilotage[c], true, c);
    }
  });

  test("libellés affichés exacts", () => {
    assert.deepEqual(LIBELLES_OFFRES, { essential: "Essentiel", forecast: "Prévision", steering: "Pilotage" });
  });
});

describe("plan absent ou invalide", () => {
  test("absent, null, vide : repli sur Essentiel", () => {
    for (const plan of [undefined, null, ""]) {
      const droits = droitsOrganisation({ plan }, MAINTENANT);
      assert.equal(droits.offreContractuelle, "essential");
      assert.deepEqual(accessibles(plan), ["canViewReporting"]);
    }
  });

  test("valeur inattendue : n'ouvre jamais plus qu'Essentiel", () => {
    for (const plan of ["Pilotage", "STEERING", "admin", "all", 3, true, { plan: "steering" }]) {
      assert.deepEqual(accessibles(plan), ["canViewReporting"], String(plan));
    }
  });
});

describe("override", () => {
  test("override supérieur sans échéance : appliqué, offre contractuelle conservée", () => {
    const droits = droitsOrganisation({ plan: "forecast", plan_override: "steering", plan_override_until: null }, MAINTENANT);
    assert.equal(droits.offreContractuelle, "forecast");
    assert.equal(droits.offreEffective, "steering");
    assert.equal(droits.overrideActif, true);
    assert.equal(droits.capacites.canViewActions, true);
  });

  test("override à échéance future : appliqué", () => {
    const droits = droitsOrganisation(
      { plan: "essential", plan_override: "steering", plan_override_until: "2026-11-27T12:00:00+00:00" },
      MAINTENANT
    );
    assert.equal(droits.offreEffective, "steering");
    assert.equal(droits.capacites.canViewWorkingCapital, true);
  });

  test("override expiré (ou échu à l'instant même) : retour à l'offre contractuelle", () => {
    for (const fin of ["2026-10-27T12:00:00Z", MAINTENANT.toISOString()]) {
      const droits = droitsOrganisation({ plan: "forecast", plan_override: "steering", plan_override_until: fin }, MAINTENANT);
      assert.equal(droits.offreEffective, "forecast");
      assert.equal(droits.overrideActif, false);
      assert.equal(droits.capacites.canViewWorkingCapital, false);
    }
  });

  test("override supprimé : retour à l'offre contractuelle", () => {
    const droits = droitsOrganisation({ plan: "forecast", plan_override: null, plan_override_until: null }, MAINTENANT);
    assert.equal(droits.offreEffective, "forecast");
    assert.equal(droits.overrideActif, false);
  });

  test("override invalide (valeur ou échéance illisible) : aucun accès supplémentaire", () => {
    const cas = [
      { plan_override: "pilotage" },
      { plan_override: "all" },
      { plan_override: 42 },
      { plan_override: "steering", plan_override_until: "pas une date" },
      { plan_override: "steering", plan_override_until: 1893456000000 },
    ];
    for (const override of cas) {
      const droits = droitsOrganisation({ plan: "essential", ...override }, MAINTENANT);
      assert.equal(droits.offreEffective, "essential", JSON.stringify(override));
      assert.equal(droits.overrideActif, false);
    }
  });

  test("override valide sur un plan invalide : l'override s'applique, le plan retombe sur Essentiel", () => {
    const droits = droitsOrganisation({ plan: "inconnu", plan_override: "forecast" }, MAINTENANT);
    assert.equal(droits.offreContractuelle, "essential");
    assert.equal(droits.offreEffective, "forecast");
  });
});

describe("offre requise affichée", () => {
  test("nomme l'offre minimale qui ouvre la capacité", () => {
    assert.equal(offreMinimale("canViewReporting"), "essential");
    assert.equal(offreMinimale("canViewForecast"), "forecast");
    assert.equal(offreMinimale("canViewVarianceAnalysis"), "forecast");
    assert.equal(offreMinimale("canViewWorkingCapital"), "steering");
    assert.equal(offreMinimale("canViewActions"), "steering");
    assert.equal(messageOffreRequise("canViewForecast"), "Disponible avec l'offre Prévision");
    assert.equal(messageOffreRequise("canViewWorkingCapital"), "Disponible avec l'offre Pilotage");
  });

  test("corps de refus serveur", () => {
    assert.deepEqual(refusOffre("canViewWorkingCapital"), {
      error: "Disponible avec l'offre Pilotage.",
      code: "offre_requise",
      offreRequise: "steering",
    });
  });
});
