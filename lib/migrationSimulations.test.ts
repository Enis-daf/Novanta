/**
 * Migration ponctuelle « factures clients Simulation -> factures prévisionnelles »
 * (supabase/donnees/20261119_simulations_vers_previsionnelles.sql). Le SQL est vérifié sous PGlite.
 * Ici : les gardes du SQL, et
 *  - l'invariant de trésorerie, avec le vrai moteur : une ancienne ligne non payée, non litigieuse,
 *    remplacée par une prévisionnelle au même montant et à la même date d'encaissement produit le
 *    même flux, une seule fois.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { listerFluxProjetes } from "./cash-engine";
import type { FactureClient } from "./types";
import type { FacturePrevisionnelle } from "./facturesPrevisionnelles";

const SQL = readFileSync(
  path.resolve(__dirname, "../supabase/donnees/20261119_simulations_vers_previsionnelles.sql"),
  "utf8"
);

test("migration : sélection ILIKE '%simulation%' sur la colonne facture, lignes sensibles exclues, facturation jamais inventée", () => {
  const migration = SQL.slice(SQL.indexOf("with supprimees as ("));
  assert.match(migration, /ci\.facture ilike '%simulation%'/);
  for (const garde of ["ci.pennylane_id is null", "ci.settled_on is null", "not ci.paid", "not ci.litigieuse", "f.customer_invoice_id = ci.id"]) {
    assert.ok(migration.includes(garde), `garde manquante : ${garde}`);
  }
  // Prévisionnelles créées à partir des lignes supprimées, dans la même instruction.
  assert.match(migration, /select company_id, client, montant, null, date_encaissement_anticipee\s+from supprimees/);
});

const simulation: FactureClient = {
  id: "ci-1",
  facture: "Simulation ACME",
  client: "ACME",
  montant: 20000,
  dateEcheance: "2026-12-15",
  dateEncaissementAnticipee: "2026-12-31",
  litigieuse: false,
  payee: false,
  paidAt: null,
  settledOn: null,
  pennylaneId: null,
};

// Ce que 02_migration.sql crée pour cette ligne.
const prevision: FacturePrevisionnelle = {
  id: "fp-1",
  client: "ACME",
  montant: 20000,
  dateFacturationPrevue: "",
  dateEncaissementPrevue: "2026-12-31",
  rapprochement: null,
  facturesIgnorees: [],
};

function flux(facturesClients: FactureClient[], facturesPrevisionnelles: FacturePrevisionnelle[]) {
  return listerFluxProjetes({
    facturesClients,
    facturesPrevisionnelles,
    facturesFournisseurs: [],
    chargesFixes: [],
    autresDepenses: [],
    financements: [],
    rentreesRegulieres: [],
    dateDepart: "2026-11-18",
  }).map((f) => ({ date: f.date, montant: f.montant }));
}

test("E. trésorerie : +20 000 € au 31/12 avant la migration, +20 000 € au 31/12 après — ni 0, ni 40 000", () => {
  const avant = flux([simulation], []);
  const apres = flux([], [prevision]);
  assert.deepEqual(avant, [{ date: "2026-12-31", montant: 20000 }]);
  assert.deepEqual(apres, avant);
  // L'état que l'atomicité interdit : prévisionnelle créée sans retrait de l'ancienne ligne.
  assert.equal(flux([simulation], [prevision]).reduce((s, f) => s + f.montant, 0), 40000);
});

test("E. sans date d'encaissement : hors projection avant comme après", () => {
  assert.deepEqual(flux([{ ...simulation, dateEncaissementAnticipee: "" }], []), []);
  assert.deepEqual(flux([], [{ ...prevision, dateEncaissementPrevue: "" }]), []);
});

test("blocage nécessaire : une Simulation payée ou litigieuse ne compte pas — la migrer en prévisionnelle active ajouterait du cash", () => {
  assert.deepEqual(flux([{ ...simulation, payee: true }], []), []);
  assert.deepEqual(flux([{ ...simulation, litigieuse: true }], []), []);
  assert.equal(flux([], [prevision]).length, 1);
});
