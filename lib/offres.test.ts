import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CAPACITES,
  Capacite,
  capacitesDeLOffre,
  chargerDroitsOrganisation,
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

describe("essai (Test) : droits Pilotage, retour à l'offre contractuelle à l'échéance", () => {
  const FIN_ESSAI = "2026-11-15T10:00:00.000Z";
  const essai = (plan: unknown, fin: unknown = FIN_ESSAI, statut: unknown = "trialing") => ({
    plan,
    subscription_status: statut,
    subscription_current_period_end: fin,
  });

  test("Essentiel + essai actif : droits Pilotage", () => {
    const droits = droitsOrganisation(essai("essential"), MAINTENANT);
    assert.equal(droits.essaiActif, true);
    assert.equal(droits.offreEffective, "steering");
    assert.deepEqual(droits.capacites, capacitesDeLOffre("steering"));
  });

  test("Prévision + essai actif : droits Pilotage", () => {
    const droits = droitsOrganisation(essai("forecast"), MAINTENANT);
    assert.equal(droits.offreEffective, "steering");
    assert.equal(droits.capacites.canViewWorkingCapital, true);
    assert.equal(droits.capacites.canViewDSO, true);
    assert.equal(droits.capacites.canViewDPO, true);
    assert.equal(droits.capacites.canViewActions, true);
  });

  test("l'offre contractuelle reste celle de la base pendant l'essai", () => {
    const brute = essai("essential");
    const droits = droitsOrganisation(brute, MAINTENANT);
    assert.equal(droits.offreContractuelle, "essential");
    assert.equal(brute.plan, "essential");
  });

  test("essai échu (date passée ou à l'instant même) : retour automatique à l'offre contractuelle", () => {
    for (const fin of ["2026-10-27T12:00:00Z", MAINTENANT.toISOString()]) {
      const droits = droitsOrganisation(essai("essential", fin), MAINTENANT);
      assert.equal(droits.essaiActif, false);
      assert.equal(droits.offreEffective, "essential");
      assert.deepEqual(accessiblesDe(droits), ["canViewReporting"]);
    }
    // Même essai, lu avant puis après l'échéance : rien à changer en base.
    const brute = essai("forecast");
    assert.equal(droitsOrganisation(brute, new Date("2026-11-15T09:59:59Z")).offreEffective, "steering");
    assert.equal(droitsOrganisation(brute, new Date("2026-11-15T10:00:01Z")).offreEffective, "forecast");
  });

  test("abonnement sorti de l'essai (active, paused, canceled…) : offre contractuelle", () => {
    for (const statut of ["active", "paused", "canceled", "past_due", null, "TRIALING"]) {
      assert.equal(droitsOrganisation(essai("forecast", FIN_ESSAI, statut), MAINTENANT).offreEffective, "forecast", String(statut));
    }
  });

  test("essai sans fin lisible : aucun accès supplémentaire", () => {
    for (const fin of [null, undefined, "", "pas une date", 1893456000]) {
      const droits = droitsOrganisation({ plan: "essential", subscription_status: "trialing", subscription_current_period_end: fin }, MAINTENANT);
      assert.equal(droits.essaiActif, false, String(fin));
      assert.equal(droits.offreEffective, "essential");
    }
  });

  test("override manuel valide : prioritaire sur l'essai", () => {
    const droits = droitsOrganisation({ ...essai("forecast"), plan_override: "essential" }, MAINTENANT);
    assert.equal(droits.overrideActif, true);
    assert.equal(droits.essaiActif, false);
    assert.equal(droits.offreEffective, "essential");
  });

  test("override expiré pendant un essai actif : l'essai s'applique", () => {
    const droits = droitsOrganisation(
      { ...essai("essential"), plan_override: "forecast", plan_override_until: "2026-10-01T00:00:00Z" },
      MAINTENANT
    );
    assert.equal(droits.offreEffective, "steering");
    assert.equal(droits.essaiActif, true);
  });
});

describe("chargerDroitsOrganisation : relu en base à chaque appel (pages, rechargement, routes)", () => {
  function clientFactice(ligne: Record<string, unknown> | null) {
    const appel: { colonnes?: string; id?: string } = {};
    const client = {
      from(table: string) {
        assert.equal(table, "companies");
        return {
          select(colonnes: string) {
            appel.colonnes = colonnes;
            return {
              eq(colonne: string, valeur: string) {
                assert.equal(colonne, "id");
                appel.id = valeur;
                return { maybeSingle: async () => ({ data: ligne, error: null }) };
              },
            };
          },
        };
      },
    };
    return { client: client as unknown as Parameters<typeof chargerDroitsOrganisation>[0], appel };
  }

  test("lit l'offre ET l'essai de l'organisation demandée", async () => {
    const { client, appel } = clientFactice({
      plan: "essential",
      plan_override: null,
      plan_override_until: null,
      subscription_status: "trialing",
      subscription_current_period_end: "2026-11-15T10:00:00.000Z",
    });
    const pendant = await chargerDroitsOrganisation(client, "org-1", MAINTENANT);
    assert.equal(appel.id, "org-1");
    for (const colonne of ["plan", "plan_override", "plan_override_until", "subscription_status", "subscription_current_period_end"]) {
      assert.ok(appel.colonnes?.split(",").map((c) => c.trim()).includes(colonne), colonne);
    }
    // Route Pilotage (ex. BFR) : autorisée pendant l'essai, refusée après, sans écriture en base.
    assert.equal(pendant.capacites.canViewWorkingCapital, true);
    const apres = await chargerDroitsOrganisation(client, "org-1", new Date("2026-11-16T00:00:00Z"));
    assert.equal(apres.capacites.canViewWorkingCapital, false);
    assert.equal(apres.offreEffective, "essential");
  });

  test("société illisible : erreur, jamais un droit par défaut", async () => {
    const { client } = clientFactice(null);
    await assert.rejects(chargerDroitsOrganisation(client, "org-x", MAINTENANT));
  });
});

function accessiblesDe(droits: { capacites: Record<Capacite, boolean> }): Capacite[] {
  return CAPACITES.filter((c) => droits.capacites[c]);
}
