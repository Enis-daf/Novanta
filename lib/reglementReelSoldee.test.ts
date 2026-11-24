import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { estFactureMasquee, reglementReelARecuperer } from "./dates";
import { reglementReelSiSoldee } from "./pennylaneInvoiceAdapter";
import { factureClientToRow, factureFournisseurToRow, rowToFactureFournisseur } from "./supabaseRepository";
import type { FactureClient, FactureFournisseur } from "./types";

// Cas réel du 24/11/2026 : KUBII FA451261 (Novanta 17b95f3c, Pennylane 33096746827776).
// Chez Pennylane : 49 080 € TTC, non payée (to_be_paid), reste dû 41 364 €, un acompte de 7 716 €
// rapproché le 14/08. Marquée « Payée » dans Novanta par erreur le 24/11 à 17:24 ; la route de
// règlement a écrit settled_on = 2026-08-14 (date de l'acompte) et la facture a disparu aussitôt.
const MAINTENANT = new Date(2026, 10, 24, 17, 30, 0);
const FA451261_PENNYLANE = { paid: false, payment_status: "to_be_paid", remaining_amount_with_tax: "-41364.0", amount: "49080.0" };
const ACOMPTE_14_08 = [{ date: "2026-08-14", amount: "-7716.0" }];

describe("règlement réel : seulement pour une facture soldée chez Pennylane", () => {
  test("cas réel FA451261 : un acompte rapproché n'est pas un règlement réel", () => {
    assert.equal(reglementReelSiSoldee("fournisseur", FA451261_PENNYLANE, ACOMPTE_14_08), null);
  });

  test("FA451261 marquée Payée le 18/11 : l'acompte du 14/08 ne la masque plus, l'échéance (option B) décide", () => {
    // Même facture, marquage avancé au 18/11 pour isoler l'effet de l'acompte : avant correction,
    // settled_on = 14/08 -> masquée sur-le-champ ; après, échéance 14/11 -> visible jusqu'au 21/11.
    const le18 = new Date(2026, 10, 18, 12, 0, 0);
    const settledOn = reglementReelSiSoldee("fournisseur", FA451261_PENNYLANE, ACOMPTE_14_08);
    const facture = { payee: true, paidAt: "2026-11-18T10:00:00.000Z", settledOn, pennylaneId: "33096746827776", dateEcheance: "2026-11-14" };
    assert.equal(estFactureMasquee(facture, le18), false);
    assert.equal(estFactureMasquee({ ...facture, settledOn: "2026-08-14" }, le18), true, "comportement avant correction");
  });

  test("FA451261 marquée Payée le 24/11 : masquée, par l'échéance du 14/11 (option B du 21/10), pas par l'acompte", () => {
    const settledOn = reglementReelSiSoldee("fournisseur", FA451261_PENNYLANE, ACOMPTE_14_08);
    const facture = { payee: true, paidAt: "2026-11-24T17:24:59.200Z", settledOn, pennylaneId: "33096746827776", dateEcheance: "2026-11-14" };
    assert.equal(estFactureMasquee(facture, MAINTENANT), true);
  });

  test("facture fournisseur soldée chez Pennylane : la dernière transaction fait foi (inchangé)", () => {
    const soldee = { paid: true, payment_status: "fully_paid", remaining_amount_with_tax: "0.0", amount: "49080.0" };
    assert.equal(reglementReelSiSoldee("fournisseur", soldee, [{ date: "2026-08-14" }, { date: "2026-11-20" }]), "2026-11-20");
    // Couverte à 98 % par un règlement d'un montant légèrement différent : soldée aussi.
    const couverte = { paid: false, payment_status: "to_be_paid", remaining_amount_with_tax: "-500.0", amount: "49080.0" };
    assert.equal(reglementReelSiSoldee("fournisseur", couverte, [{ date: "2026-11-20" }]), "2026-11-20");
  });

  test("facture fournisseur archivée : jamais une date de règlement", () => {
    const archivee = { paid: false, payment_status: "to_be_paid", accounting_status: "archived", amount: "100" };
    assert.equal(reglementReelSiSoldee("fournisseur", archivee, [{ date: "2026-08-14" }]), null);
  });

  test("facture client : payée chez Pennylane -> date ; ouverte -> aucune", () => {
    assert.equal(reglementReelSiSoldee("client", { paid: true, status: "paid" }, [{ date: "2026-11-02" }]), "2026-11-02");
    assert.equal(reglementReelSiSoldee("client", { paid: false, status: "upcoming" }, [{ date: "2026-11-02" }]), null);
  });
});

describe("décocher « Payée » efface la date de règlement réel", () => {
  test("facture fournisseur non payée : settled_on remis à null ; payée : settled_on non touché", () => {
    const f: FactureFournisseur = {
      id: "17b95f3c-1810-4b84-80a9-51dff3c37029", facture: "FA451261", fournisseur: "KUBII", montant: 41364,
      dateEcheance: "2026-11-14", datePaiementPrevue: "2026-11-20", litigieuse: false, payee: false, paidAt: null, settledOn: "2026-08-14",
    };
    assert.equal(factureFournisseurToRow("c", f).settled_on, null);
    assert.equal("settled_on" in factureFournisseurToRow("c", { ...f, payee: true, paidAt: "2026-11-24T17:24:59.200Z" }), false);
  });

  test("facture client non payée : settled_on remis à null", () => {
    const f: FactureClient = {
      id: "x", facture: "F1", client: "C", montant: 1, dateEcheance: "2026-11-14", dateEncaissementAnticipee: "",
      litigieuse: false, payee: false, paidAt: null, settledOn: "2026-08-14",
    };
    assert.equal(factureClientToRow("c", f).settled_on, null);
  });
});

describe("« Payée » cochée à la main : visible 7 jours après le clic (décision du 24/11/2026)", () => {
  const fa451261 = { payee: true, paidAt: "2026-11-24T17:24:59.200Z", settledOn: null, pennylaneId: "33096746827776", dateEcheance: "2026-11-14" };

  test("cas réel FA451261 cochée le 24/11 : visible jusqu'au 1/12, masquée ensuite", () => {
    const manuelle = { ...fa451261, paidOrigin: "manual" as const };
    assert.equal(estFactureMasquee(manuelle, MAINTENANT), false);
    assert.equal(estFactureMasquee(manuelle, new Date(2026, 11, 1, 12, 0, 0)), false);
    assert.equal(estFactureMasquee(manuelle, new Date(2026, 11, 2, 12, 0, 0)), true);
  });

  test("cochée à la main : même un règlement réel ne raccourcit pas les 7 jours", () => {
    assert.equal(estFactureMasquee({ ...fa451261, paidOrigin: "manual" as const, settledOn: "2026-08-14" }, MAINTENANT), false);
  });

  test("marquée par la synchronisation : option B inchangée (échéance du 14/11 -> masquée)", () => {
    assert.equal(estFactureMasquee({ ...fa451261, paidOrigin: "sync" as const }, MAINTENANT), true);
  });

  test("origine inconnue (factures payées avant cette version) : règle actuelle", () => {
    assert.equal(estFactureMasquee({ ...fa451261, paidOrigin: null }, MAINTENANT), true);
    assert.equal(estFactureMasquee(fa451261, MAINTENANT), true);
  });

  test("cochée à la main : pas de règlement réel à demander à Pennylane", () => {
    assert.equal(reglementReelARecuperer({ ...fa451261, paidOrigin: "manual" as const }, MAINTENANT), false);
    assert.equal(reglementReelARecuperer({ ...fa451261, paidOrigin: "sync" as const }, MAINTENANT), true);
  });

  test("origine enregistrée avec la ligne ; effacée quand la facture n'est plus payée", () => {
    const f: FactureFournisseur = {
      id: "17b95f3c-1810-4b84-80a9-51dff3c37029", facture: "FA451261", fournisseur: "KUBII", montant: 41364,
      dateEcheance: "2026-11-14", datePaiementPrevue: "2026-11-20", litigieuse: false, payee: true,
      paidAt: "2026-11-24T17:24:59.200Z", paidOrigin: "manual",
    };
    assert.equal(factureFournisseurToRow("c", f).paid_origin, "manual");
    assert.equal(factureFournisseurToRow("c", { ...f, payee: false, paidAt: null }).paid_origin, null);
    assert.equal(rowToFactureFournisseur({ ...factureFournisseurToRow("c", f), paid_origin: "manual" }).paidOrigin, "manual");
    assert.equal(rowToFactureFournisseur({ ...factureFournisseurToRow("c", f), paid_origin: "bizarre" }).paidOrigin, null);
  });
});
