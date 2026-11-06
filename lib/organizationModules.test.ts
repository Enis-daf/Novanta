import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { moduleActifPourOrganisation } from "./organizationModules";

// Faux client : une seule ligne companies, comme la RLS la renvoie à l'utilisateur connecté.
function client(ligne: Record<string, unknown> | null) {
  return {
    from(table: string) {
      assert.equal(table, "companies", "organization_modules n'est plus lue");
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: ligne, error: null }) }) }) };
    },
  } as unknown as SupabaseClient;
}

describe("module Passé : inclus dans toutes les offres", () => {
  test("Essentiel sans abonnement payant : module actif, sans activation", async () => {
    assert.equal(await moduleActifPourOrganisation(client({ plan: "steering", access_enabled: false }), "org-1", "past"), true);
  });

  test("Prévision et Pilotage : module actif", async () => {
    for (const plan of ["forecast", "steering"]) {
      assert.equal(await moduleActifPourOrganisation(client({ plan, access_enabled: true }), "org-1", "past"), true, plan);
    }
  });

  test("société illisible : erreur, jamais un accès par défaut", async () => {
    await assert.rejects(moduleActifPourOrganisation(client(null), "org-x", "past"));
  });
});
