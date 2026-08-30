import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normaliserLibelleBancaire } from "./bankTransaction";

describe("normaliserLibelleBancaire", () => {
  test("regroupe des variantes du même prélèvement avec référence technique variable", () => {
    const a = normaliserLibelleBancaire("PRLV SEPA ADOBE SYSTEMS IRELAND 8J2K39");
    const b = normaliserLibelleBancaire("PRLV SEPA ADOBE SYSTEMS IRELAND KJ29DK");
    const c = normaliserLibelleBancaire("PRLV SEPA ADOBE SYSTEMS IRELAND 92JD03");
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(a, "ADOBE SYSTEMS IRELAND");
  });

  test("insensible à la casse et aux accents", () => {
    assert.equal(normaliserLibelleBancaire("Électricité Générale"), normaliserLibelleBancaire("ELECTRICITE GENERALE"));
  });

  test("ne fusionne pas deux fournisseurs différents", () => {
    assert.notEqual(normaliserLibelleBancaire("NETFLIX.COM"), normaliserLibelleBancaire("SPOTIFY AB"));
  });

  test("ne retire pas un mot final qui n'est pas une référence technique plausible", () => {
    // "PARIS" est un mot, pas un mélange lettres+chiffres ni un long nombre : jamais retiré.
    assert.equal(normaliserLibelleBancaire("LOYER BUREAU PARIS"), "LOYER BUREAU PARIS");
  });

  test("chaîne vide reste vide", () => {
    assert.equal(normaliserLibelleBancaire(""), "");
  });

  test('retire le préfixe structurel "VIREMENT EMIS WEB"', () => {
    assert.equal(normaliserLibelleBancaire("VIREMENT EMIS WEB SCI LES ATELIERS Loyer"), "SCI LES ATELIERS LOYER");
  });

  test('retire le préfixe structurel "VIREMENT EMIS VIR INST vers"', () => {
    assert.equal(
      normaliserLibelleBancaire("VIREMENT EMIS VIR INST vers SCI LES ATELIERS Loyer"),
      "SCI LES ATELIERS LOYER"
    );
  });

  test("les deux formulations de virement produisent la même signature", () => {
    const a = normaliserLibelleBancaire("VIREMENT EMIS WEB SCI LES ATELIERS DU Loyer OCTOBRE bureaux atelier VAYRAC");
    const b = normaliserLibelleBancaire("VIREMENT EMIS VIR INST vers SCI LES ATELIERS D LOYER bureaux atelier VAYRAC");
    // Les deux commencent par les 3 mêmes tokens d'identité une fois le préfixe et le mois retirés.
    assert.equal(a.split(" ").slice(0, 3).join(" "), b.split(" ").slice(0, 3).join(" "));
    assert.equal(a.split(" ").slice(0, 3).join(" "), "SCI LES ATELIERS");
  });

  test("retire un mois en toutes lettres au milieu du libellé", () => {
    assert.equal(normaliserLibelleBancaire("Louis DHELLEMMES Salaire Juillet"), "LOUIS DHELLEMMES SALAIRE");
    assert.equal(normaliserLibelleBancaire("Louis DHELLEMMES Salaire Juin"), "LOUIS DHELLEMMES SALAIRE");
  });

  test("retire une année à 4 chiffres isolée", () => {
    assert.equal(normaliserLibelleBancaire("ABONNEMENT REVUE 2026"), "ABONNEMENT REVUE");
  });

  test("retire la civilité générique M./Mme et conserve le nom", () => {
    assert.equal(normaliserLibelleBancaire("VIREMENT EMIS WEB M. ou Mme LECOCQ Remboursement"), "LECOCQ REMBOURSEMENT");
  });

  test("retire le numéro de carte après PAIEMENT PAR CARTE", () => {
    // Le plafonnage à N tokens d'identité se fait dans le détecteur, pas ici : la normalisation
    // seule retire uniquement le préfixe structurel et le numéro de carte, rien d'autre.
    assert.equal(normaliserLibelleBancaire("PAIEMENT PAR CARTE X1361 CHRONOPOST Paris 26/08"), "CHRONOPOST PARIS 26 08");
  });

  test("retire un token structurel répété au milieu du libellé, pas seulement en tête", () => {
    // Cas réel Pennylane : "virement"/"VIREMENT" réapparaît deux fois, dont une fois au milieu de
    // la description elle-même — les deux occurrences doivent disparaître, pas seulement la tête.
    assert.equal(
      normaliserLibelleBancaire("PRELEVEMENT Frais virement SEPA Instantane VIREMENT DE 7620 euros"),
      "FRAIS INSTANTANE 7620 EUROS"
    );
  });

  test("retire le connecteur générique « à » sans toucher à « les » (peut faire partie d'une raison sociale)", () => {
    assert.equal(normaliserLibelleBancaire("Offre Compte à composer Pro"), "OFFRE COMPTE COMPOSER PRO");
    assert.equal(normaliserLibelleBancaire("SCI LES ATELIERS"), "SCI LES ATELIERS");
  });

  test('retire "Facture N°..." et un numéro de facture nu', () => {
    assert.equal(
      normaliserLibelleBancaire("COTISATION Offre Compte Composer Pro Facture N°2623300289819"),
      "COTISATION OFFRE COMPTE COMPOSER PRO"
    );
    assert.equal(normaliserLibelleBancaire("SAS VISSERIE SERVICE facture facture 842"), "SAS VISSERIE SERVICE");
  });
});
