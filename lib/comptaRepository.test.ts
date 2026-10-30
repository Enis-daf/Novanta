import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appliquerModele, chargerComptes, chargerSoldes, enregistrerBalanceDuMois, enregistrerComptes, enregistrerRegle, supprimerRegle } from "./comptaRepository";
import { MODELE_CORRESPONDANCE } from "./comptaCorrespondance";
import { SoldeSource } from "./comptaSource";

type Appel = { table: string; operation: string; valeur?: unknown; options?: unknown; filtres: [string, string, unknown][]; intervalle?: [number, number] };

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
        order: () => chaine,
        range(depuis: number, jusqua: number) {
          appel.intervalle = [depuis, jusqua];
          return chaine;
        },
        then(resoudre: (r: { data: unknown; error: null }) => void) {
          appels.push(appel);
          const donnees = appel.intervalle ? lectures.slice(appel.intervalle[0], appel.intervalle[1] + 1) : lectures;
          resoudre({ data: appel.operation === "select" ? donnees : null, error: null });
        },
      };
      return chaine;
    },
  };
  return { client: client as unknown as SupabaseClient, appels };
}

const ORG = "org-a";
const PERIODE = { debut: "2026-03-01", fin: "2026-03-31" };
const MOIS = "2026-03";
const solde = (compte: string, debit = 0, credit = 10): SoldeSource => ({ compte, libelle: null, debit, credit });

describe("Balance d'un mois", () => {
  test("lecture complète : un compte disparu est écarté, jamais supprimé, sur SA société et SON mois", async () => {
    const { client, appels } = faux();
    await enregistrerBalanceDuMois(client, ORG, "pennylane", MOIS, [solde("706000")], true, "run");
    assert.ok(!appels.some((a) => a.operation === "delete"));
    const ecart = appels.find((a) => a.operation === "update")!;
    assert.deepEqual(Object.keys(ecart.valeur as object), ["excluded_at"]);
    assert.deepEqual(ecart.filtres, [
      ["eq", "organization_id", ORG],
      ["eq", "source", "pennylane"],
      ["eq", "month", "2026-03-01"],
      ["neq", "sync_run", "run"],
      ["is", "excluded_at", null],
    ]);
  });

  test("lecture incomplète : rien n'est écarté, ce serait une conclusion fausse", async () => {
    const { client, appels } = faux();
    await enregistrerBalanceDuMois(client, ORG, "pennylane", MOIS, [solde("706000")], false, "run");
    assert.ok(!appels.some((a) => a.operation === "update"));
  });

  test("un compte de nouveau renvoyé revient dans le calcul ; une lecture rejouée ne double rien", async () => {
    const { client, appels } = faux();
    await enregistrerBalanceDuMois(client, ORG, "pennylane", MOIS, [solde("706000")], true, "run");
    const ecriture = appels.find((a) => a.operation === "upsert")!;
    assert.equal((ecriture.valeur as { excluded_at: unknown }[])[0].excluded_at, null);
    assert.deepEqual(ecriture.options, { onConflict: "organization_id,source,month,account_number" });
  });

  test("toute écriture porte l'organisation de la route, par lots", async () => {
    const { client, appels } = faux();
    await enregistrerBalanceDuMois(client, ORG, "pennylane", MOIS, Array.from({ length: 1201 }, (_, i) => solde(String(100000 + i))), false, "run");
    const lots = appels.filter((a) => a.operation === "upsert");
    assert.deepEqual(lots.map((a) => (a.valeur as unknown[]).length), [500, 500, 201]);
    assert.ok(lots.flatMap((a) => a.valeur as { organization_id: string }[]).every((l) => l.organization_id === ORG));
  });

  test("un numéro renvoyé deux fois est cumulé au centime : l'enregistrement ne peut pas échouer", async () => {
    const { client, appels } = faux();
    await enregistrerBalanceDuMois(client, ORG, "pennylane", MOIS, [solde("606", 0.1), solde("606", 0.2)], false, "run");
    const lignes = appels.find((a) => a.operation === "upsert")!.valeur as { debit: number }[];
    assert.equal(lignes.length, 1);
    assert.equal(lignes[0].debit, 0.3);
  });

  test("numéro alphanumérique conservé ; numéro illisible compté, jamais perdu en silence", async () => {
    const { client, appels } = faux();
    const illisibles = await enregistrerBalanceDuMois(client, ORG, "pennylane", MOIS, [solde("411ABC"), solde("???")], false, "run");
    assert.equal(illisibles, 1);
    assert.deepEqual((appels.find((a) => a.operation === "upsert")!.valeur as { account_number: string }[]).map((l) => l.account_number), ["411ABC"]);
  });
});

describe("Lectures au-delà de 1000 lignes", () => {
  const pages = (taille: number) => {
    const reste = Array.from({ length: taille }, (_, i) => ({ account_number: String(600000 + i), label: "x", first_seen_at: "2026-01-01", month: "2026-03-01", debit: "1", credit: "0" }));
    const { client, appels } = faux(reste);
    return { client, appels };
  };

  test("un plan de 2500 comptes est lu en entier, pas tronqué à 1000", async () => {
    const { client, appels } = pages(2500);
    assert.equal((await chargerComptes(client, ORG)).length, 2500);
    assert.deepEqual(appels.map((a) => a.intervalle), [[0, 999], [1000, 1999], [2000, 2999]]);
  });

  test("exactement 1000 lignes : une page de plus, vide, puis arrêt", async () => {
    const { client, appels } = pages(1000);
    assert.equal((await chargerSoldes(client, ORG, PERIODE)).length, 1000);
    assert.equal(appels.length, 2);
  });

  test("soldes : mois entiers de la période, société bornée, comptes écartés exclus", async () => {
    const { client, appels } = pages(1);
    const soldes = await chargerSoldes(client, ORG, { debut: "2026-03-10", fin: "2026-04-05" });
    assert.deepEqual(soldes, [{ compte: "600000", mois: "2026-03", debit: 1, credit: 0, nombreLignes: 0 }]);
    assert.deepEqual(appels[0].filtres, [
      ["eq", "organization_id", ORG],
      ["gte", "month", "2026-03-01"],
      ["lte", "month", "2026-04-01"],
      ["is", "excluded_at", null],
    ]);
  });
});

describe("Plan de comptes", () => {
  test("un numéro en double n'est envoyé qu'une fois ; un numéro alphanumérique est gardé", async () => {
    const { client, appels } = faux([]);
    await enregistrerComptes(client, ORG, "pennylane", [
      { idSource: "1", numero: "606000", libelle: "A", type: null, actif: true },
      { idSource: "2", numero: "606000", libelle: "B", type: null, actif: true },
      { idSource: "3", numero: "411ABC", libelle: "C", type: null, actif: true },
    ]);
    assert.deepEqual((appels.find((a) => a.operation === "upsert")!.valeur as { account_number: string }[]).map((l) => l.account_number), ["606000", "411ABC"]);
  });

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
