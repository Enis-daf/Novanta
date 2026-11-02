import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Capacite } from "./offres";

// Garde-fou : chaque route serveur liée à une fonctionnalité soumise à l'offre revérifie la
// capacité elle-même (un appel direct à l'API ne doit pas contourner le verrou de l'écran), et
// répond 403 avec le corps commun refusOffre().
const ROUTES_PROTEGEES: { route: string; capacite: Capacite }[] = [
  { route: "app/api/passe/sync/route.ts", capacite: "canViewReporting" },
  { route: "app/api/passe/bfr/route.ts", capacite: "canViewWorkingCapital" },
  { route: "app/api/futur/fiabilite/route.ts", capacite: "canViewForecast" },
  { route: "app/api/pennylane/invoices/route.ts", capacite: "canViewForecast" },
  { route: "app/api/pennylane/invoices/settlement/route.ts", capacite: "canViewForecast" },
  { route: "app/api/pennylane/invoices/categories/route.ts", capacite: "canViewForecast" },
  { route: "app/api/pennylane/transactions/route.ts", capacite: "canViewForecast" },
];

describe("routes serveur soumises à l'offre", () => {
  for (const { route, capacite } of ROUTES_PROTEGEES) {
    test(`${route} exige ${capacite}`, () => {
      const source = readFileSync(join(process.cwd(), route), "utf8");
      assert.match(source, /await chargerDroitsOrganisation\(/);
      assert.ok(source.includes(`.capacites.${capacite})`), `capacité ${capacite} non vérifiée`);
      assert.ok(
        source.includes(`NextResponse.json(refusOffre("${capacite}"), { status: 403 })`),
        "réponse 403 refusOffre absente"
      );
    });
  }
});

describe("écrans du module Passé soumis à l'offre", () => {
  const passe = readFileSync(join(process.cwd(), "components/PasseTransactions.tsx"), "utf8");

  test("la synchronisation n'appelle la route BFR que si l'offre inclut le BFR", () => {
    assert.match(passe, /if \(droits\.capacites\.canViewWorkingCapital\) \{\s+try \{\s+const factures = await synchroniserFacturesBfr/);
  });

  test("l'export PDF ne charge et n'ajoute le BFR et les écarts que si l'offre les inclut", () => {
    assert.ok(passe.includes("const bfrInclus = droits.capacites.canViewWorkingCapital;"));
    assert.ok(passe.includes("const ecartsInclus = droits.capacites.canViewVarianceAnalysis;"));
    assert.ok(passe.includes("bfrInclus ? chargerFacturesBfr(supabase!, organizationId) : null"));
    assert.match(passe, /if \(ecartsInclus\) \{\s+pages\.push\(\s+pageEcartsPdf/);
  });

  test("les délais suivent canViewDSO et canViewDPO", () => {
    assert.ok(passe.includes("delaisVisibles={{ clients: droits.capacites.canViewDSO, fournisseurs: droits.capacites.canViewDPO }}"));
    assert.ok(passe.includes("clients: droits.capacites.canViewDSO,\n            fournisseurs: droits.capacites.canViewDPO,"));
  });
});
