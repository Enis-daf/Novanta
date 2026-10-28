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
