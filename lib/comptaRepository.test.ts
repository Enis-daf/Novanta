import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appliquerModele, enregistrerComptes, enregistrerLignesPeriode, enregistrerRegle, supprimerRegle } from "./comptaRepository";
import { MODELE_CORRESPONDANCE } from "./comptaCorrespondance";
import { LigneSource } from "./comptaSource";

type Appel = { table: string; operation: string; valeur?: unknown; options?: unknown; filtres: [string, string, unknown][] };

/** Client minimal : enregistre les appels pour vérifier ce qui part vers la base. */
function faux(lectures: unknown[] = []) {
  const appels: Appel[] = [];
  const client = {
    from(table: string) {
      const appel: Appel = { table, operation: "select", filtres: [] };
      const chaine = {
        select: () => chaine,
        upsert(valeur: unknown, options: unknown) {
          appel.operation = "upsert";
          appel.valeur = valeur;
          appel.options = options;
          return chaine;
        },
        update(valeur: unknown) {
          appel.operation = "update";
          appel.valeur = valeur;
          return chaine;
        },
        delete() {
          appel.operation = "delete";
          return chaine;
        },
        eq: (c: string, v: unknown) => (appel.filtres.push(["eq", c, v]), chaine),
        neq: (c: string, v: unknown) => (appel.filtres.push(["neq", c, v]), chaine),
        gte: (c: string, v: unknown) => (appel.filtres.push(["gte", c, v]), chaine),
        lte: (c: string, v: unknown) => (appel.filtres.push(["lte", c, v]), chaine),
        is: (c: string, v: unknown) => (appel.filtres.push(["is", c, v]), chaine),
        then(resoudre: (r: { data: unknown; error: null }) => void) {
          appels.push(appel);
          resoudre({ data: appel.operation === "select" ? lectures : null, error: null });
        },
      };
      return chaine;
    },
  };
  return { client: client as unknown as SupabaseClient, appels };
}

const ORG = "org-a";
const PERIODE = { debut: "2026-03-01", fin: "2026-03-31" };
const ligne = (id: string, compte = "706000"): LigneSource => ({ idSource: id, idEcriture: "e", idJournal: "j", compte, date: "2026-03-10", debit: 0, credit: 10, libelle: null, statutSource: null, creeeLe: null, modifieeLe: null });

describe("Stockage des écritures", () => {
  test("lecture complète : les lignes absentes sont écartées, jamais supprimées, sur SA société et SA période", async () => {
    const { client, appels } = faux();
    await enregistrerLignesPeriode(client, ORG, "pennylane", PERIODE, [ligne("1")], true, "run");
    assert.ok(!appels.some((a) => a.operation === "delete"));
    const ecart = appels.find((a) => a.operation === "update")!;
    assert.deepEqual(Object.keys(ecart.valeur as object), ["excluded_at"]);
    assert.deepEqual(ecart.filtres, [
      ["eq", "organization_id", ORG],
      ["eq", "source", "pennylane"],
      ["gte", "entry_date", PERIODE.debut],
      ["lte", "entry_date", PERIODE.fin],
      ["neq", "sync_run", "run"],
      ["is", "excluded_at", null],
    ]);
  });

  test("lecture incomplète : rien n'est écarté, ce serait une conclusion fausse", async () => {
    const { client, appels } = faux();
    await enregistrerLignesPeriode(client, ORG, "pennylane", PERIODE, [ligne("1")], false, "run");
    assert.ok(!appels.some((a) => a.operation === "update"));
  });

  test("une ligne de nouveau renvoyée revient dans le calcul ; un import rejoué ne double rien", async () => {
    const { client, appels } = faux();
    await enregistrerLignesPeriode(client, ORG, "pennylane", PERIODE, [ligne("1")], true, "run");
    const ecriture = appels.find((a) => a.operation === "upsert")!;
    assert.equal((ecriture.valeur as { excluded_at: unknown }[])[0].excluded_at, null);
    assert.deepEqual(ecriture.options, { onConflict: "organization_id,source,source_line_id" });
  });

  test("toute écriture porte l'organisation de la route, par lots", async () => {
    const { client, appels } = faux();
    await enregistrerLignesPeriode(client, ORG, "pennylane", PERIODE, Array.from({ length: 1201 }, (_, i) => ligne(String(i))), false, "run");
    const lots = appels.filter((a) => a.operation === "upsert");
    assert.deepEqual(lots.map((a) => (a.valeur as unknown[]).length), [500, 500, 201]);
    assert.ok(lots.flatMap((a) => a.valeur as { organization_id: string }[]).every((l) => l.organization_id === ORG));
  });

  test("numéro de compte non numérique : ignoré, jamais deviné", async () => {
    const { client, appels } = faux();
    await enregistrerLignesPeriode(client, ORG, "pennylane", PERIODE, [ligne("1", "ABC")], false, "run");
    assert.ok(!appels.some((a) => a.operation === "upsert"));
  });
});

describe("Plan de comptes", () => {
  test("seuls les comptes inconnus sont comptés nouveaux ; la date de première vue n'est jamais réécrite", async () => {
    const { client, appels } = faux([{ account_number: "706000", label: "x", first_seen_at: "2026-01-01" }]);
    const nouveaux = await enregistrerComptes(client, ORG, "pennylane", [
      { idSource: "1", numero: "706000", libelle: "Ventes", type: null, actif: true },
      { idSource: "2", numero: "658000", libelle: "Autres", type: null, actif: true },
    ]);
    assert.equal(nouveaux, 1);
    const ecriture = appels.find((a) => a.operation === "upsert")!;
    assert.ok((ecriture.valeur as object[]).every((l) => !("first_seen_at" in l)));
  });
});

describe("Règles", () => {
  test("modèle : n'écrase jamais une racine déjà paramétrée", async () => {
    const { client, appels } = faux();
    await appliquerModele(client, ORG, MODELE_CORRESPONDANCE, "u");
    assert.deepEqual(appels[0].options, { onConflict: "organization_id,account_prefix", ignoreDuplicates: true });
  });

  test("suppression : auteur posé d'abord pour le journal, bornée à la société", async () => {
    const { client, appels } = faux();
    await supprimerRegle(client, ORG, "70", "u");
    assert.deepEqual(appels.map((a) => a.operation), ["update", "delete"]);
    assert.deepEqual(appels[0].valeur, { updated_by: "u" });
    for (const appel of appels) assert.deepEqual(appel.filtres, [["eq", "organization_id", ORG], ["eq", "account_prefix", "70"]]);
  });

  test("enregistrement : auteur tracé, libellé nettoyé", async () => {
    const { client, appels } = faux();
    await enregistrerRegle(client, ORG, { prefixe: "70", destination: "revenue", categorie: "  Ventes " }, "u");
    const valeur = appels[0].valeur as Record<string, unknown>;
    assert.equal(valeur.category_label, "Ventes");
    assert.equal(valeur.updated_by, "u");
    assert.equal(valeur.organization_id, ORG);
  });
});
