import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { versNormalizedBankTransactions } from "./pennylaneTransactionAdapter";
import { PennylaneTransactionRaw } from "./pennylaneClient";
import { analyserGrilleBancaire } from "./bankXlsxAdapter";
import { detecterChargesRecurrentes } from "./bankRecurringDetector";
import { controlerCoherence } from "./consistencyChecker";
import { FactureFournisseur } from "./types";

function pennylaneTx(overrides: Partial<PennylaneTransactionRaw> = {}): PennylaneTransactionRaw {
  return { id: 1, date: "2026-08-19", label: "VIR TEST", amount: "-100", ...overrides };
}

describe("versNormalizedBankTransactions — mapping pur, sans effet de bord", () => {
  test("transaction négative (débit) : signedAmount négatif, signe respecté tel quel", () => {
    const [t] = versNormalizedBankTransactions([pennylaneTx({ amount: "-128.00" })]);
    assert.equal(t.signedAmount, -128);
  });

  test("transaction positive (crédit) : signedAmount positif", () => {
    const [t] = versNormalizedBankTransactions([pennylaneTx({ amount: "2500.00" })]);
    assert.equal(t.signedAmount, 2500);
  });

  test("date transmise telle quelle (déjà au format YYYY-MM-DD)", () => {
    const [t] = versNormalizedBankTransactions([pennylaneTx({ date: "2026-08-03" })]);
    assert.equal(t.date, "2026-08-03");
  });

  test("label -> labelOriginal tel quel, labelNormalized dérivé par la même normalisation que le XLSX", () => {
    const [t] = versNormalizedBankTransactions([pennylaneTx({ label: "VIREMENT EMIS VIR INST SCI Les Ateliers" })]);
    assert.equal(t.labelOriginal, "VIREMENT EMIS VIR INST SCI Les Ateliers");
    assert.ok(t.labelNormalized.length > 0);
    assert.notEqual(t.labelNormalized, t.labelOriginal); // la normalisation retire bien les préfixes structurels
  });

  test("label null (transaction Pennylane sans libellé) : labelOriginal vide, jamais une exception", () => {
    const [t] = versNormalizedBankTransactions([pennylaneTx({ label: null })]);
    assert.equal(t.labelOriginal, "");
    assert.equal(t.labelNormalized, "");
  });

  test("plusieurs transactions : ordre préservé, conforme au NormalizedBankTransaction du moteur XLSX", () => {
    const resultat = versNormalizedBankTransactions([
      pennylaneTx({ id: 1, date: "2026-08-01", label: "A", amount: "-10" }),
      pennylaneTx({ id: 2, date: "2026-08-02", label: "B", amount: "20" }),
    ]);
    assert.equal(resultat.length, 2);
    assert.deepEqual(Object.keys(resultat[0]).sort(), ["date", "labelNormalized", "labelOriginal", "signedAmount"]);
  });
});

describe("Équivalence de source — XLSX et Pennylane doivent produire les mêmes résultats métier", () => {
  test("Test A : même historique -> mêmes Charges fixes proposées (RecurringTransactionDetector)", () => {
    // Un loyer mensuel stable sur 4 mois, même libellé brut, même montant, mêmes dates —
    // construit une fois "à la XLSX" (grille brute) et une fois "à la Pennylane" (objets API).
    const lignes = [
      { date: "2026-05-05", label: "VIREMENT EMIS VIR INST SCI Les Ateliers du Loyer Loyer Mai", montant: "-4200,00" },
      { date: "2026-06-05", label: "VIREMENT EMIS VIR INST SCI Les Ateliers du Loyer Loyer Juin", montant: "-4200,00" },
      { date: "2026-07-05", label: "VIREMENT EMIS VIR INST SCI Les Ateliers du Loyer Loyer Juillet", montant: "-4200,00" },
      { date: "2026-08-05", label: "VIREMENT EMIS VIR INST SCI Les Ateliers du Loyer Loyer Août", montant: "-4200,00" },
    ];

    const grilleXlsx = [
      ["Date", "Libellé", "Montant"],
      ...lignes.map((l) => [
        l.date.split("-").reverse().join("/"), // YYYY-MM-DD -> DD/MM/YYYY attendu par le parseur XLSX
        l.label,
        l.montant,
      ]),
    ];
    const transactionsXlsx = analyserGrilleBancaire(grilleXlsx).transactions;

    const transactionsPennylane = versNormalizedBankTransactions(
      lignes.map((l, i) => ({ id: i + 1, date: l.date, label: l.label, amount: String(-4200) }))
    );

    const candidatsXlsx = detecterChargesRecurrentes(transactionsXlsx);
    const candidatsPennylane = detecterChargesRecurrentes(transactionsPennylane);

    assert.equal(candidatsXlsx.length, candidatsPennylane.length);
    assert.equal(candidatsXlsx.length, 1);
    assert.equal(candidatsXlsx[0].libellePropose, candidatsPennylane[0].libellePropose);
    assert.equal(candidatsXlsx[0].montantPropose, candidatsPennylane[0].montantPropose);
    assert.equal(candidatsXlsx[0].frequence, candidatsPennylane[0].frequence);
    assert.equal(candidatsXlsx[0].nombreOccurrences, candidatsPennylane[0].nombreOccurrences);
  });

  test("Test B : mêmes 30 jours -> mêmes anomalies de cohérence (ConsistencyChecker)", () => {
    const facture: FactureFournisseur = {
      id: "ff-1",
      facture: "FA2607-0077",
      fournisseur: "Noxbat",
      montant: 4950,
      dateEcheance: "2026-08-19",
      datePaiementPrevue: "2026-08-19",
      litigieuse: false,
      payee: false,
      paidAt: null,
    };
    const dateReference = "2026-08-31";

    const grilleXlsx = [
      ["Date", "Libellé", "Montant"],
      ["19/08/2026", "VIR NOXBAT FA2607-0077", "-4950,00"],
    ];
    const transactionsXlsx = analyserGrilleBancaire(grilleXlsx).transactions;
    const transactionsPennylane = versNormalizedBankTransactions([
      { id: 1, date: "2026-08-19", label: "VIR NOXBAT FA2607-0077", amount: "-4950" },
    ]);

    const parametresVides = {
      facturesClients: [],
      autresDepenses: [],
      financements: [],
      dateReference,
    };
    const resultatXlsx = controlerCoherence({ ...parametresVides, facturesFournisseurs: [facture], transactions: transactionsXlsx });
    const resultatPennylane = controlerCoherence({
      ...parametresVides,
      facturesFournisseurs: [facture],
      transactions: transactionsPennylane,
    });

    assert.equal(resultatXlsx.issues.length, resultatPennylane.issues.length);
    assert.equal(resultatXlsx.issues.length, 1);
    assert.equal(resultatXlsx.issues[0].type, resultatPennylane.issues[0].type);
    assert.equal(resultatXlsx.issues[0].severity, resultatPennylane.issues[0].severity);
    assert.equal(resultatXlsx.issues[0].raison, resultatPennylane.issues[0].raison);
  });
});
