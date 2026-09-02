import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normaliserLibelleBancaire, ressembleReferenceTechnique } from "./bankTransaction";

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

  test("retire une date numérique JJ/MM en fin de libellé (cas réel : paiement carte quotidien)", () => {
    // Le nom de ville ("NANTES") n'est pas retiré ici : c'est le rôle du bruit corpus, calculé par
    // le détecteur sur l'ensemble des transactions, pas de la normalisation d'un libellé isolé.
    assert.equal(normaliserLibelleBancaire("SIDRAS BAR NANTES 27/08"), "SIDRAS BAR NANTES");
  });

  test("retire une date numérique JJ/MM/AAAA", () => {
    assert.equal(normaliserLibelleBancaire("ABONNEMENT REVUE 05/03/2026"), "ABONNEMENT REVUE");
  });

  test("ne retire pas deux nombres isolés qui n'ont pas la forme JJ/MM (pas de slash entre eux)", () => {
    assert.equal(normaliserLibelleBancaire("BOUTIQUE ABC 27 08"), "BOUTIQUE ABC 27 08");
  });

  test("retire la civilité générique M./Mme et conserve le nom", () => {
    assert.equal(normaliserLibelleBancaire("VIREMENT EMIS WEB M. ou Mme LECOCQ Remboursement"), "LECOCQ REMBOURSEMENT");
  });

  test("retire le numéro de carte après PAIEMENT PAR CARTE, et la date JJ/MM de fin de libellé", () => {
    // Le plafonnage à N tokens d'identité se fait dans le détecteur, pas ici : la normalisation
    // retire le préfixe structurel, le numéro de carte, et la date JJ/MM (format très courant en
    // fin de libellé de paiement carte — sans ce retrait, un même commerçant se fragmenterait en
    // un groupe différent par jour de paiement, voir retirerDatesNumeriques).
    assert.equal(normaliserLibelleBancaire("PAIEMENT PAR CARTE X1361 CHRONOPOST Paris 26/08"), "CHRONOPOST PARIS");
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

  test("retire une référence multi-blocs (numéro de commande type 407-2682920-5134736)", () => {
    assert.equal(
      normaliserLibelleBancaire("AMAZON BUSINESS 407-2682920-5134736 EQUIPEMENT"),
      "AMAZON BUSINESS EQUIPEMENT"
    );
  });

  test("retire le marqueur de routage « XR: » et le code qui suit", () => {
    assert.equal(
      normaliserLibelleBancaire("AMAZON BUSINESS XR:DRDMLLAHUPGRSPYGNPOW+YYNSV0"),
      "AMAZON BUSINESS"
    );
  });

  test("retire un identifiant IBAN-like « LU39ZZZ... »", () => {
    assert.equal(
      normaliserLibelleBancaire("AMAZON BUSINESS LU39ZZZ0000000000000002054"),
      "AMAZON BUSINESS"
    );
  });

  test("retire une longue chaîne alphanumérique technique", () => {
    assert.equal(normaliserLibelleBancaire("AMAZON BUSINESS 6SI0036K3D5UQ74P"), "AMAZON BUSINESS");
  });

  test("retire les qualificatifs génériques EU/Succursale une fois la marque déjà identifiée", () => {
    assert.equal(normaliserLibelleBancaire("AMAZON BUSINESS EU SARL-SUCCURSA"), "AMAZON BUSINESS SARL");
  });

  test("cas réel complet : PRELEVEMENT AMAZON BUSINESS EU SARL-SUCCURSA ... → plus aucun résidu technique", () => {
    // Le retrait de "SARL" en position tardive (le nom de marque étant déjà identifiable avant lui)
    // est géré au niveau du libellé métier proposé (bankRecurringDetector.ts), pas ici : cette
    // fonction ne garantit que l'absence de toute référence technique — vérifié ci-dessous.
    const resultat = normaliserLibelleBancaire(
      "PRELEVEMENT AMAZON BUSINESS EU SARL-SUCCURSA 407-2682920-5134736 AMZNBusiness 6SI0036K3D5UQ74P XR:DRDMLLAHUPGRSPYGNPOW+YYNSV0 LU39ZZZ0000000000000002054"
    );
    assert.equal(resultat, "AMAZON BUSINESS SARL AMZNBUSINESS");
    // Aucun résidu technique : ni référence de commande, ni marqueur de routage, ni identifiant IBAN-like.
    assert.equal(/\d/.test(resultat), false);
  });

  describe("ressembleReferenceTechnique", () => {
    test("mélange lettres/chiffres assez long -> technique", () => {
      assert.equal(ressembleReferenceTechnique("6SI0036K3D5UQ74P"), true);
      assert.equal(ressembleReferenceTechnique("YYNSV0"), true);
    });

    test("nombre pur assez long -> technique", () => {
      assert.equal(ressembleReferenceTechnique("0000000000000002054"), true);
    });

    test("lettres pures avec très peu de voyelles -> technique (code de routage)", () => {
      assert.equal(ressembleReferenceTechnique("DRDMLLAHUPGRSPYGNPOW"), true);
    });

    test("mot réel, même long -> jamais technique", () => {
      assert.equal(ressembleReferenceTechnique("INTERNATIONAL"), false);
      assert.equal(ressembleReferenceTechnique("TELECOMMUNICATIONS"), false);
      assert.equal(ressembleReferenceTechnique("AMZNBUSINESS"), false);
    });

    test("token court -> jamais technique", () => {
      assert.equal(ressembleReferenceTechnique("PARIS"), false);
      assert.equal(ressembleReferenceTechnique("SARL"), false);
    });
  });
});
