import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { situationBfr, TypeFactureBfr } from "./pastBfr";
import { FacturePennylaneBrute, TransactionRapprocheeBrute } from "./pastBfrPennylane";
import { PennylaneApiError } from "./pennylaneClient";
import {
  cleFacture,
  ClientFacturesBfr,
  daterReglements,
  DepotFacturesBfr,
  LigneStockee,
  limiteurDebit,
  synchroniserFactures,
  validiteReglementsJours,
  VALIDITE_MIN_REGLEMENTS_JOURS,
} from "./pastBfrSync";

// Factures fictives : 1 000 € HT / 1 200 € TTC.
const brute = (id: number, champs: Partial<FacturePennylaneBrute> = {}): FacturePennylaneBrute => ({
  id,
  invoice_number: `N${id}`,
  label: `Facture CLIENT FICTIF - N${id} (label généré)`,
  date: "2026-09-10",
  amount: "1200.0",
  currency: "EUR",
  currency_amount: "1200.0",
  currency_amount_before_tax: "1000.0",
  remaining_amount_with_tax: "1200.0",
  remaining_amount_without_tax: "1000.0",
  updated_at: "2026-09-10T10:00:00Z",
  ...champs,
});
const payee = (id: number, champs: Partial<FacturePennylaneBrute> = {}) =>
  brute(id, { remaining_amount_with_tax: "0.0", remaining_amount_without_tax: "0.0", updated_at: "2026-10-02T09:00:00Z", ...champs });

function banc(listes: Record<TypeFactureBfr, FacturePennylaneBrute[]>, transactions: Record<number, TransactionRapprocheeBrute[]> = {}) {
  const base = new Map<string, LigneStockee>();
  const appels = { listes: 0, details: 0, ecritures: 0, lignesEcrites: 0 };
  let complete = true;
  let echec: ((id: string) => Error | null) | null = null;
  const client: ClientFacturesBfr = {
    async listerFactures(type) {
      appels.listes++;
      return { items: listes[type], complete };
    },
    async listerTransactionsRapprochees(_type, id) {
      appels.details++;
      const e = echec?.(id);
      if (e) throw e;
      return transactions[Number(id)] ?? [];
    },
  };
  const depot: DepotFacturesBfr = {
    async charger() {
      return new Map([...base].map(([k, v]) => [k, structuredClone(v)]));
    },
    async ecrire(lignes) {
      appels.ecritures++;
      appels.lignesEcrites += lignes.length;
      for (const l of lignes) base.set(cleFacture(l.facture.type, l.facture.pennylaneId), structuredClone(l));
    },
    async supprimer(cles) {
      for (const c of cles) base.delete(cleFacture(c.type, c.pennylaneId));
    },
    async marquerSynchronisees() {},
    async aDater(limite) {
      return [...base.values()].filter((l) => l.reglements?.etat === "a_dater").slice(0, limite).map((l) => structuredClone(l));
    },
    async compterADater() {
      return [...base.values()].filter((l) => l.reglements?.etat === "a_dater").length;
    },
  };
  const options = (maintenant: string) => ({ maxFactures: 300, concurrence: 2, budgetMs: 10_000, maintenant, reserver: async () => {} });
  const synchroniser = async (maintenant: string) => {
    const r = await synchroniserFactures(client, depot, maintenant);
    let restantes = r.aDater;
    while (restantes > 0) restantes = (await daterReglements(client, depot, options(maintenant))).restantes;
    return r;
  };
  return {
    base,
    appels,
    client,
    depot,
    options,
    synchroniser,
    tronquer: () => (complete = false),
    echouerSur: (f: typeof echec) => (echec = f),
    factures: () => [...base.values()].map((l) => l.facture),
  };
}

const JOUR1 = "2026-10-21T10:00:00.000Z";

describe("synchronisation BFR — initialisation puis actualisation", () => {
  test("initialisation : une liste par type, un appel de règlements par facture réglée seulement", async () => {
    const b = banc({ client: [brute(1), payee(2), payee(3)], fournisseur: [brute(4)] }, { 2: [{ id: 1, date: "2026-10-02" }], 3: [{ id: 2, date: "2026-09-20" }] });
    const r = await b.synchroniser(JOUR1);
    assert.equal(b.appels.listes, 2);
    assert.equal(b.appels.details, 2);
    assert.deepEqual([r.factures, r.aDater], [4, 2]);
    assert.deepEqual(b.base.get("client|2")!.reglements, { etat: "dates", recuperesLe: JOUR1, transactions: [{ date: "2026-10-02", montant: 0 }] });
  });

  test("actualisation sans changement : aucune réécriture, aucun appel de règlements", async () => {
    const b = banc({ client: [brute(1), payee(2)], fournisseur: [] }, { 2: [{ id: 1, date: "2026-10-02" }] });
    await b.synchroniser(JOUR1);
    const avant = { ...b.appels };
    const r = await b.synchroniser("2026-10-22T10:00:00.000Z");
    assert.equal(b.appels.details, avant.details);
    assert.equal(b.appels.lignesEcrites, avant.lignesEcrites);
    assert.deepEqual([r.ecrites, r.aDater], [0, 0]);
  });

  test("horodatage relu par la base dans un autre format : même instant, ni réécriture ni redatation", async () => {
    const b = banc({ client: [payee(2, { updated_at: "2026-10-02T11:00:00.000+02:00" })], fournisseur: [] }, { 2: [{ id: 1, date: "2026-10-02" }] });
    await b.synchroniser(JOUR1);
    // La base renvoie les timestamptz en UTC (« +00:00 ») : cas réel du Preview, le 21/10.
    for (const ligne of b.base.values()) {
      ligne.pennylaneUpdatedAt = "2026-10-02T09:00:00+00:00";
      if (ligne.reglements?.etat === "dates") ligne.reglements.recuperesLe = "2026-10-21T10:00:00+00:00";
    }
    const avant = { ...b.appels };
    const r = await b.synchroniser("2026-10-22T10:00:00.000Z");
    assert.deepEqual([r.ecrites, r.aDater], [0, 0]);
    assert.equal(b.appels.details, avant.details);
  });

  test("facture modifiée chez Pennylane (reste dû ou updated_at) : redatée", async () => {
    const liste = { client: [brute(1)], fournisseur: [] as FacturePennylaneBrute[] };
    const b = banc(liste, { 1: [{ id: 1, date: "2026-10-05" }] });
    await b.synchroniser(JOUR1);
    assert.equal(b.appels.details, 0);
    // Paiement partiel survenu depuis : le reste dû change, la facture est datée.
    liste.client = [brute(1, { remaining_amount_with_tax: "600.0", remaining_amount_without_tax: "500.0", updated_at: "2026-10-05T09:00:00Z" })];
    await b.synchroniser("2026-10-22T10:00:00.000Z");
    assert.equal(b.appels.details, 1);
    assert.equal(b.base.get("client|1")!.facture.resteHt, 500);
  });

  test("dates de règlement jamais gardées indéfiniment : redatées après leur validité (30 à 59 jours)", async () => {
    const b = banc({ client: [payee(2)], fournisseur: [] }, { 2: [{ id: 1, date: "2026-10-02" }] });
    await b.synchroniser(JOUR1);
    const validite = validiteReglementsJours(cleFacture("client", "2"));
    assert.ok(validite >= VALIDITE_MIN_REGLEMENTS_JOURS && validite < 60);
    const apres = (jours: number) => new Date(Date.parse(JOUR1) + jours * 86_400_000).toISOString();
    await b.synchroniser(apres(validite - 1));
    assert.equal(b.appels.details, 1);
    await b.synchroniser(apres(validite + 1));
    assert.equal(b.appels.details, 2);
  });

  test("validité étalée : des factures datées le même jour n'expirent pas toutes le même jour", () => {
    const validites = new Set(Array.from({ length: 200 }, (_, i) => validiteReglementsJours(cleFacture("fournisseur", String(1000 + i)))));
    assert.ok(validites.size > 20);
  });

  test("facture ancienne saisie tardivement : récupérée et datée à la synchronisation suivante", async () => {
    const liste = { client: [brute(1)], fournisseur: [] as FacturePennylaneBrute[] };
    const b = banc(liste, { 9: [{ id: 3, date: "2025-04-15" }] });
    await b.synchroniser(JOUR1);
    liste.client = [brute(1), payee(9, { date: "2025-03-01" })];
    await b.synchroniser("2026-10-22T10:00:00.000Z");
    const mars = situationBfr({ factures: b.factures(), date: "2025-03-31", stock: 0, synchroniseLe: "2026-10-22" });
    assert.equal(mars.totalCreances, 1_000);
  });

  test("facture disparue de Pennylane : retirée — sauf si la liste est peut-être tronquée", async () => {
    const liste = { client: [brute(1), brute(2)], fournisseur: [] as FacturePennylaneBrute[] };
    const b = banc(liste);
    await b.synchroniser(JOUR1);
    liste.client = [brute(1)];
    b.tronquer();
    await b.synchroniser("2026-10-22T10:00:00.000Z");
    assert.equal(b.base.has("client|2"), true);
  });

  test("facture disparue, liste complète : retirée", async () => {
    const liste = { client: [brute(1), brute(2)], fournisseur: [] as FacturePennylaneBrute[] };
    const b = banc(liste);
    await b.synchroniser(JOUR1);
    liste.client = [brute(1)];
    const r = await b.synchroniser("2026-10-22T10:00:00.000Z");
    assert.equal(r.supprimees, 1);
    assert.equal(b.base.has("client|2"), false);
  });
});

describe("synchronisation BFR — erreurs et reprise", () => {
  test("erreur API non passagère en cours de datation : échec signalé, ce qui est daté est gardé, la reprise termine le reste", async () => {
    const b = banc({ client: [payee(1), payee(2), payee(3)], fournisseur: [] }, { 1: [{ id: 1, date: "2026-10-02" }], 2: [{ id: 2, date: "2026-10-03" }], 3: [{ id: 3, date: "2026-10-04" }] });
    await synchroniserFactures(b.client, b.depot, JOUR1);
    b.echouerSur((id) => (id === "3" ? new PennylaneApiError("unknown", "réponse inattendue", 400) : null));
    await assert.rejects(daterReglements(b.client, b.depot, { ...b.options(JOUR1), concurrence: 1 }));
    assert.equal(await b.depot.compterADater(), 1);
    b.echouerSur(null);
    const reprise = await daterReglements(b.client, b.depot, b.options(JOUR1));
    assert.deepEqual([reprise.datees, reprise.restantes], [1, 0]);
  });

  test("Pennylane momentanément indisponible (502) : arrêt propre, progression gardée, reprise", async () => {
    const b = banc({ client: [payee(1), payee(2), payee(3)], fournisseur: [] }, { 1: [{ id: 1, date: "2026-10-02" }] });
    await synchroniserFactures(b.client, b.depot, JOUR1);
    b.echouerSur((id) => (id === "2" ? new PennylaneApiError("unavailable", "502", 502) : null));
    const r = await daterReglements(b.client, b.depot, { ...b.options(JOUR1), concurrence: 1 });
    assert.deepEqual([r.interrompu, r.datees, r.restantes], [true, 1, 2]);
    b.echouerSur(null);
    assert.equal((await daterReglements(b.client, b.depot, b.options(JOUR1))).restantes, 0);
  });

  test("plafond d'appels encore atteint : arrêt propre, sans erreur, l'appel suivant reprend", async () => {
    const b = banc({ client: [payee(1), payee(2)], fournisseur: [] });
    await synchroniserFactures(b.client, b.depot, JOUR1);
    b.echouerSur((id) => (id === "2" ? new PennylaneApiError("rate_limited", "plafond", 429) : null));
    const r = await daterReglements(b.client, b.depot, { ...b.options(JOUR1), concurrence: 1 });
    assert.deepEqual([r.ralenti, r.restantes], [true, 1]);
  });

  test("tant que des règlements restent à dater, la facture est au solde inconnu — jamais estimée", async () => {
    const b = banc({ client: [payee(1)], fournisseur: [] });
    await synchroniserFactures(b.client, b.depot, JOUR1);
    const s = situationBfr({ factures: b.factures(), date: "2026-09-30", stock: 0, synchroniseLe: "2026-10-21" });
    assert.equal(s.complete, false);
    assert.equal(s.incertaines.length, 1);
  });
});

describe("limiteur de débit", () => {
  test("jamais plus de N démarrages par fenêtre", async () => {
    const attentes: number[] = [];
    let horloge = 0;
    const reel = Date.now;
    Date.now = () => horloge;
    try {
      const reserver = limiteurDebit(3, 1_000, async (ms) => {
        attentes.push(ms);
        horloge += ms;
      });
      for (let i = 0; i < 7; i++) await reserver();
    } finally {
      Date.now = reel;
    }
    assert.equal(attentes.length, 2);
    assert.ok(horloge >= 2_000);
  });
});
