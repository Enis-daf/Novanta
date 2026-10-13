import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  analyserUrlPostgres,
  ConfigEnvironnement,
  refDepuisCleSupabase,
  refDepuisUrlPostgres,
  refDepuisUrlSupabase,
  verifierEnvironnement,
  verifierRefCible,
} from "./environnementGuard";

const REF_STAGING = "stagingrefaaaaaaaaaa";
const REF_PROD = "prodrefbbbbbbbbbbbbb";
const REF_AUTRE = "autrerefcccccccccccc";

function jwtFactice(ref: string): string {
  const encoder = (objet: unknown) => Buffer.from(JSON.stringify(objet)).toString("base64url");
  return `${encoder({ alg: "HS256" })}.${encoder({ ref, role: "anon" })}.signature`;
}

function config(overrides: Partial<ConfigEnvironnement> = {}): ConfigEnvironnement {
  return {
    mode: "staging",
    supabaseUrl: `https://${REF_STAGING}.supabase.co`,
    refStagingAttendue: REF_STAGING,
    refsInterdites: REF_PROD,
    cles: [jwtFactice(REF_STAGING)],
    ...overrides,
  };
}

describe("extraction des refs", () => {
  test("URL d'API Supabase", () => {
    assert.equal(refDepuisUrlSupabase(`https://${REF_STAGING}.supabase.co`), REF_STAGING);
    assert.equal(refDepuisUrlSupabase(`https://${REF_STAGING}.supabase.co/rest/v1/`), REF_STAGING);
    assert.equal(refDepuisUrlSupabase("http://localhost:54321"), null);
    assert.equal(refDepuisUrlSupabase("pas une url"), null);
    assert.equal(refDepuisUrlSupabase(undefined), null);
  });

  test("clé JWT : ref du payload ; clé non JWT : null", () => {
    assert.equal(refDepuisCleSupabase(jwtFactice(REF_PROD)), REF_PROD);
    assert.equal(refDepuisCleSupabase("sb_publishable_abcdef"), null);
    assert.equal(refDepuisCleSupabase("a.b.c"), null);
    assert.equal(refDepuisCleSupabase(undefined), null);
  });

  test("chaîne Postgres : connexion directe et pooler", () => {
    assert.equal(refDepuisUrlPostgres(`postgresql://postgres:secret@db.${REF_STAGING}.supabase.co:5432/postgres`), REF_STAGING);
    assert.equal(
      refDepuisUrlPostgres(`postgresql://postgres.${REF_STAGING}:secret@aws-0-eu-west-3.pooler.supabase.com:6543/postgres`),
      REF_STAGING
    );
    assert.equal(refDepuisUrlPostgres("postgresql://postgres:secret@localhost:5432/postgres"), null);
    assert.equal(refDepuisUrlPostgres("pas une url"), null);
  });

  test("chaîne Postgres : mot de passe à caractères réservés non encodés", () => {
    const url = `postgresql://postgres:[a@b/c?d#e]@db.${REF_STAGING}.supabase.co:5432/postgres`;
    assert.equal(refDepuisUrlPostgres(url), REF_STAGING);
    assert.deepEqual(analyserUrlPostgres(url), {
      utilisateur: "postgres",
      motDePasse: "[a@b/c?d#e]",
      hote: `db.${REF_STAGING}.supabase.co`,
      port: 5432,
      base: "postgres",
    });
    assert.equal(analyserUrlPostgres(`postgresql://postgres:p%40ss@db.${REF_STAGING}.supabase.co/postgres`)?.motDePasse, "p@ss");
    assert.equal(analyserUrlPostgres(`https://${REF_STAGING}.supabase.co`), null);
  });

  test("chaîne Postgres : un hôte interdit placé dans le mot de passe ne trompe pas l'analyse", () => {
    const url = `postgresql://postgres:x@db.${REF_PROD}.supabase.co:5432/y@db.${REF_STAGING}.supabase.co:5432/postgres`;
    assert.equal(analyserUrlPostgres(url)?.hote, `db.${REF_STAGING}.supabase.co`);
  });
});

describe("verifierEnvironnement", () => {
  test("hors mode staging : inactif, quelle que soit la configuration", () => {
    assert.deepEqual(verifierEnvironnement(config({ mode: undefined, supabaseUrl: `https://${REF_PROD}.supabase.co` })), {
      ok: true,
      staging: false,
    });
    assert.deepEqual(verifierEnvironnement(config({ mode: "production" })), { ok: true, staging: false });
  });

  test("staging correctement configuré : accepté", () => {
    assert.deepEqual(verifierEnvironnement(config()), { ok: true, staging: true });
  });

  test("clé au nouveau format (non JWT) : seule l'URL fait foi", () => {
    assert.deepEqual(verifierEnvironnement(config({ cles: ["sb_publishable_abcdef", undefined] })), { ok: true, staging: true });
  });

  test("URL de Production : refusé", () => {
    const verdict = verifierEnvironnement(config({ supabaseUrl: `https://${REF_PROD}.supabase.co` }));
    assert.equal(verdict.ok, false);
  });

  test("URL d'un autre projet que le staging attendu : refusé, même s'il n'est pas interdit", () => {
    const verdict = verifierEnvironnement(config({ supabaseUrl: `https://${REF_AUTRE}.supabase.co` }));
    assert.equal(verdict.ok, false);
  });

  test("ref staging non déclarée : refusé", () => {
    assert.equal(verifierEnvironnement(config({ refStagingAttendue: undefined })).ok, false);
    assert.equal(verifierEnvironnement(config({ refStagingAttendue: "" })).ok, false);
  });

  test("ref staging déclarée égale à une ref interdite : refusé", () => {
    const verdict = verifierEnvironnement(
      config({ supabaseUrl: `https://${REF_PROD}.supabase.co`, refStagingAttendue: REF_PROD, cles: [] })
    );
    assert.equal(verdict.ok, false);
  });

  test("URL staging mais clé d'un autre projet : refusé", () => {
    const verdict = verifierEnvironnement(config({ cles: [jwtFactice(REF_STAGING), jwtFactice(REF_PROD)] }));
    assert.equal(verdict.ok, false);
  });

  test("URL absente : refusé", () => {
    assert.equal(verifierEnvironnement(config({ supabaseUrl: undefined })).ok, false);
  });

  test("aucun message de refus ne contient une clé", () => {
    const cle = jwtFactice(REF_PROD);
    const verdict = verifierEnvironnement(config({ cles: [cle] }));
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.raison.includes(cle), false);
  });
});

describe("verifierRefCible (scripts)", () => {
  test("plusieurs refs interdites, espaces et casse tolérés", () => {
    assert.equal(verifierRefCible(REF_PROD, REF_STAGING, ` ${REF_AUTRE} , ${REF_PROD.toUpperCase()} `).ok, false);
    assert.equal(verifierRefCible(REF_STAGING, REF_STAGING, ` ${REF_AUTRE} , ${REF_PROD} `).ok, true);
  });

  test("ref cible indéterminée : refusé", () => {
    assert.equal(verifierRefCible(null, REF_STAGING, REF_PROD).ok, false);
  });
});
