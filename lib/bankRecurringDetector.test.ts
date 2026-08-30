import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detecterChargesRecurrentes } from "./bankRecurringDetector";
import { NormalizedBankTransaction, normaliserLibelleBancaire } from "./bankTransaction";

function transactionBrute(date: string, labelOriginal: string, signedAmount: number): NormalizedBankTransaction {
  return { date, labelOriginal, labelNormalized: normaliserLibelleBancaire(labelOriginal), signedAmount };
}

function transaction(date: string, label: string, signedAmount: number): NormalizedBankTransaction {
  return { date, labelOriginal: label, labelNormalized: label, signedAmount };
}

describe("detecterChargesRecurrentes — cadences de base", () => {
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

  test("H. moins de 3 occurrences : jamais proposée", () => {
    const transactions = [transaction("2026-05-02", "SHOPIFY", -39), transaction("2026-06-02", "SHOPIFY", -39)];
    assert.equal(detecterChargesRecurrentes(transactions).length, 0);
  });
});

describe("detecterChargesRecurrentes — RÉCURRENCE = IDENTITÉ + CADENCE (montant = qualification)", () => {
  test("A. loyer stable (montant identique chaque mois) : détecté et qualifié stable", () => {
    const transactions = [
      transactionBrute("2026-05-05", "VIREMENT EMIS WEB SCI LES ATELIERS DU Loyer Mai bureaux VAYRAC", -1092),
      transactionBrute("2026-06-05", "VIREMENT EMIS VIR INST vers SCI LES ATELIERS D Loyer Juin bureaux VAYRAC", -1092),
      transactionBrute("2026-07-06", "VIREMENT EMIS WEB SCI LES ATELIERS DU Loyer Juillet locaux VAYRAC", -1092),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 1);
    assert.equal(candidats[0].frequence, "mensuel");
    assert.equal(candidats[0].montantPropose, 1092);
    assert.equal(candidats[0].profilMontant, "stable");
  });

  test("B. loyer quasi stable (légère variation) : détecté", () => {
    const transactions = [
      transactionBrute("2026-04-03", "VIREMENT EMIS VIR INST vers SAS CELAUR VALLEE Loyer QANNT Puybrun", -735.0),
      transactionBrute("2026-05-05", "VIREMENT EMIS VIR INST vers SAS CELAUR VALLEE Loyer Mai QANNT Puybrun", -735.56),
      transactionBrute("2026-06-03", "VIREMENT EMIS VIR INST vers SAS CELAUR VALLEE Loyer Juin QANNT Puybrun", -735.56),
      transactionBrute("2026-07-06", "VIREMENT EMIS VIR INST vers SAS CELAUR VALLEE loyer Juillet QANNT Puybrun", -735.2),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 1);
    assert.equal(candidats[0].frequence, "mensuel");
    assert.equal(candidats[0].nombreOccurrences, 4);
  });

  test("C. abonnement en devise (montant qui varie mais reste proche) : détecté", () => {
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

  test("D. salaire variable (même bénéficiaire, cadence mensuelle) : détecté", () => {
    const transactions = [
      transactionBrute("2026-04-28", "VIREMENT EMIS VIR INST vers Louis DHELLEMMES Salaire Avril QANNT", -2350),
      transactionBrute("2026-05-28", "VIREMENT EMIS VIR INST vers Louis DHELLEMMES Salaire Mai QANNT", -2420),
      transactionBrute("2026-06-28", "VIREMENT EMIS VIR INST vers Louis DHELLEMMES Salaire Juin QANNT", -2310),
      transactionBrute("2026-07-28", "VIREMENT EMIS VIR INST vers Louis DHELLEMMES Salaire Juillet QANNT", -2500),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 1);
    assert.equal(candidats[0].frequence, "mensuel");
    assert.equal(candidats[0].nombreOccurrences, 4);
  });

  test("E. montant très variable (même bénéficiaire + cadence mensuelle claire) : détecté et qualifié variable", () => {
    const transactions = [
      transactionBrute("2026-02-10", "VIREMENT EMIS WEB EDF ENERGIE Facture fevrier", -430),
      transactionBrute("2026-03-10", "VIREMENT EMIS WEB EDF ENERGIE Facture mars", -912),
      transactionBrute("2026-04-10", "VIREMENT EMIS WEB EDF ENERGIE Facture avril", -287),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 1);
    assert.equal(candidats[0].frequence, "mensuel");
    assert.equal(candidats[0].profilMontant, "variable");
  });

  test("F. libellés variables (références/mois/numéros différents, même bénéficiaire) : regroupés en un seul candidat", () => {
    const transactions = [
      transactionBrute(
        "2025-10-06",
        "VIREMENT EMIS WEB SCI LES ATELIERS DU QANNT Loyer OCTOBRE bureaux aterlier VAYRAC QANNT",
        -1092
      ),
      transactionBrute(
        "2025-11-05",
        "VIREMENT EMIS WEB SCI LES ATELIERS DU QANNT Loyer bureaux ateliers VAYRAC QANNT",
        -1092
      ),
      transactionBrute(
        "2025-12-05",
        "VIREMENT EMIS WEB SCI LES ATELIERS DU Loyer decembre bureaux atelier Vayrac",
        -1092
      ),
      transactionBrute(
        "2026-01-05",
        "VIREMENT EMIS VIR INST vers SCI LES ATELIERS D Loyer janvier bureaux atelier VAYRAC QANNT",
        -1092
      ),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 1);
    assert.equal(candidats[0].nombreOccurrences, 4);
  });

  test("G. bénéficiaires différents : jamais fusionnés malgré cadence et montant similaires", () => {
    const transactions = [
      transactionBrute("2026-04-28", "VIREMENT EMIS VIR INST vers Louis DHELLEMMES Salaire Avril QANNT", -2500),
      transactionBrute("2026-05-28", "VIREMENT EMIS VIR INST vers Louis DHELLEMMES Salaire Mai QANNT", -2500),
      transactionBrute("2026-06-28", "VIREMENT EMIS VIR INST vers Louis DHELLEMMES Salaire Juin QANNT", -2500),
      transactionBrute("2026-04-29", "VIREMENT EMIS WEB AUDREY MENTZ Salaire Avril QANNT", -2500),
      transactionBrute("2026-05-29", "VIREMENT EMIS WEB AUDREY MENTZ Salaire Mai QANNT", -2500),
      transactionBrute("2026-06-29", "VIREMENT EMIS WEB AUDREY MENTZ Salaire Juin QANNT", -2500),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 2);
    const libelles = candidats.map((c) => c.libellePropose).join(" | ");
    assert.ok(libelles.includes("DHELLEMMES"));
    assert.ok(libelles.includes("MENTZ"));
  });

  test("moins de 3 occurrences : la nouvelle règle de montant ne contourne pas le minimum d'occurrences", () => {
    const transactions = [
      transactionBrute("2026-02-10", "VIREMENT EMIS WEB EDF ENERGIE Facture fevrier", -430),
      transactionBrute("2026-03-10", "VIREMENT EMIS WEB EDF ENERGIE Facture mars", -912),
    ];
    assert.equal(detecterChargesRecurrentes(transactions).length, 0);
  });
});

describe("detecterChargesRecurrentes — retrait du bruit corpus (tag interne inséré de façon incohérente)", () => {
  test("un tag d'entreprise fréquent mais positionné de façon incohérente n'empêche pas le regroupement sur un corpus assez grand", () => {
    // Reproduit un cas réel observé sur un export Pennylane : le tag propre à l'entreprise ("MYCO")
    // apparaît sur beaucoup de ses propres virements sortants, mais à une position incohérente
    // (avant ou après le mot "Salaire", ou absent) — sans retrait par fréquence, les 3 occurrences
    // produiraient 2 signatures différentes et jamais 3 occurrences groupées.
    // Le corpus doit être assez grand pour que la fréquence des tokens d'identité d'Audrey
    // (3 occurrences) reste elle-même bien en dessous du seuil de bruit, sans quoi ce sont eux
    // qu'on retirerait à tort.
    const remplissage: NormalizedBankTransaction[] = Array.from({ length: 50 }, (_, i) =>
      transactionBrute(
        `2026-0${(i % 6) + 1}-${String(10 + (i % 15)).padStart(2, "0")}`,
        i % 5 === 0 ? `VIREMENT EMIS WEB FOURNISSEUR${i} MYCO Facture ponctuelle` : `VIREMENT EMIS WEB FOURNISSEUR${i} Facture ponctuelle`,
        -(10 + i)
      )
    );

    const transactions: NormalizedBankTransaction[] = [
      ...remplissage,
      transactionBrute("2026-01-29", "VIREMENT EMIS WEB AUDREY MENTZ MYCO Salaire Janvier", -1900),
      transactionBrute("2026-02-27", "VIREMENT EMIS WEB AUDREY MENTZ Salaire Fevrier MYCO", -1900),
      transactionBrute("2026-03-30", "VIREMENT EMIS WEB AUDREY MENTZ Salaire Mars", -1900),
    ];

    const candidats = detecterChargesRecurrentes(transactions);
    const salaireAudrey = candidats.find((c) => c.libellePropose.includes("MENTZ"));
    assert.ok(salaireAudrey, "la série de salaire d'Audrey Mentz doit être détectée malgré le tag incohérent");
    assert.equal(salaireAudrey?.nombreOccurrences, 3);
    assert.equal(salaireAudrey?.frequence, "mensuel");
  });
});
