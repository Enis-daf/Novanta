import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { issueSuppression, MESSAGES_SUPPRESSION } from "./actionSuppression";

describe("Suppression d'un chantier : lecture de la réponse", () => {
  test("supprimé", () => {
    assert.deepEqual(issueSuppression("supprime", null), { type: "supprime" });
  });

  test("déjà absent (supprimé ailleurs, ou introuvable) : pas une erreur", () => {
    assert.deepEqual(issueSuppression("absent", null), { type: "deja_absent" });
  });

  test("chantier actif refusé par la base", () => {
    assert.deepEqual(issueSuppression(null, { code: "55000", message: "…" }), {
      type: "echec",
      raison: "actif",
      message: MESSAGES_SUPPRESSION.actif,
    });
  });

  test("droits : autre société, module non activé, session expirée", () => {
    for (const code of ["42501", "PGRST301", "PGRST302"]) {
      const issue = issueSuppression(null, { code });
      assert.equal(issue.type === "echec" && issue.raison, "droits", code);
    }
  });

  test("migration non exécutée : fonction introuvable", () => {
    for (const code of ["PGRST202", "42883"]) {
      const issue = issueSuppression(null, { code });
      assert.equal(issue.type === "echec" && issue.raison, "non_activee", code);
    }
  });

  test("erreur serveur ou réponse inattendue : échec, jamais un faux succès", () => {
    assert.equal(issueSuppression(null, { code: "XX000" }).type, "echec");
    assert.equal(issueSuppression(null, new Error("réseau")).type, "echec");
    assert.equal(issueSuppression(null, null).type, "echec");
    assert.equal(issueSuppression("autre", null).type, "echec");
    assert.equal(issueSuppression(true, null).type, "echec");
  });
});

describe("Suppression d'un chantier : règle tenue en base", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261109_action_delete_closed_initiative.sql"), "utf8");
  // Le corps de la fonction, sans les commentaires.
  const corps = sql
    .split("\n")
    .filter((ligne) => !ligne.trim().startsWith("--"))
    .join("\n");

  test("un chantier actif est refusé (55000) avant toute suppression", () => {
    assert.match(corps, /if statut <> 'completed' then\s+raise exception [^;]+errcode = '55000'/);
    assert.ok(corps.indexOf("errcode = '55000'") < corps.indexOf("delete from action_initiatives"));
    assert.match(corps, /delete from action_initiatives\s+where id = p_initiative_id and organization_id = p_organization_id and status = 'completed'/);
  });

  test("mêmes droits que la RLS : sa société, module past activé", () => {
    assert.match(corps, /c\.owner_id = auth\.uid\(\)/);
    assert.match(corps, /m\.module_key = 'past' and m\.enabled/);
    assert.match(corps, /errcode = '42501'/);
    assert.match(corps, /revoke all on function public\.action_supprimer_chantier\(uuid, uuid\) from public, anon;/);
  });

  test("ne supprime qu'une ligne action_initiatives : aucune table financière touchée", () => {
    const suppressions = [...corps.matchAll(/delete from (\w+)/g)].map((m) => m[1]);
    assert.deepEqual(suppressions, ["action_initiatives"]);
    for (const table of ["past_", "transactions", "invoices", "factures", "companies", "organization_modules", "mapping"]) {
      assert.doesNotMatch(corps.replace(/from companies c where|from organization_modules m/g, ""), new RegExp(`(delete from|update|truncate)\\s+${table}`, "i"), table);
    }
  });

  test("les données du chantier partent par cascade : indicateurs, valeurs saisies", () => {
    const base = readFileSync(join(process.cwd(), "supabase/migrations/20261027_action_initiatives.sql"), "utf8");
    assert.match(base, /initiative_id uuid not null references action_initiatives\(id\) on delete cascade/);
    assert.match(base, /kpi_id uuid not null references action_initiative_kpis\(id\) on delete cascade/);
  });
});
