import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { ErreurImportBancaire, analyserFichierBancaireXlsx, analyserGrilleBancaire } from "./bankXlsxAdapter";

describe("analyserGrilleBancaire — structures reconnues", () => {
  test("Format A : montant signé unique", () => {
    const grille = [
      ["Date", "Libellé", "Montant"],
      ["02/08/2026", "Shopify", "-39,17"],
      ["05/08/2026", "Client X", "2500,00"],
      ["10/08/2026", "Shopify", "-40,10"],
      ["12/08/2026", "OVH", "-128,00"],
    ];
    const resultat = analyserGrilleBancaire(grille);
    assert.equal(resultat.transactions.length, 4);
    assert.equal(resultat.transactions[0].signedAmount, -39.17);
    assert.equal(resultat.transactions[1].signedAmount, 2500);
  });

  test("Format B : colonnes Débit / Crédit séparées", () => {
    const grille = [
      ["Date", "Libellé", "Débit", "Crédit"],
      ["02/08/2026", "Shopify", "39,17", ""],
      ["05/08/2026", "Client X", "", "2500,00"],
    ];
    const resultat = analyserGrilleBancaire(grille);
    assert.equal(resultat.transactions.length, 2);
    assert.equal(resultat.transactions[0].signedAmount, -39.17);
    assert.equal(resultat.transactions[1].signedAmount, 2500);
  });

  test("lignes de titre avant l'en-tête : ignorées, l'en-tête est trouvé plus bas", () => {
    const grille = [
      ["Relevé de compte"],
      ["Compte n°12345 — Août 2026"],
      [],
      ["Date opération", "Description", "Montant"],
      ["02/08/2026", "Shopify", "-39,17"],
      ["05/08/2026", "Client X", "2500,00"],
      ["10/08/2026", "OVH", "-128,00"],
    ];
    const resultat = analyserGrilleBancaire(grille);
    assert.equal(resultat.transactions.length, 3);
    assert.equal(resultat.colonneDate, "Date opération");
    assert.equal(resultat.colonneLibelle, "Description");
  });

  test("colonnes inutiles : ignorées automatiquement, sans mapping manuel", () => {
    const grille = [
      ["N° pièce", "Date", "Catégorie", "Libellé", "Devise", "Montant", "Solde"],
      ["1", "02/08/2026", "Abonnement", "Shopify", "EUR", "-39,17", "10000"],
      ["2", "05/08/2026", "Vente", "Client X", "EUR", "2500,00", "12500"],
    ];
    const resultat = analyserGrilleBancaire(grille);
    assert.equal(resultat.transactions.length, 2);
  });

  test("alias de colonne date reconnu (Date d'opération)", () => {
    const grille = [
      ["Date d'opération", "Libellé", "Montant"],
      ["02/08/2026", "Shopify", "-39,17"],
      ["05/08/2026", "Client X", "2500,00"],
    ];
    const resultat = analyserGrilleBancaire(grille);
    assert.equal(resultat.transactions.length, 2);
  });

  test("alias de colonne libellé reconnu (Intitulé)", () => {
    const grille = [
      ["Date", "Intitulé", "Montant"],
      ["02/08/2026", "Shopify", "-39,17"],
      ["05/08/2026", "Client X", "2500,00"],
    ];
    const resultat = analyserGrilleBancaire(grille);
    assert.equal(resultat.transactions.length, 2);
  });

  test("quelques lignes invalides sont ignorées sans bloquer les lignes valides (Cas B)", () => {
    const grille = [
      ["Date", "Libellé", "Montant"],
      ["02/08/2026", "Shopify", "-39,17"],
      ["date-cassee", "OVH", "-128,00"],
      ["10/08/2026", "Adobe", "n a pas de sens"],
      ["12/08/2026", "Client X", "2500,00"],
    ];
    const resultat = analyserGrilleBancaire(grille);
    assert.equal(resultat.transactions.length, 2);
    assert.equal(resultat.lignesIgnorees, 2);
    assert.ok(resultat.raisonsIgnorees.some((r) => r.includes("date")));
    assert.ok(resultat.raisonsIgnorees.some((r) => r.includes("montant")));
  });
});

describe("analyserGrilleBancaire — cas bloquants (diagnostic actionnable)", () => {
  test("colonne date introuvable", () => {
    const grille = [
      ["Libellé", "Montant"],
      ["Shopify", "-39,17"],
    ];
    assert.throws(
      () => analyserGrilleBancaire(grille),
      (err: unknown) => err instanceof ErreurImportBancaire && err.diagnostic?.date.ok === false
    );
  });

  test("colonne libellé introuvable", () => {
    const grille = [
      ["Date", "Montant"],
      ["02/08/2026", "-39,17"],
    ];
    assert.throws(
      () => analyserGrilleBancaire(grille),
      (err: unknown) => err instanceof ErreurImportBancaire && err.diagnostic?.libelle.ok === false
    );
  });

  test("ni Montant ni Débit/Crédit", () => {
    const grille = [
      ["Date", "Libellé"],
      ["02/08/2026", "Shopify"],
    ];
    assert.throws(
      () => analyserGrilleBancaire(grille),
      (err: unknown) => err instanceof ErreurImportBancaire && err.diagnostic?.montant.ok === false
    );
  });

  test("structure ambiguë : Montant ET Débit/Crédit tous présents", () => {
    const grille = [
      ["Date", "Libellé", "Montant", "Débit", "Crédit"],
      ["02/08/2026", "Shopify", "-39,17", "39,17", ""],
    ];
    assert.throws(() => analyserGrilleBancaire(grille), ErreurImportBancaire);
  });

  test("sens ambigu : colonne Montant unique mais uniquement des valeurs positives", () => {
    const grille = [
      ["Date", "Libellé", "Montant"],
      ["02/08/2026", "Shopify", "39,17"],
      ["05/08/2026", "OVH", "128,00"],
      ["10/08/2026", "Adobe", "72,00"],
    ];
    assert.throws(() => analyserGrilleBancaire(grille), ErreurImportBancaire);
  });

  test("montants ambigus sur toute la colonne : bloqué", () => {
    const grille = [
      ["Date", "Libellé", "Montant"],
      ["02/08/2026", "Shopify", "1,200"],
      ["05/08/2026", "OVH", "2,300"],
    ];
    assert.throws(() => analyserGrilleBancaire(grille), ErreurImportBancaire);
  });

  test("aucune ligne de données", () => {
    const grille = [["Date", "Libellé", "Montant"]];
    assert.throws(() => analyserGrilleBancaire(grille), ErreurImportBancaire);
  });
});

describe("analyserFichierBancaireXlsx", () => {
  function fichierXlsxDepuisGrille(grille: unknown[][], nom = "releve.xlsx"): File {
    const feuille = XLSX.utils.aoa_to_sheet(grille);
    const classeur = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(classeur, feuille, "Relevé");
    const contenu = XLSX.write(classeur, { bookType: "xlsx", type: "array" });
    return new File([contenu], nom, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  test("rejette un fichier qui n'a pas l'extension .xlsx", async () => {
    const fichier = new File(["contenu"], "releve.csv", { type: "text/csv" });
    await assert.rejects(() => analyserFichierBancaireXlsx(fichier), ErreurImportBancaire);
  });

  test("analyse un vrai fichier .xlsx de bout en bout", async () => {
    const grille = [
      ["Date opération", "Description", "Montant"],
      ["02/08/2026", "Shopify", "-39,17"],
      ["05/08/2026", "Client X", "2500,00"],
    ];
    const fichier = fichierXlsxDepuisGrille(grille);
    const resultat = await analyserFichierBancaireXlsx(fichier);
    assert.equal(resultat.transactions.length, 2);
    assert.equal(resultat.periode?.debut, "2026-08-02");
    assert.equal(resultat.periode?.fin, "2026-08-05");
  });
});
