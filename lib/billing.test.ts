import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { accessEnabledForStatus, estDoublonProprietaire, getOrCreateCompanyForBilling } from "./billing";

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

// Faux client limité à ce qu'utilise getOrCreateCompanyForBilling : une table companies en mémoire,
// avec la contrainte d'unicité sur owner_id. `avantInsertion` simule l'autre appel concurrent qui
// insère juste entre la lecture (vide) et l'insertion de celui-ci.
function fauxSupabase(lignes: Record<string, unknown>[], avantInsertion?: () => void) {
  const violation = { code: "23505", message: 'duplicate key value violates unique constraint "companies_owner_id_key"' };
  return {
    from: () => ({
      select: () => ({
        eq: (_col: string, ownerId: string) => ({
          maybeSingle: async () => ({ data: lignes.find((l) => l.owner_id === ownerId) ?? null, error: null }),
        }),
      }),
      insert: (ligne: Record<string, unknown>) => ({
        select: () => ({
          single: async () => {
            avantInsertion?.();
            if (lignes.some((l) => l.owner_id === ligne.owner_id)) return { data: null, error: violation };
            const creee = { id: `soc-${lignes.length + 1}`, ...ligne };
            lignes.push(creee);
            return { data: creee, error: null };
          },
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

const utilisateur = { id: "user-1", email: "test@example.com", user_metadata: { company_name: "Test" } } as unknown as User;

describe("getOrCreateCompanyForBilling — première connexion confirmée", () => {
  test("crée la société sans accès quand elle n'existe pas", async () => {
    const lignes: Record<string, unknown>[] = [];
    const societe = await getOrCreateCompanyForBilling(fauxSupabase(lignes), utilisateur);
    assert.equal(lignes.length, 1);
    assert.equal(societe.accessEnabled, false);
  });

  test("insertion concurrente perdue : renvoie la société créée par l'autre appel, sans erreur ni doublon", async () => {
    const lignes: Record<string, unknown>[] = [];
    const autreAppel = () => {
      if (lignes.length === 0) lignes.push({ id: "soc-gagnante", owner_id: "user-1", name: "Test", access_enabled: false });
    };
    const societe = await getOrCreateCompanyForBilling(fauxSupabase(lignes, autreAppel), utilisateur);
    assert.equal(societe.id, "soc-gagnante");
    assert.equal(societe.accessEnabled, false);
    assert.equal(lignes.length, 1);
  });

  test("deux appels simultanés aboutissent à la même société", async () => {
    const lignes: Record<string, unknown>[] = [];
    const client = fauxSupabase(lignes);
    const [a, b] = await Promise.all([
      getOrCreateCompanyForBilling(client, utilisateur),
      getOrCreateCompanyForBilling(client, utilisateur),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(lignes.length, 1);
  });

  test("seule la contrainte owner_id est absorbée", () => {
    assert.equal(estDoublonProprietaire({ code: "23505", message: 'violates unique constraint "companies_owner_id_key"' }), true);
    assert.equal(estDoublonProprietaire({ code: "23505", message: 'violates unique constraint "companies_stripe_customer_id_key"' }), false);
    assert.equal(estDoublonProprietaire({ code: "42501", message: "permission denied for table companies" }), false);
    assert.equal(estDoublonProprietaire(null), false);
  });
});
