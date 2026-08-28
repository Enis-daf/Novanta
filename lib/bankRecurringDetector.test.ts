import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detecterChargesRecurrentes } from "./bankRecurringDetector";
import { NormalizedBankTransaction } from "./bankTransaction";

function transaction(date: string, label: string, signedAmount: number): NormalizedBankTransaction {
  return { date, labelOriginal: label, labelNormalized: label, signedAmount };
}

describe("detecterChargesRecurrentes", () => {
  test("mensuelle classique, même montant", () => {
    const transactions = [
      transaction("2026-05-05", "OVH", -128),
      transaction("2026-06-05", "OVH", -128),
      transaction("2026-07-05", "OVH", -128),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 1);
    assert.equal(candidats[0].frequence, "mensuel");
    assert.equal(candidats[0].montantPropose, 128);
    assert.equal(candidats[0].nombreOccurrences, 3);
  });

  test("mensuelle avec variation de change (Shopify) : détectée malgré des montants différents", () => {
    const transactions = [
      transaction("2026-05-02", "SHOPIFY", -37.96),
      transaction("2026-06-02", "SHOPIFY", -39.17),
      transaction("2026-07-02", "SHOPIFY", -38.42),
      transaction("2026-08-02", "SHOPIFY", -39.03),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 1);
    assert.equal(candidats[0].frequence, "mensuel");
    assert.equal(candidats[0].montantMin, 37.96);
    assert.equal(candidats[0].montantMax, 39.17);
  });

  test("montants trop variables (EDF) : non proposée", () => {
    const transactions = [
      transaction("2026-05-10", "EDF", -430),
      transaction("2026-06-10", "EDF", -912),
      transaction("2026-07-10", "EDF", -287),
    ];
    assert.equal(detecterChargesRecurrentes(transactions).length, 0);
  });

  test("mensuelle calendaire avec glissement de fin de mois", () => {
    const transactions = [
      transaction("2026-01-31", "LOYER", -1500),
      transaction("2026-02-28", "LOYER", -1500),
      transaction("2026-03-31", "LOYER", -1500),
      transaction("2026-04-30", "LOYER", -1500),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 1);
    assert.equal(candidats[0].frequence, "mensuel");
  });

  test("hebdomadaire : cadence d'environ 7 jours", () => {
    const transactions = [
      transaction("2026-06-01", "SALLE DE SPORT", -20),
      transaction("2026-06-08", "SALLE DE SPORT", -20),
      transaction("2026-06-15", "SALLE DE SPORT", -20),
      transaction("2026-06-22", "SALLE DE SPORT", -20),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 1);
    assert.equal(candidats[0].frequence, "hebdomadaire");
    assert.equal(candidats[0].prochaineOccurrenceEstimee, "2026-06-29");
  });

  test("moins de 3 occurrences : jamais proposée", () => {
    const transactions = [transaction("2026-05-02", "SHOPIFY", -39), transaction("2026-06-02", "SHOPIFY", -39)];
    assert.equal(detecterChargesRecurrentes(transactions).length, 0);
  });

  test("les crédits ne sont jamais considérés comme des charges récurrentes", () => {
    const transactions = [
      transaction("2026-05-05", "CLIENT X", 2500),
      transaction("2026-06-05", "CLIENT X", 2500),
      transaction("2026-07-05", "CLIENT X", 2500),
    ];
    assert.equal(detecterChargesRecurrentes(transactions).length, 0);
  });

  test("prochaine occurrence dérivée de la cadence mensuelle", () => {
    const transactions = [
      transaction("2026-04-05", "LOYER", -1500),
      transaction("2026-05-05", "LOYER", -1500),
      transaction("2026-06-05", "LOYER", -1500),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats[0].derniereOccurrence, "2026-06-05");
    assert.equal(candidats[0].prochaineOccurrenceEstimee, "2026-07-05");
  });

  test("cadence irrégulière (ni hebdomadaire ni mensuelle) : non proposée", () => {
    const transactions = [
      transaction("2026-05-01", "DIVERS", -20),
      transaction("2026-05-03", "DIVERS", -20),
      transaction("2026-05-19", "DIVERS", -20),
    ];
    assert.equal(detecterChargesRecurrentes(transactions).length, 0);
  });
});
