import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detecterChargesRecurrentes, trierCandidatsPourAffichage, RecurringChargeCandidate } from "./bankRecurringDetector";
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
    const libelles = candidats.map((c) => c.libellePropose.toUpperCase()).join(" | ");
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
    // apparaît sur beaucoup de ses propres virements sortants, mais à une position ABSOLUE
    // incohérente d'une occurrence à l'autre (parfois juste après le nom, parfois plus loin, parfois
    // absent) — sans retrait par fréquence+position, les occurrences d'Audrey produiraient 2
    // signatures différentes et ne se regrouperaient jamais.
    // Le corpus doit être assez grand pour que la fréquence des tokens d'identité d'Audrey
    // (3 occurrences) reste elle-même bien en dessous du seuil de bruit, sans quoi ce sont eux
    // qu'on retirerait à tort.
    // Noms de remplissage volontairement alphabétiques (pas de suffixe numérique type
    // "FOURNISSEUR0") pour ne pas déclencher la détection de référence technique
    // (mélange lettres+chiffres) — ce n'est pas ce que ce test vérifie. Le tag "MYCO" est inséré à
    // des positions ABSOLUES différentes selon les lignes (comme dans le fichier réel, où sa position
    // varie selon la longueur du nom du bénéficiaire) : un simple mot toujours en tête (comme
    // "AMAZON" dans un autre test) ne doit jamais être confondu avec ce cas.
    const NOMS_REMPLISSAGE = [
      "ALPHA", "BETA", "GAMMA", "DELTA", "EPSILON", "ZETA", "ETA", "THETA", "IOTA", "KAPPA",
      "LAMBDA", "MU", "NU", "XI", "OMICRON", "RHO", "SIGMA", "TAU", "PHI", "CHI",
      "PSI", "OMEGA", "AXIOME", "BORNE", "CADRE", "DIGNE", "ETOILE", "FIBRE", "GALET", "HAVRE",
      "IMAGE", "JARDIN", "KIOSQUE", "LUEUR", "MARGE", "NOYAU", "PIVOT", "QUARTZ", "RIVAGE", "SOCLE",
      "TRAME", "UNITE", "VOILE", "WAGON", "XENON", "YACHT", "ZEPHYR", "ANCRE", "BRISE", "CORAIL",
    ];
    const remplissage: NormalizedBankTransaction[] = NOMS_REMPLISSAGE.map((nom, i) => {
      const libelle =
        i % 3 === 0
          ? `VIREMENT EMIS WEB FOURNISSEUR${nom} MYCO Facture ponctuelle` // MYCO position 1
          : i % 3 === 1
            ? `VIREMENT EMIS WEB FOURNISSEUR${nom} Reference Facture MYCO ponctuelle` // MYCO position 3
            : `VIREMENT EMIS WEB FOURNISSEUR${nom} Facture ponctuelle`; // sans MYCO
      return transactionBrute(
        `2026-0${(i % 6) + 1}-${String(10 + (i % 15)).padStart(2, "0")}`,
        libelle,
        -(10 + i)
      );
    });

    const transactions: NormalizedBankTransaction[] = [
      ...remplissage,
      transactionBrute("2026-01-29", "VIREMENT EMIS WEB AUDREY MENTZ MYCO Salaire Janvier", -1900),
      transactionBrute("2026-02-27", "VIREMENT EMIS WEB AUDREY MENTZ Salaire Fevrier MYCO", -1900),
      transactionBrute("2026-03-30", "VIREMENT EMIS WEB AUDREY MENTZ Salaire Mars", -1900),
    ];

    const candidats = detecterChargesRecurrentes(transactions);
    const salaireAudrey = candidats.find((c) => c.libellePropose.toUpperCase().includes("MENTZ"));
    assert.ok(salaireAudrey, "la série de salaire d'Audrey Mentz doit être détectée malgré le tag incohérent");
    assert.equal(salaireAudrey?.nombreOccurrences, 3);
    assert.equal(salaireAudrey?.frequence, "mensuel");
  });
});

describe("detecterChargesRecurrentes — libellé proposé (proposedLabel), jamais le libellé bancaire brut", () => {
  test("A. « VIREMENT EMIS VIR INST vers Benjamin HOUVIER Salaire Juillet » → « Salaire Benjamin Houvier »", () => {
    const transactions = [
      transactionBrute("2026-05-28", "VIREMENT EMIS VIR INST vers Benjamin HOUVIER Salaire Mai", -2075),
      transactionBrute("2026-06-28", "VIREMENT EMIS VIR INST vers Benjamin HOUVIER Salaire Juin", -2075),
      transactionBrute("2026-07-28", "VIREMENT EMIS VIR INST vers Benjamin HOUVIER Salaire Juillet", -2075),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 1);
    assert.equal(candidats[0].libellePropose, "Salaire Benjamin Houvier");
  });

  test("B. mai / juin / juillet sur le même bénéficiaire → un seul candidat, un seul libellé", () => {
    const transactions = [
      transactionBrute("2026-05-28", "VIREMENT EMIS VIR INST vers Benjamin HOUVIER Salaire Mai", -2075),
      transactionBrute("2026-06-28", "VIREMENT EMIS VIR INST vers Benjamin HOUVIER Salaire Juin", -2075),
      transactionBrute("2026-07-28", "VIREMENT EMIS VIR INST vers Benjamin HOUVIER Salaire Juillet", -2075),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 1);
    assert.equal(candidats[0].nombreOccurrences, 3);
  });

  test("C. « SCI LES ATELIERS ... Loyer OCTOBRE » → « Loyer SCI Les Ateliers »", () => {
    const transactions = [
      transactionBrute(
        "2025-10-06",
        "VIREMENT EMIS WEB SCI LES ATELIERS DU Loyer OCTOBRE bureaux atelier VAYRAC",
        -1092
      ),
      transactionBrute("2025-11-05", "VIREMENT EMIS WEB SCI LES ATELIERS DU Loyer Juin", -1092),
      transactionBrute(
        "2025-12-05",
        "VIREMENT EMIS VIR INST vers SCI LES ATELIERS D Loyer decembre bureaux atelier Vayrac",
        -1092
      ),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 1);
    assert.equal(candidats[0].libellePropose, "Loyer SCI Les Ateliers");
  });

  test("D. « SAS CELAUR VALLEE Loyer 735,56 » → « Loyer SAS Celaur Vallee »", () => {
    const transactions = [
      transactionBrute("2026-04-03", "VIREMENT EMIS VIR INST vers SAS CELAUR VALLEE Loyer", -735.0),
      transactionBrute("2026-05-05", "VIREMENT EMIS WEB SAS CELAUR VALLEE Loyer Mai", -735.56),
      transactionBrute("2026-06-03", "VIREMENT EMIS VIR INST vers SAS CELAUR VALLEE loyer Juin", -735.56),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 1);
    // Sans restitution d'accent : le libellé bancaire source ("VALLEE") ne comporte déjà aucun
    // accent, et il n'existe pas de règle déterministe fiable pour le réintroduire sans dictionnaire.
    assert.equal(candidats[0].libellePropose, "Loyer SAS Celaur Vallee");
  });

  test("E. « COTISATION Offre Compte Composer Pro Facture N°... » → « Cotisation Offre Compte Composer Pro »", () => {
    const transactions = [
      transactionBrute("2026-01-21", "COTISATION Offre Compte à composer Pro Facture N°2611111111111", -16.5),
      transactionBrute("2026-02-21", "COTISATION Offre Compte à composer Pro Facture N°2622222222222", -29.65),
      transactionBrute("2026-03-21", "COTISATION Offre Compte à composer Pro Facture N°2623300289819", -42.8),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 1);
    assert.equal(candidats[0].libellePropose, "Cotisation Offre Compte Composer Pro");
  });

  test("F. « PRLV SEPA SHOPIFY 928374 » → « Shopify »", () => {
    const transactions = [
      transactionBrute("2026-02-02", "PRLV SEPA SHOPIFY 928374", -39.17),
      transactionBrute("2026-03-02", "PRLV SEPA SHOPIFY 175633", -38.42),
      transactionBrute("2026-04-02", "PRLV SEPA SHOPIFY 002841", -39.03),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 1);
    assert.equal(candidats[0].libellePropose, "Shopify");
  });

  test("G. les numéros de facture différents entre occurrences n'apparaissent jamais dans le libellé proposé", () => {
    const transactions = [
      transactionBrute("2026-01-21", "COTISATION Offre Compte à composer Pro Facture N°2611111111111", -16.5),
      transactionBrute("2026-02-21", "COTISATION Offre Compte à composer Pro Facture N°2622222222222", -29.65),
      transactionBrute("2026-03-21", "COTISATION Offre Compte à composer Pro Facture N°2623300289819", -42.8),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(/\d/.test(candidats[0].libellePropose), false);
  });

  test("H. les mois différents entre occurrences n'apparaissent jamais dans le libellé proposé", () => {
    const transactions = [
      transactionBrute("2026-05-28", "VIREMENT EMIS VIR INST vers Benjamin HOUVIER Salaire Mai", -2075),
      transactionBrute("2026-06-28", "VIREMENT EMIS VIR INST vers Benjamin HOUVIER Salaire Juin", -2075),
      transactionBrute("2026-07-28", "VIREMENT EMIS VIR INST vers Benjamin HOUVIER Salaire Juillet", -2075),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    const libelleMinuscule = candidats[0].libellePropose.toLowerCase();
    for (const mois of ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout"]) {
      assert.equal(libelleMinuscule.includes(mois), false, `« ${mois} » ne doit pas apparaître dans le libellé`);
    }
  });

  test("ne retombe jamais sur le libellé bancaire brut complet (préfixes bancaires absents)", () => {
    const transactions = [
      transactionBrute("2026-05-28", "VIREMENT EMIS VIR INST vers Benjamin HOUVIER Salaire Mai", -2075),
      transactionBrute("2026-06-28", "VIREMENT EMIS VIR INST vers Benjamin HOUVIER Salaire Juin", -2075),
      transactionBrute("2026-07-28", "VIREMENT EMIS VIR INST vers Benjamin HOUVIER Salaire Juillet", -2075),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    for (const motInterdit of ["VIREMENT", "EMIS", "VIR INST", "vers"]) {
      assert.equal(candidats[0].libellePropose.toUpperCase().includes(motInterdit.toUpperCase()), false);
    }
  });
});

describe("detecterChargesRecurrentes — le nom du marchand gagne contre les références techniques", () => {
  test("A/B. cas réel Amazon Business : mêmes références techniques, numéros de commande différents → toujours « Amazon Business »", () => {
    const transactions = [
      transactionBrute(
        "2026-06-30",
        "PRELEVEMENT AMAZON BUSINESS EU SARL-SUCCURSA 407-3171735-8841930 AMZNBusiness 79IFR7Z90BF04BH0 XR:DRDMLLAHUPGRSPYGNPOW+YYNSV0 LU39ZZZ0000000000000002054",
        -84.7
      ),
      transactionBrute(
        "2026-07-31",
        "PRELEVEMENT AMAZON BUSINESS EU SARL-SUCCURSA 407-2682920-5134736 AMZNBusiness 6SI0036K3D5UQ74P XR:DRDMLLAHUPGRSPYGNPOW+YYNSV0 LU39ZZZ0000000000000002054",
        -274.99
      ),
      transactionBrute(
        "2026-08-26",
        "PRELEVEMENT AMAZON BUSINESS EU SARL-SUCCURSA 407-9012345-6789012 AMZNBusiness YP603Z7GQENYFA24 XR:DRDMLLAHUPGRSPYGNPOW+YYNSV0 LU39ZZZ0000000000000002054",
        -62.9
      ),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 1);
    assert.equal(candidats[0].libellePropose, "Amazon Business");
    assert.equal(candidats[0].nombreOccurrences, 3);
  });

  test("C/D/E. aucun résidu technique dans le libellé (XR:, LU...ZZZ..., chaîne alphanumérique longue)", () => {
    const transactions = [
      transactionBrute(
        "2026-06-30",
        "PRELEVEMENT AMAZON BUSINESS EU SARL-SUCCURSA 407-3171735-8841930 AMZNBusiness 79IFR7Z90BF04BH0 XR:DRDMLLAHUPGRSPYGNPOW+YYNSV0 LU39ZZZ0000000000000002054",
        -84.7
      ),
      transactionBrute(
        "2026-07-31",
        "PRELEVEMENT AMAZON BUSINESS EU SARL-SUCCURSA 407-2682920-5134736 AMZNBusiness 6SI0036K3D5UQ74P XR:DRDMLLAHUPGRSPYGNPOW+YYNSV0 LU39ZZZ0000000000000002054",
        -274.99
      ),
      transactionBrute(
        "2026-08-26",
        "PRELEVEMENT AMAZON BUSINESS EU SARL-SUCCURSA 407-9012345-6789012 AMZNBusiness YP603Z7GQENYFA24 XR:DRDMLLAHUPGRSPYGNPOW+YYNSV0 LU39ZZZ0000000000000002054",
        -62.9
      ),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    const libelle = candidats[0].libellePropose;
    assert.equal(/\d/.test(libelle), false); // aucun numéro de commande / IBAN-like
    assert.equal(libelle.toUpperCase().includes("XR"), false); // marqueur de routage retiré
    assert.equal(libelle.toUpperCase().includes("LU39ZZZ"), false); // identifiant IBAN-like retiré
    assert.equal(libelle.toUpperCase().includes("DRDMLLAHUPGRSPYGNPOW"), false); // chaîne technique retirée
  });

  test("F. si le seul contenu restant est technique, ne jamais le proposer comme libellé (repli neutre)", () => {
    // Simule un labelNormalized resté entièrement technique — garde-fou défensif : dans le cas réel,
    // la normalisation partagée (bankTransaction.ts) retire déjà ces tokens en amont, mais ce test
    // vérifie explicitement que le détecteur ne proposerait jamais une chaîne technique en dernier
    // recours, quelle qu'en soit la cause.
    const transactions = [
      transaction("2026-02-05", "6SI0036K3D5UQ74P LU39ZZZ0000000000000002054", -84.7),
      transaction("2026-03-05", "6SI0036K3D5UQ74P LU39ZZZ0000000000000002054", -84.7),
      transaction("2026-04-05", "6SI0036K3D5UQ74P LU39ZZZ0000000000000002054", -84.7),
    ];
    const candidats = detecterChargesRecurrentes(transactions);
    assert.equal(candidats.length, 1);
    assert.equal(candidats[0].libellePropose, "Charge récurrente à nommer");
  });
});

describe("trierCandidatsPourAffichage — tri purement visuel de l'écran de validation", () => {
  function candidat(libellePropose: string, montantPropose: number): RecurringChargeCandidate {
    return {
      id: libellePropose,
      libellePropose,
      montantPropose,
      profilMontant: "stable",
      frequence: "mensuel",
      derniereOccurrence: "2026-08-01",
      prochaineOccurrenceEstimee: "2026-09-01",
      nombreOccurrences: 3,
      montantMin: montantPropose,
      montantMax: montantPropose,
      occurrences: [],
    };
  }

  test("trie par montant proposé décroissant", () => {
    const candidats = [candidat("Shopify", 39), candidat("Loyer", 1092), candidat("OpenAI", 17)];
    const trie = trierCandidatsPourAffichage(candidats);
    assert.deepEqual(
      trie.map((c) => c.libellePropose),
      ["Loyer", "Shopify", "OpenAI"]
    );
  });

  test("à égalité de montant, trie par libellé par ordre alphabétique", () => {
    const candidats = [candidat("Zeta Fournitures", 100), candidat("Alpha Telecom", 100)];
    const trie = trierCandidatsPourAffichage(candidats);
    assert.deepEqual(
      trie.map((c) => c.libellePropose),
      ["Alpha Telecom", "Zeta Fournitures"]
    );
  });

  test("reproduit exactement l'exemple de la spec produit", () => {
    const candidats = [
      candidat("Shopify", 39),
      candidat("Pennylane", 58.8),
      candidat("Loyer SAS Celaur Vallée", 735),
      candidat("OpenAI", 17),
      candidat("Loyer", 1092),
    ];
    const trie = trierCandidatsPourAffichage(candidats);
    assert.deepEqual(
      trie.map((c) => c.libellePropose),
      ["Loyer", "Loyer SAS Celaur Vallée", "Pennylane", "Shopify", "OpenAI"]
    );
  });

  test("ne mute jamais le tableau reçu en entrée", () => {
    const candidats = [candidat("Shopify", 39), candidat("Loyer", 1092)];
    const original = [...candidats];
    trierCandidatsPourAffichage(candidats);
    assert.deepEqual(candidats, original);
  });

  test("n'affecte pas l'ordre interne du moteur de détection (nombreOccurrences)", () => {
    // Le moteur trie par nombre d'occurrences ; ce test vérifie que detecterChargesRecurrentes
    // n'est pas modifié et garde son propre ordre, indépendamment du tri d'affichage.
    const transactions = [
      transactionBrute("2026-05-05", "PRLV NETFLIX PREMIUM", -1000),
      transactionBrute("2026-06-05", "PRLV NETFLIX PREMIUM", -1000),
      transactionBrute("2026-07-05", "PRLV NETFLIX PREMIUM", -1000),
      transactionBrute("2026-08-05", "PRLV NETFLIX PREMIUM", -1000),
      transactionBrute("2026-02-05", "PRLV BUREAU CENTRAL", -5000),
      transactionBrute("2026-03-05", "PRLV BUREAU CENTRAL", -5000),
      transactionBrute("2026-04-05", "PRLV BUREAU CENTRAL", -5000),
    ];
    const candidatsMoteur = detecterChargesRecurrentes(transactions);
    // Le moteur trie par occurrences décroissantes : 4 occurrences (Netflix) avant 3 (Bureau
    // Central), malgré son montant plus faible.
    assert.equal(candidatsMoteur[0].libellePropose, "Netflix Premium");

    const pourAffichage = trierCandidatsPourAffichage(candidatsMoteur);
    // À l'affichage : le montant le plus élevé (Bureau Central, 5000€) passe en premier.
    assert.equal(pourAffichage[0].libellePropose, "Bureau Central");
  });
});
