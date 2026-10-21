import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { estMasqueeApresPaiement, JOURS_VISIBILITE_APRES_PAIEMENT, reglementReelARecuperer } from "./dates";
import { dateDeReglementReel } from "./pennylaneInvoiceAdapter";

// Aujourd'hui fixé : mercredi 21/10/2026, 12 h (heure locale).
const MAINTENANT = new Date(2026, 9, 21, 12, 0, 0);
const ilYa = (jours: number) => new Date(MAINTENANT.getTime() - jours * 86_400_000).toISOString();
const masquee = (payee: boolean, paidAt: string | null, settledOn: string | null = null) => estMasqueeApresPaiement(payee, paidAt, settledOn, MAINTENANT);

describe("factures payées : masquées 7 jours après le règlement réel", () => {
  test("la règle reste de 7 jours", () => {
    assert.equal(JOURS_VISIBILITE_APRES_PAIEMENT, 7);
  });

  test("règlement réel il y a 6 jours : visible ; exactement 7 jours : visible ; 8 jours : masquée", () => {
    assert.equal(masquee(true, ilYa(0.1), "2026-10-15"), false);
    assert.equal(masquee(true, ilYa(0.1), "2026-10-14"), false);
    assert.equal(masquee(true, ilYa(0.1), "2026-10-13"), true);
  });

  test("bug corrigé : réglée en juillet, marquée Payée ce matin par la synchronisation -> masquée", () => {
    // Cas réel REICHELT 3308123 : rapprochée chez Pennylane le 20/10, synchronisée le 21/10.
    assert.equal(masquee(true, ilYa(0.2), "2026-07-28"), true);
    // Sans date réelle, la règle partait du marquage : visible jusqu'au 28/10.
    assert.equal(masquee(true, ilYa(0.2)), false);
  });

  test("facture Pennylane payée sans transaction rapprochée : les 7 jours partent du marquage", () => {
    assert.equal(masquee(true, ilYa(6)), false);
    assert.equal(masquee(true, ilYa(8)), true);
  });

  test("facture saisie dans Novanta : les 7 jours partent du clic, comme avant", () => {
    assert.equal(masquee(true, ilYa(6.9)), false);
    assert.equal(masquee(true, ilYa(7.1)), true);
  });

  test("facture non payée : toujours visible, même avec des dates", () => {
    assert.equal(masquee(false, ilYa(30), "2026-01-01"), false);
  });

  test("payée sans aucune date : jamais masquée (pas de disparition surprise)", () => {
    assert.equal(masquee(true, null), false);
    assert.equal(masquee(true, null, "date illisible"), false);
  });
});

describe("règlement réel : date de la dernière transaction rapprochée", () => {
  test("plusieurs transactions : la plus récente ; aucune : pas de date, jamais inventée", () => {
    assert.equal(dateDeReglementReel([{ date: "2026-07-02" }, { date: "2026-07-28" }, { date: "2026-07-15" }]), "2026-07-28");
    assert.equal(dateDeReglementReel([]), null);
    assert.equal(dateDeReglementReel([{ date: null }, { date: "illisible" }]), null);
  });

  test("à lire seulement pour une facture Pennylane payée, sans date réelle, encore visible", () => {
    const base = { payee: true, paidAt: ilYa(0.2), settledOn: null, pennylaneId: "28827162939392" };
    assert.equal(reglementReelARecuperer(base, MAINTENANT), true);
    assert.equal(reglementReelARecuperer({ ...base, pennylaneId: null }, MAINTENANT), false, "facture saisie dans Novanta");
    assert.equal(reglementReelARecuperer({ ...base, settledOn: "2026-07-28" }, MAINTENANT), false, "déjà connue");
    assert.equal(reglementReelARecuperer({ ...base, payee: false }, MAINTENANT), false, "non payée");
    assert.equal(reglementReelARecuperer({ ...base, paidAt: ilYa(9) }, MAINTENANT), false, "déjà masquée");
  });
});
