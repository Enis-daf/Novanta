import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  moisGlissants,
  FactureBfr,
  photographier,
  photographieDepassee,
  reviser,
  situationBfr,
  soldeALaDate,
  statutBfr,
  totauxRetenus,
  variationBfr,
} from "./pastBfr";
import { factureBfrDepuisPennylane, reglementsDepuisTransactions, reglementsNecessaires } from "./pastBfrPennylane";

const D = "2026-09-30";

// Facture fictive : 10 000 € HT, 12 000 € TTC, émise le 15/09, rien de réglé.
const facture = (champs: Partial<FactureBfr> = {}): FactureBfr => ({
  pennylaneId: "f1",
  type: "client",
  numero: "FA-001",
  tiers: "Client Alpha",
  dateEmission: "2026-09-15",
  echeance: "2026-10-15",
  devise: "EUR",
  montantTtc: 12_000,
  montantHt: 10_000,
  resteTtc: 12_000,
  resteHt: 10_000,
  exclusion: null,
  factureAvoireeId: null,
  reglements: null,
  ...champs,
});
const payee = (reglements: { date: string; montant: number }[], champs: Partial<FactureBfr> = {}) =>
  facture({ resteTtc: 0, resteHt: 0, reglements, ...champs });
const solde = (f: FactureBfr, avoirs: FactureBfr[] = []) => soldeALaDate(f, avoirs, D);

describe("BFR — factures ouvertes à la date de référence", () => {
  test("facture toujours impayée : incluse pour son montant HT", () => {
    assert.deepEqual(solde(facture()), { etat: "due", montantHt: 10_000, dateReglement: null });
  });

  test("payée après la date de référence : incluse, avec sa date de règlement effectif", () => {
    assert.deepEqual(solde(payee([{ date: "2026-10-02", montant: 12_000 }])), { etat: "due", montantHt: 10_000, dateReglement: "2026-10-02" });
  });

  test("payée avant la date de référence : exclue", () => {
    assert.deepEqual(solde(payee([{ date: "2026-09-28", montant: 12_000 }])), { etat: "hors" });
  });

  test("émise après la date de référence : exclue", () => {
    assert.deepEqual(solde(facture({ dateEmission: "2026-10-02" })), { etat: "hors" });
  });

  test("émise le dernier jour, impayée ce jour-là : incluse", () => {
    assert.equal(solde(facture({ dateEmission: D })).etat, "due");
  });

  test("émise et intégralement payée le dernier jour : exclue", () => {
    assert.deepEqual(solde(payee([{ date: D, montant: 12_000 }], { dateEmission: D })), { etat: "hors" });
  });

  test("récupérée après la date de référence ou saisie tardivement : seule la date d'émission compte", () => {
    // Rien ne dépend de la date d'import : une facture du 30/09 synchronisée le 02/10 est due au 30/09.
    const situation = situationBfr({ factures: [facture({ dateEmission: D })], date: D, stock: 0, synchroniseLe: "2026-10-02" });
    assert.equal(situation.totalCreances, 10_000);
    // Une facture de juin saisie en octobre compte dans le BFR de juin dès qu'elle est synchronisée.
    const juin = situationBfr({ factures: [facture({ dateEmission: "2026-06-10" })], date: "2026-06-30", stock: 0, synchroniseLe: "2026-10-02" });
    assert.equal(juin.totalCreances, 10_000);
  });

  test("brouillon, archivée, annulée, avoir, devis : jamais une créance ni une dette", () => {
    for (const exclusion of ["brouillon", "archivee", "annulee", "avoir", "hors_facture"] as const) {
      assert.deepEqual(solde(facture({ exclusion })), { etat: "hors" }, exclusion);
    }
  });

  test("avoir rattaché : déduit à partir de sa date d'émission seulement", () => {
    const avoir = facture({ pennylaneId: "av1", exclusion: "avoir", factureAvoireeId: "f1", montantHt: 4_000, montantTtc: 4_800, dateEmission: "2026-09-20" });
    // Rien de réglé : reste dû 7 200 TTC = 12 000 − 4 800.
    const f = facture({ resteTtc: 7_200, resteHt: 6_000 });
    assert.deepEqual(solde(f, [avoir]), { etat: "due", montantHt: 6_000, dateReglement: null });
    // Avoir émis après le 30/09 : la facture était due en entier au 30/09.
    assert.deepEqual(solde(f, [{ ...avoir, dateEmission: "2026-10-05" }]), { etat: "due", montantHt: 10_000, dateReglement: null });
    // Avoir total avant la date : plus rien de dû.
    const avoirTotal = { ...avoir, montantHt: 10_000, montantTtc: 12_000 };
    assert.deepEqual(solde(facture({ resteTtc: 0, resteHt: 0 }), [avoirTotal]), { etat: "hors" });
  });

  test("avoir client : n'est compté qu'une fois, via la facture qu'il crédite", () => {
    const avoir = facture({ pennylaneId: "av1", exclusion: "avoir", factureAvoireeId: "f1", montantHt: 4_000, montantTtc: 4_800, dateEmission: "2026-09-20" });
    const situation = situationBfr({ factures: [facture({ resteTtc: 7_200, resteHt: 6_000 }), avoir], date: D, stock: 0, synchroniseLe: "2026-10-02" });
    assert.equal(situation.totalCreances, 6_000);
    assert.equal(situation.creances.length, 1);
  });

  test("doublon Pennylane / Novanta : seules les factures Pennylane entrent, une fois chacune", () => {
    // La situation ne lit que les faits Pennylane : une facture également représentée dans Futur
    // (import, rapprochement) n'y a pas de seconde ligne.
    const situation = situationBfr({ factures: [facture()], date: D, stock: 0, synchroniseLe: "2026-10-02" });
    assert.equal(situation.creances.length, 1);
  });
});

describe("BFR — règlements et paiements partiels", () => {
  test("paiement intégral avant ou après : seule la date des transactions rapprochées compte", () => {
    assert.equal(solde(payee([{ date: "2026-09-01", montant: 12_000 }])).etat, "hors");
    assert.equal(solde(payee([{ date: "2026-12-01", montant: 12_000 }])).etat, "due");
  });

  test("paiement partiel avant la date : reste dû HT de Pennylane, jamais un TTC soustrait d'un HT", () => {
    const f = facture({ resteTtc: 7_200, resteHt: 6_000, reglements: [{ date: "2026-09-20", montant: 4_800 }] });
    assert.deepEqual(solde(f), { etat: "due", montantHt: 6_000, dateReglement: null });
  });

  test("plusieurs paiements, tous après : due en entier à la date de référence", () => {
    const f = payee([
      { date: "2026-10-05", montant: 6_000 },
      { date: "2026-11-05", montant: 6_000 },
    ]);
    assert.deepEqual(solde(f), { etat: "due", montantHt: 10_000, dateReglement: "2026-11-05" });
  });

  test("paiements avant ET après : solde inconnu, jamais approché", () => {
    const f = payee([
      { date: "2026-09-20", montant: 6_000 },
      { date: "2026-10-20", montant: 6_000 },
    ]);
    const resultat = solde(f);
    assert.equal(resultat.etat, "inconnue");
    if (resultat.etat === "inconnue") assert.equal(resultat.montantHtMax, 10_000);
  });

  test("réglée sans transaction rapprochée, ou règlements non récupérés : solde inconnu", () => {
    assert.equal(solde(payee([])).etat, "inconnue");
    assert.equal(solde(payee([], { reglements: null })).etat, "inconnue");
  });

  test("paiement prévu ≠ paiement effectif : une échéance ou une date prévue ne règle rien", () => {
    // Échéance passée, aucune transaction : la facture reste due, quelle que soit la date prévue.
    assert.equal(solde(facture({ echeance: "2026-09-01" })).etat, "due");
  });

  test("facture en devise partiellement réglée : inconnue ; non réglée : HT au taux de la facture", () => {
    assert.equal(solde(facture({ devise: "USD", resteTtc: 6_000, reglements: [{ date: "2026-09-01", montant: 6_000 }] })).etat, "inconnue");
    const usd = factureBfrDepuisPennylane("client", { id: 9, amount: "1100.0", currency: "USD", currency_amount: "1200.0", currency_amount_before_tax: "1000.0", date: "2026-09-01", remaining_amount_with_tax: "1100.0" }, null)!;
    assert.ok(Math.abs((usd.montantHt as number) - 1000 * (1100 / 1200)) < 1e-9);
  });

  test("montant HT absent : solde inconnu", () => {
    assert.equal(solde(facture({ montantHt: null })).etat, "inconnue");
  });
});

describe("BFR — situation, formule et variation", () => {
  const dette = (champs: Partial<FactureBfr> = {}) =>
    facture({ pennylaneId: "s1", type: "fournisseur", numero: "F-77", tiers: "Fournisseur Beta", montantHt: 3_000, montantTtc: 3_600, resteTtc: 3_600, resteHt: 3_000, ...champs });

  test("formule exacte : créances HT + stock HT − dettes HT", () => {
    const s = situationBfr({ factures: [facture(), dette()], date: D, stock: 5_000, synchroniseLe: "2026-10-02" });
    assert.equal(s.complete, true);
    assert.equal(s.totalCreances, 10_000);
    assert.equal(s.totalDettes, 3_000);
    assert.equal(s.bfr, 10_000 + 5_000 - 3_000);
  });

  test("inventaire manquant : situation incomplète, aucun BFR affiché", () => {
    const s = situationBfr({ factures: [facture()], date: D, stock: null, synchroniseLe: "2026-10-02" });
    assert.equal(s.complete, false);
    assert.equal(s.bfr, null);
    assert.match(s.raisons.join(" "), /Stock HT non renseigné pour septembre 2026/);
  });

  test("facture au solde inconnu : incomplète, signalée avec son montant maximal", () => {
    const s = situationBfr({ factures: [facture(), payee([], { pennylaneId: "f2" })], date: D, stock: 0, synchroniseLe: "2026-10-02" });
    assert.equal(s.complete, false);
    assert.equal(s.incertaines.length, 1);
    assert.equal(s.incertaines[0].montantHtMax, 10_000);
  });

  test("synchronisation au plus tard à la date de référence : incomplète ; jamais synchronisée aussi", () => {
    assert.equal(situationBfr({ factures: [], date: D, stock: 0, synchroniseLe: "2026-09-29" }).complete, false);
    assert.equal(situationBfr({ factures: [], date: D, stock: 0, synchroniseLe: D }).complete, false);
    assert.equal(situationBfr({ factures: [], date: D, stock: 0, synchroniseLe: null }).complete, false);
    assert.equal(situationBfr({ factures: [], date: D, stock: 0, synchroniseLe: "2026-10-01" }).complete, true);
  });

  test("signes : hausse des créances et du stock = hausse du BFR ; hausse des dettes = baisse", () => {
    const v = variationBfr({ creances: 100, stock: 50, dettes: 80, bfr: 70 }, { creances: 130, stock: 60, dettes: 100, bfr: 90 });
    assert.equal(v.creances, 30);
    assert.equal(v.stock, 10);
    assert.equal(v.dettes, -20);
    // Les contributions se réconcilient exactement avec la variation du BFR.
    assert.equal(v.total, 90 - 70);
  });

  test("évolution mensuelle : chaque fin de mois a sa propre situation", () => {
    const factures = [facture({ dateEmission: "2026-08-10" }), payee([{ date: "2026-09-10", montant: 1 }], { pennylaneId: "f2", dateEmission: "2026-08-20" })];
    const aout = situationBfr({ factures, date: "2026-08-31", stock: 0, synchroniseLe: "2026-10-02" });
    const septembre = situationBfr({ factures, date: D, stock: 0, synchroniseLe: "2026-10-02" });
    assert.equal(aout.totalCreances, 20_000);
    assert.equal(septembre.totalCreances, 10_000);
  });
});

describe("BFR — situations validées", () => {
  const complete = situationBfr({ factures: [facture()], date: D, stock: 5_000, synchroniseLe: "2026-10-02" });

  test("création provisoire, puis validation : la photographie garde totaux ET factures retenues", () => {
    assert.equal(statutBfr(complete, null), "provisoire");
    const photo = photographier(complete, "2026-10-02", "2026-10-03T09:00:00.000Z")!;
    assert.equal(photo.bfr, 15_000);
    assert.equal(photo.creancesRetenues[0].numero, "FA-001");
    assert.equal(statutBfr(complete, photo), "validee");
  });

  test("situation incomplète : rien à valider", () => {
    const incomplete = situationBfr({ factures: [facture()], date: D, stock: null, synchroniseLe: "2026-10-02" });
    assert.equal(photographier(incomplete, "2026-10-02", "2026-10-03T09:00:00.000Z"), null);
    assert.equal(statutBfr(incomplete, null), "incomplete");
  });

  test("enrichissement après synchronisation : le provisoire suit, la photographie validée ne bouge pas", () => {
    const photo = photographier(complete, "2026-10-02", "2026-10-03T09:00:00.000Z")!;
    const enrichie = situationBfr({ factures: [facture(), facture({ pennylaneId: "f9", dateEmission: "2026-09-25" })], date: D, stock: 5_000, synchroniseLe: "2026-10-10" });
    assert.equal(enrichie.bfr, 25_000);
    assert.deepEqual(totauxRetenus(enrichie, photo), { creances: 10_000, stock: 5_000, dettes: 0, bfr: 15_000 });
    assert.equal(photographieDepassee(photo, enrichie), true);
    assert.equal(photographieDepassee(photo, complete), false);
  });

  test("révision explicite : nouvelle photographie, ancienne version tracée", () => {
    const photo = photographier(complete, "2026-10-02", "2026-10-03T09:00:00.000Z")!;
    const enrichie = situationBfr({ factures: [facture(), facture({ pennylaneId: "f9" })], date: D, stock: 5_000, synchroniseLe: "2026-10-10" });
    const revisee = reviser(photo, photographier(enrichie, "2026-10-10", "2026-10-11T08:00:00.000Z")!, "2026-10-11T08:00:00.000Z");
    assert.equal(revisee.bfr, 25_000);
    assert.equal(revisee.revisions.length, 1);
    assert.equal(revisee.revisions[0].precedente.bfr, 15_000);
    assert.equal(revisee.revisions[0].revisee, "2026-10-11T08:00:00.000Z");
  });
});

describe("BFR — lecture des factures Pennylane", () => {
  test("facture fournisseur : reste dû négatif chez Pennylane, lu en positif", () => {
    const f = factureBfrDepuisPennylane(
      "fournisseur",
      { id: 1, amount: "1200.0", currency_amount_before_tax: "1000.0", remaining_amount_with_tax: "-1200.0", remaining_amount_without_tax: "-1000.0", date: "2026-09-01", label: "Facture FOURNISSEUR TEST - F-1 (label généré)" },
      null
    )!;
    assert.equal(f.resteTtc, 1_200);
    assert.equal(f.resteHt, 1_000);
    assert.equal(f.tiers, "FOURNISSEUR TEST");
    assert.equal(reglementsNecessaires(f), false);
  });

  test("avoirs, brouillons, archives, devis : exclusions lues sur les champs Pennylane", () => {
    const lire = (type: "client" | "fournisseur", champs: object) => factureBfrDepuisPennylane(type, { id: 1, amount: "100.0", ...champs }, null)!.exclusion;
    assert.equal(lire("client", { status: "credit_note", amount: "-100.0", credited_invoice: { id: 7 } }), "avoir");
    assert.equal(lire("client", { draft: true }), "brouillon");
    assert.equal(lire("client", { status: "cancelled" }), "annulee");
    assert.equal(lire("client", { status: "archived" }), "archivee");
    assert.equal(lire("client", { status: "estimate_pending" }), "hors_facture");
    assert.equal(lire("client", { status: "late" }), null);
    assert.equal(lire("fournisseur", { amount: "-50.0" }), "avoir");
    assert.equal(lire("fournisseur", { accounting_status: "archived" }), "archivee");
    assert.equal(lire("fournisseur", { payment_status: "to_be_paid" }), null);
  });

  test("règlements datés par les transactions rapprochées, triés ; sans date : ignorés", () => {
    assert.deepEqual(
      reglementsDepuisTransactions([
        { id: 2, date: "2026-10-02", amount: "-500.0" },
        { id: 1, date: "2026-09-02", amount: "700.0" },
        { id: 3, date: null, amount: "1.0" },
      ]),
      [
        { date: "2026-09-02", montant: 700 },
        { date: "2026-10-02", montant: 500 },
      ]
    );
  });

  test("règlements à dater seulement si une partie est réglée aujourd'hui", () => {
    assert.equal(reglementsNecessaires(facture()), false);
    assert.equal(reglementsNecessaires(facture({ resteTtc: 0 })), true);
    assert.equal(reglementsNecessaires(facture({ resteTtc: 0, exclusion: "archivee" })), false);
  });
});

describe("BFR — évolution sur 12 mois glissants", () => {
  test("septembre 2026 -> octobre 2025 à septembre 2026, 12 mois exactement", () => {
    const m = moisGlissants("2026-09");
    assert.equal(m.length, 12);
    assert.deepEqual([m[0], m[2], m[3], m[11]], ["2025-10", "2025-12", "2026-01", "2026-09"]);
  });

  test("janvier : décembre et onze mois de l'année précédente, sans trou", () => {
    assert.deepEqual(moisGlissants("2026-01", 3), ["2025-11", "2025-12", "2026-01"]);
  });

  test("un mois sans stock reste sans valeur : jamais 0", () => {
    const s = situationBfr({ factures: [], date: "2026-03-31", stock: null, synchroniseLe: "2026-10-02" });
    assert.equal(s.bfr, null);
    assert.equal(totauxRetenus(s, null), null);
  });
});
