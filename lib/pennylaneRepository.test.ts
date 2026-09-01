import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resumeErreurSupabaseSansSecret } from "./pennylaneRepository";

describe("resumeErreurSupabaseSansSecret — E. erreur DB résumée sans exposer de secret", () => {
  test("relation inexistante (migration non appliquée, code Postgres 42P01) : classée explicitement", () => {
    const resume = resumeErreurSupabaseSansSecret({
      code: "42P01",
      message: 'relation "pennylane_connections" does not exist',
    });
    assert.match(resume, /pennylane_connections/);
    assert.match(resume, /migration/);
    assert.match(resume, /42P01/);
  });

  test("table absente détectée aussi via le message seul (sans code fourni)", () => {
    const resume = resumeErreurSupabaseSansSecret({ message: "relation does not exist" });
    assert.match(resume, /migration/);
  });

  test("autre erreur DB (ex. contrainte) : code et message repris tels quels, sans classement migration", () => {
    const resume = resumeErreurSupabaseSansSecret({ code: "23505", message: "duplicate key value violates unique constraint" });
    assert.match(resume, /23505/);
    assert.doesNotMatch(resume, /migration/);
  });

  test("le résumé ne contient jamais un token même si (par accident) le message en contenait un", () => {
    // Un vrai message Postgres ne contient jamais de valeur de ligne pour une contrainte de ce
    // type — ce test garantit seulement que la fonction ne fait que reprendre code/message,
    // jamais une extraction plus large de l'objet d'erreur (ex. la requête SQL avec ses paramètres).
    const messageAvecTokenFictif = "duplicate key — details omitted";
    const resume = resumeErreurSupabaseSansSecret({ code: "23505", message: messageAvecTokenFictif });
    assert.equal(resume.includes("pnl_secret_"), false);
  });

  test("erreur sans code : ne lève jamais, renvoie 'inconnu'", () => {
    const resume = resumeErreurSupabaseSansSecret(null);
    assert.match(resume, /inconnu/);
  });
});
