import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appliquerModele, chargerChoixStock, chargerComptes, chargerSoldes, depotSupabase, enregistrerChoixStock, enregistrerComptes, enregistrerRegle, preparerBalance, supprimerRegle } from "./comptaRepository";
import { MODELE_CORRESPONDANCE } from "./comptaCorrespondance";
import { SoldeSource } from "./comptaSource";

type Appel = { table: string; operation: string; valeur?: unknown; options?: unknown; filtres: [string, string, unknown][]; intervalle?: [number, number] };

/** Client minimal : enregistre les appels pour vérifier ce qui part vers la base. */
function faux(lectures: unknown[] = [], retourRpc: unknown = "run") {
  const appels: Appel[] = [];
  const appelsRpc: { nom: string; params: Record<string, unknown> }[] = [];
  const client = {
    async rpc(nom: string, params: Record<string, unknown>) {
      appelsRpc.push({ nom, params });
      return { data: retourRpc, error: null };
    },
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
        insert(valeur: unknown) {
          appel.operation = "insert";
          appel.valeur = valeur;
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
  return { client: client as unknown as SupabaseClient, appels, appelsRpc };
}

const ORG = "org-a";
const PERIODE = { debut: "2026-03-01", fin: "2026-03-31" };
const solde = (compte: string, debit = 0, credit = 10): SoldeSource => ({ compte, libelle: null, debit, credit });

describe("Balance d'un mois", () => {
  test("cumul par numéro, au centime : un numéro renvoyé deux fois ne fait qu'une ligne", () => {
    const { lignes } = preparerBalance([solde("606", 0.1, 0), solde("606", 0.2, 0)]);
    assert.equal(lignes.length, 1);
    assert.equal(lignes[0].debit, 0.3);
  });

  test("numéro alphanumérique conservé ; numéro illisible compté, jamais perdu en silence", () => {
    const { lignes, illisibles } = preparerBalance([solde("411ABC"), solde("???")]);
    assert.equal(illisibles, 1);
    assert.deepEqual(lignes.map((l) => l.account_number), ["411ABC"]);
  });

  test("signes conservés : débit et crédit restent chacun à leur place", () => {
    const { lignes } = preparerBalance([solde("706000", 5, 100)]);
    assert.deepEqual([lignes[0].debit, lignes[0].credit], [5, 100]);
  });

  test("le remplacement passe par une seule fonction transactionnelle, bornée à la société", async () => {
    const { client, appelsRpc } = faux();
    const illisibles = await depotSupabase(client, ORG, "pennylane").remplacerMois("2026-03", [solde("706000")], "run");
    assert.equal(illisibles, 0);
    assert.equal(appelsRpc.length, 1);
    assert.equal(appelsRpc[0].nom, "accounting_replace_month_balance");
    assert.equal(appelsRpc[0].params.p_organization_id, ORG);
    assert.equal(appelsRpc[0].params.p_month, "2026-03-01");
  });
});

describe("Exécutions", () => {
  test("une synchronisation refusée par le verrou renvoie null", async () => {
    const { client } = faux([], null);
    assert.equal(await depotSupabase(client, ORG, "pennylane").commencer("manuel"), null);
  });

  test("fin d'exécution : bornée à la société, sans donnée comptable", async () => {
    const { client, appels } = faux();
    await depotSupabase(client, ORG, "pennylane").terminer("run", { statut: "partial", moisDemandes: 3, moisActualises: 2, moisEnEchec: [{ mois: "2026-02", raison: "lecture" }], nouveauxComptes: 0, comptesIllisibles: 0, limites: [], codeErreur: "network" });
    assert.deepEqual(appels[0].filtres, [["eq", "organization_id", ORG], ["eq", "id", "run"]]);
    assert.deepEqual(Object.keys(appels[0].valeur as object).sort(), ["error_code", "failed_months", "finished_at", "months_requested", "months_updated", "notes", "status"]);
  });
});

describe("Arbitrages de stock", () => {
  test("le dernier choix de chaque exercice fait foi, les précédents restent la trace", async () => {
    const { client } = faux([
      { scope_start: "2026-01-01", source: "novanta", pennylane_amount: "1", novanta_amount: "2", chosen_at: "2027-02-01" },
      { scope_start: "2026-01-01", source: "pennylane", pennylane_amount: "1", novanta_amount: "2", chosen_at: "2027-01-01" },
      { scope_start: "2025-01-01", source: null, pennylane_amount: null, novanta_amount: null, chosen_at: "2026-01-01" },
    ]);
    const choix = await chargerChoixStock(client, ORG);
    assert.equal(choix.get("2026-01-01")?.source, "novanta");
    assert.equal(choix.get("2025-01-01")?.source, null);
  });

  test("arbitrages séparés par élément : stocks et amortissements", async () => {
    const { client, appels } = faux([]);
    await chargerChoixStock(client, ORG, "depreciation");
    assert.deepEqual(appels[0].filtres, [["eq", "organization_id", ORG], ["eq", "element", "depreciation"]]);
  });

  test("un arbitrage s'ajoute : il ne remplace rien, et garde auteur et montants", async () => {
    const { client, appels } = faux();
    await enregistrerChoixStock(client, ORG, { perimetre: { debut: "2026-01-01", fin: "2026-12-31" }, source: "novanta", montantPennylane: 900, montantNovanta: 1100 }, "u");
    assert.equal(appels[0].operation, "insert");
    const v = appels[0].valeur as Record<string, unknown>;
    assert.deepEqual([v.organization_id, v.source, v.pennylane_amount, v.novanta_amount, v.chosen_by], [ORG, "novanta", 900, 1100, "u"]);
  });
});

describe("Lectures au-delà de 1000 lignes", () => {
  const pages = (taille: number) => {
    const reste = Array.from({ length: taille }, (_, i) => ({ account_number: String(600000 + i), label: "x", first_seen_at: "2026-01-01", month: "2026-03-01", debit: "1", credit: "0", source: "fec" }));
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
    assert.deepEqual(soldes, [{ compte: "600000", mois: "2026-03", debit: 1, credit: 0, nombreLignes: 0, source: "fec" }]);
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
