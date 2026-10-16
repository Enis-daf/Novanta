import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { candidatFactureFournisseur, candidatVersFactureFournisseur } from "./pennylaneInvoiceAdapter";
import { PennylaneSupplierInvoiceListItem } from "./pennylaneClient";
import { calculerProjectionCash } from "./cash-engine";

// Facture réelle QANNT (Pennylane id 22044927496192), telle que renvoyée par
// GET /api/external/v2/supplier_invoices le 16/10/2026 : total 39 816 €, 27 871,20 € réglés.
const FR_SI_261751: PennylaneSupplierInvoiceListItem = {
  id: 22044927496192,
  invoice_number: "FR-SI-261751",
  date: "2026-05-20",
  label: "Facture TKH SECURITY SAS - FR-SI-261751 (label généré)",
  amount: "39816.0",
  deadline: "2026-07-09",
  paid: false,
  payment_status: "to_be_paid",
  accounting_status: "validation_needed",
  archived_at: null,
  remaining_amount_with_tax: "-11944.8",
};

describe("régression : facture fournisseur partiellement payée", () => {
  test("FR-SI-261751 : Novanta projette le reste à payer 11 944,80 €, pas le total 39 816 €", () => {
    const candidat = candidatFactureFournisseur(FR_SI_261751)!;
    assert.equal(candidat.montant, 11_944.8);
    const facture = { ...candidatVersFactureFournisseur(candidat), datePaiementPrevue: "2026-10-20" };
    const projection = calculerProjectionCash({
      soldeInitial: 0,
      facturesClients: [],
      facturesFournisseurs: [facture],
      chargesFixes: [],
      autresDepenses: [],
      financements: [],
      rentreesRegulieres: [],
      dateDepart: "2026-10-16",
      horizonJours: 30,
    });
    // Solde initial 0 : le solde projeté final est l'impact de la facture.
    assert.equal(Math.round(projection.soldeJ90 * 100) / 100, -11_944.8);
  });
});

// --- Cas limites : reste à payer Pennylane -> montant de trésorerie Novanta ---

import {
  calculerSynchronisation,
  candidatFactureClient,
  candidatsFournisseursPennylane,
  FactureExistantePourSync,
  messageSyncPennylane,
  montantRestantDu,
} from "./pennylaneInvoiceAdapter";
import { listSupplierInvoices, PennylaneCustomerInvoiceListItem } from "./pennylaneClient";
import { CompanyApiTokenCredentialProvider } from "./pennylaneCredentialProvider";

const fournisseur = (overrides: Partial<PennylaneSupplierInvoiceListItem> = {}): PennylaneSupplierInvoiceListItem => ({
  ...FR_SI_261751,
  ...overrides,
});
const client = (overrides: Partial<PennylaneCustomerInvoiceListItem> = {}): PennylaneCustomerInvoiceListItem => ({
  id: 32437561815040,
  invoice_number: "FA2610-0095",
  date: "2026-10-15",
  label: "Facture Client - FA2610-0095 (label généré)",
  amount: "109088.1",
  deadline: "2026-11-13",
  paid: false,
  draft: false,
  status: "incomplete",
  archived_at: null,
  remaining_amount_with_tax: "109088.1",
  currency: "EUR",
  ...overrides,
});
const existante = (montant: number, extra: Partial<FactureExistantePourSync> = {}): FactureExistantePourSync => ({
  id: "novanta-1",
  pennylaneId: "22044927496192",
  payee: false,
  montant,
  ...extra,
});
const sync = (item: PennylaneSupplierInvoiceListItem, etat: FactureExistantePourSync[]) =>
  calculerSynchronisation(candidatsFournisseursPennylane([item]).candidats, etat);

describe("reste à payer Pennylane : cas limites", () => {
  test("A. facture non payée, aucun règlement : 10 000 projetés", () => {
    assert.equal(candidatFactureFournisseur(fournisseur({ amount: "10000.0", remaining_amount_with_tax: "-10000.0" }))!.montant, 10_000);
  });

  test("C. second règlement : la resynchronisation ramène 11 944,80 au nouveau reste dû, sans doublon", () => {
    const resultat = sync(fournisseur({ remaining_amount_with_tax: "-9944.8" }), [existante(11_944.8)]);
    assert.deepEqual(resultat.montantsAMettreAJour, [{ id: "novanta-1", montant: 9_944.8 }]);
    assert.deepEqual([resultat.aInserer, resultat.idsAMettreAJourPayee, resultat.idsASupprimer], [[], [], []]);
  });

  test("C bis. second règlement de 5 000 € : reste 6 944,80 € (82,6 % réglés) projeté", () => {
    const resultat = sync(fournisseur({ remaining_amount_with_tax: "-6944.8" }), [existante(11_944.8)]);
    assert.deepEqual(resultat.montantsAMettreAJour, [{ id: "novanta-1", montant: 6_944.8 }]);
    assert.deepEqual(resultat.idsAMettreAJourPayee, []);
  });

  test("seuil de 98 % : un écart de change résiduel vaut règlement complet", () => {
    // 39 816 € dont 39 100 € réglés : 98,2 % couverts.
    const resultat = sync(fournisseur({ remaining_amount_with_tax: "-716.0" }), [existante(6_944.8)]);
    assert.deepEqual([resultat.idsAMettreAJourPayee, resultat.montantsAMettreAJour], [["novanta-1"], []]);
  });

  test("première synchronisation après correctif : une ligne importée au total est ramenée au reste dû", () => {
    assert.deepEqual(sync(FR_SI_261751, [existante(39_816)]).montantsAMettreAJour, [{ id: "novanta-1", montant: 11_944.8 }]);
  });

  test("D. facture totalement payée : reste 0 → Payée, montant non touché, plus d'impact", () => {
    const item = fournisseur({ remaining_amount_with_tax: "0.0" });
    const resultat = sync(item, [existante(6_944.8)]);
    assert.deepEqual(resultat.idsAMettreAJourPayee, ["novanta-1"]);
    assert.deepEqual(resultat.montantsAMettreAJour, []);
    assert.equal(candidatFactureFournisseur(item)!.payee, true);
    const projection = calculerProjectionCash({
      soldeInitial: 0,
      facturesClients: [],
      facturesFournisseurs: [{ ...candidatVersFactureFournisseur(candidatFactureFournisseur(item)!), payee: true, datePaiementPrevue: "2026-10-20" }],
      chargesFixes: [],
      autresDepenses: [],
      financements: [],
      rentreesRegulieres: [],
      dateDepart: "2026-10-16",
      horizonJours: 30,
    });
    assert.equal(projection.soldeJ90, 0);
  });

  test("E. synchronisation répétée sans changement : aucune mise à jour, aucune insertion", () => {
    const resultat = sync(FR_SI_261751, [existante(11_944.8)]);
    assert.deepEqual([resultat.aInserer, resultat.idsAMettreAJourPayee, resultat.montantsAMettreAJour], [[], [], []]);
  });

  test("F. facture sans échéance : importée sur sa date, le lot continue", () => {
    const { candidats } = candidatsFournisseursPennylane([fournisseur({ deadline: null }), fournisseur({ id: 2, invoice_number: "X-0002", remaining_amount_with_tax: "-500.0", amount: "800.0" })]);
    assert.deepEqual(candidats.map((c) => [c.dateEcheance, c.montant]), [["2026-05-20", 11_944.8], ["2026-07-09", 500]]);
  });

  test("G. facture ancienne partiellement payée : reste dû exact", () => {
    assert.equal(candidatFactureFournisseur(fournisseur({ date: "2024-02-01", deadline: "2024-03-01", amount: "43668.0", remaining_amount_with_tax: "-33228.0" }))!.montant, 33_228);
  });

  test("H. décimales : exactitude au centime", () => {
    assert.equal(candidatFactureFournisseur(fournisseur({ amount: "34800.0", remaining_amount_with_tax: "-13317.36" }))!.montant, 13_317.36);
    assert.equal(montantRestantDu({ amount: "0.3", remaining_amount_with_tax: "-0.1", currency: "EUR" }, "fournisseur"), 0.1);
  });

  test("I. facture litigieuse : la synchronisation n'actualise que le montant, la projection l'exclut toujours", () => {
    const resultat = sync(fournisseur({ remaining_amount_with_tax: "-9944.8" }), [existante(11_944.8, { payee: false })]);
    assert.deepEqual(Object.keys(resultat.montantsAMettreAJour[0]).sort(), ["id", "montant"]);
    const projection = calculerProjectionCash({
      soldeInitial: 0,
      facturesClients: [],
      facturesFournisseurs: [{ ...candidatVersFactureFournisseur(candidatFactureFournisseur(FR_SI_261751)!), litigieuse: true, datePaiementPrevue: "2026-10-20" }],
      chargesFixes: [],
      autresDepenses: [],
      financements: [],
      rentreesRegulieres: [],
      dateDepart: "2026-10-16",
      horizonJours: 30,
    });
    assert.equal(projection.soldeJ90, 0);
  });

  test("J. pagination Pennylane : même reste dû sur toutes les pages", async () => {
    const fetchOriginal = global.fetch;
    const pages = [
      { items: [fournisseur({ id: 1, invoice_number: "P1" })], has_more: true, next_cursor: "c2" },
      { items: [fournisseur({ id: 2, invoice_number: "P2", remaining_amount_with_tax: "-9944.8" })], has_more: false, next_cursor: null },
    ];
    let appel = 0;
    global.fetch = (async () => new Response(JSON.stringify(pages[appel++]), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const items = await listSupplierInvoices(new CompanyApiTokenCredentialProvider("jeton-de-test"));
      assert.deepEqual(candidatsFournisseursPennylane(items).candidats.map((c) => c.montant), [11_944.8, 9_944.8]);
    } finally {
      global.fetch = fetchOriginal;
    }
  });

  test("garde-fous : reste absent, incohérent ou en devise → total conservé, rien d'inventé", () => {
    for (const overrides of [
      { remaining_amount_with_tax: null },
      { remaining_amount_with_tax: "n/a" },
      { remaining_amount_with_tax: "-50000.0" }, // supérieur au total
      { remaining_amount_with_tax: "120.0" }, // signe inattendu sur une facture fournisseur
      { currency: "USD", remaining_amount_with_tax: "-10.0" },
    ]) {
      assert.equal(candidatFactureFournisseur(fournisseur(overrides))!.montant, 39_816, JSON.stringify(overrides));
    }
  });

  test("factures CLIENTS : même règle, reste positif côté clients", () => {
    assert.equal(candidatFactureClient(client())!.montant, 109_088.1);
    assert.equal(candidatFactureClient(client({ remaining_amount_with_tax: "40000.0" }))!.montant, 40_000);
    assert.equal(candidatFactureClient(client({ remaining_amount_with_tax: "-40000.0" }))!.montant, 109_088.1, "signe fournisseur sur un client : ignoré");
  });

  test("message de synchronisation : montants ramenés au reste à payer", () => {
    const base = { nombreClientsAnalysees: 0, nombreFournisseursAnalysees: 1, nombreClientsAjoutes: 0, nombreFournisseursAjoutes: 0, nombreMarquesPayees: 0, nombreArchiveesRetirees: 0, erreurClients: null, erreurFournisseurs: null };
    assert.ok(messageSyncPennylane({ ...base, nombreMontantsActualises: 1 }).includes("1 montant ramené au reste à payer Pennylane."));
    assert.ok(!messageSyncPennylane(base).includes("reste à payer"));
  });
});

describe("resynchronisation : seules les factures en partie réglées sont actualisées", () => {
  test("facture sans règlement dont le montant Novanta diffère : montant Novanta conservé (comportement inchangé)", () => {
    const sansReglement = fournisseur({ amount: "12086.4", remaining_amount_with_tax: "-12086.4" });
    assert.deepEqual(sync(sansReglement, [existante(12_086)]).montantsAMettreAJour, []);
  });

  test("le candidat porte le total et le reste dû", () => {
    const candidat = candidatFactureFournisseur(FR_SI_261751)!;
    assert.deepEqual([candidat.montantFacture, candidat.montant], [39_816, 11_944.8]);
  });
});
