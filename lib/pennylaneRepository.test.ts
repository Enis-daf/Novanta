import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enregistrerCredentialPennylane, obtenirTokenPennylane, resumeErreurSupabaseSansSecret } from "./pennylaneRepository";

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

describe("stockage du credential Pennylane : chiffré, rattaché à la société de l'appelant", () => {
  // Faux client Supabase : mémorise ce qui est écrit, et le restitue à la lecture par société.
  function fauxAdmin() {
    const lignes = new Map<string, Record<string, unknown>>();
    const ecritures: { table: string; ligne: Record<string, unknown> }[] = [];
    const admin = {
      from(table: string) {
        return {
          upsert: async (ligne: Record<string, unknown>) => {
            ecritures.push({ table, ligne });
            lignes.set(ligne.company_id as string, ligne);
            return { error: null };
          },
          select: () => ({
            eq: (_colonne: string, companyId: string) => ({
              maybeSingle: async () => ({ data: lignes.get(companyId) ?? null, error: null }),
            }),
          }),
        };
      },
    } as unknown as SupabaseClient;
    return { admin, ecritures };
  }

  const TOKEN = "pnl_cle_reelle_factice_jamais_en_clair";
  const SOCIETE_STAGING = "societe-qannt-test";

  test("une clé validée est stockée chiffrée dans pennylane_connections, sous la société fournie", async () => {
    const cleOriginale = process.env.PENNYLANE_TOKEN_ENCRYPTION_KEY;
    process.env.PENNYLANE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    try {
      const { admin, ecritures } = fauxAdmin();
      await enregistrerCredentialPennylane(admin, SOCIETE_STAGING, TOKEN);

      assert.equal(ecritures.length, 1);
      assert.equal(ecritures[0].table, "pennylane_connections");
      assert.equal(ecritures[0].ligne.company_id, SOCIETE_STAGING);
      assert.equal(ecritures[0].ligne.status, "connected");
      assert.equal(JSON.stringify(ecritures[0].ligne).includes(TOKEN), false, "le token n'est jamais écrit en clair");

      assert.equal(await obtenirTokenPennylane(admin, SOCIETE_STAGING), TOKEN);
      assert.equal(await obtenirTokenPennylane(admin, "autre-societe"), null, "aucune autre société ne voit ce credential");
    } finally {
      process.env.PENNYLANE_TOKEN_ENCRYPTION_KEY = cleOriginale;
    }
  });

  test("un credential chiffré avec la clé d'un autre environnement est illisible ici", async () => {
    const cleOriginale = process.env.PENNYLANE_TOKEN_ENCRYPTION_KEY;
    try {
      const { admin } = fauxAdmin();
      process.env.PENNYLANE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
      await enregistrerCredentialPennylane(admin, SOCIETE_STAGING, TOKEN);
      process.env.PENNYLANE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString("base64");
      await assert.rejects(obtenirTokenPennylane(admin, SOCIETE_STAGING));
    } finally {
      process.env.PENNYLANE_TOKEN_ENCRYPTION_KEY = cleOriginale;
    }
  });
});
