import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { droitsOrganisation, Offre } from "./offres";
import {
  ActionCarte,
  etatCarte,
  formaterPrix,
  joursRestants,
  nouveautesDeLOffre,
  SituationAbonnement,
} from "./offresAbonnement";

function situation(extra: Partial<SituationAbonnement>): SituationAbonnement {
  return { offreActuelle: "essential", essai: null, souscriptionPossible: true, portailDisponible: false, ...extra };
}

function actions(s: SituationAbonnement): Record<Offre, ActionCarte> {
  return {
    essential: etatCarte("essential", s).action,
    forecast: etatCarte("forecast", s).action,
    steering: etatCarte("steering", s).action,
  };
}

function incluses(s: SituationAbonnement): Offre[] {
  return (["essential", "forecast", "steering"] as Offre[]).filter((o) => etatCarte(o, s).incluseDansEssai);
}

describe("contenu des cartes, dérivé de la matrice", () => {
  test("Essentiel : le reporting du module Passé", () => {
    assert.deepEqual(nouveautesDeLOffre("essential"), [
      "Reporting financier à partir des flux bancaires",
      "Analyse des flux de trésorerie",
      "Encaissements, marges et EBITDA",
      "Export PDF du reporting",
    ]);
  });

  test("Prévision : projection, fiabilité, écarts et BFR (ouvert à Prévision)", () => {
    assert.deepEqual(nouveautesDeLOffre("forecast"), [
      "Projection de trésorerie",
      "Fiabilité de la projection",
      "Analyse d'écarts",
      "Analyse du BFR",
    ]);
  });

  test("Pilotage : reporting comptable annoncé, délais de paiement en une ligne ; rien pour le module Action", () => {
    assert.deepEqual(nouveautesDeLOffre("steering"), [
      "Reporting financier à partir des données comptables",
      "Suivi des délais de paiement clients et fournisseurs",
    ]);
  });
});

describe("état des cartes", () => {
  test("Essentiel actif, sans abonnement : Prévision et Pilotage en Checkout, pas de portail", () => {
    const s = situation({});
    assert.deepEqual(actions(s), { essential: "actuelle", forecast: "checkout", steering: "checkout" });
    assert.equal(s.portailDisponible, false);
  });

  test("Prévision souscrite : Pilotage et Essentiel passent par le portail", () => {
    const s = situation({ offreActuelle: "forecast", souscriptionPossible: false, portailDisponible: true });
    assert.deepEqual(actions(s), { essential: "portail", forecast: "actuelle", steering: "portail" });
  });

  test("Pilotage souscrit : les offres inférieures passent par le portail", () => {
    const s = situation({ offreActuelle: "steering", souscriptionPossible: false, portailDisponible: true });
    assert.deepEqual(actions(s), { essential: "portail", forecast: "portail", steering: "actuelle" });
  });

  test("Pilotage attribué par Novanta, sans abonnement : aucune descente proposée", () => {
    const s = situation({ offreActuelle: "steering" });
    assert.deepEqual(actions(s), { essential: "aucune", forecast: "aucune", steering: "actuelle" });
  });

  test("ancien abonnement à prix unique, offre Pilotage : Prévision par le portail, jamais un second Checkout", () => {
    const s = situation({ offreActuelle: "steering", souscriptionPossible: true, portailDisponible: true });
    assert.equal(etatCarte("forecast", s).action, "portail");
  });

  test("accès pas encore ouvert : aucune offre actuelle, Prévision et Pilotage en Checkout", () => {
    const s = situation({ offreActuelle: null });
    assert.deepEqual(actions(s), { essential: "aucune", forecast: "checkout", steering: "checkout" });
  });
});

describe("essai Pilotage", () => {
  const FIN = "2026-11-20T12:00:00.000Z";

  test("depuis Essentiel : Essentiel reste l'offre actuelle, Prévision et Pilotage incluses et souscriptibles", () => {
    const s = situation({ essai: { fin: FIN } });
    assert.deepEqual(actions(s), { essential: "actuelle", forecast: "checkout", steering: "checkout" });
    assert.deepEqual(incluses(s), ["forecast", "steering"]);
  });

  test("avec Prévision souscrite : Prévision actuelle, Pilotage inclus dans l'essai", () => {
    const s = situation({ offreActuelle: "forecast", essai: { fin: FIN }, souscriptionPossible: false, portailDisponible: true });
    assert.equal(etatCarte("forecast", s).action, "actuelle");
    assert.deepEqual(incluses(s), ["steering"]);
  });

  test("expiré : plus d'essai, retour visuel à l'offre permanente sans intervention", () => {
    // Situation calculée comme dans /api/billing/offre : relue à chaque chargement.
    const brute = {
      plan: "forecast",
      plan_override: "steering",
      plan_override_until: FIN,
      subscription_status: "active",
      subscription_current_period_end: "2026-12-02T12:00:00.000Z",
    };
    const pendant = droitsOrganisation(brute, new Date("2026-11-10T00:00:00Z"));
    const apres = droitsOrganisation(brute, new Date("2026-11-21T00:00:00Z"));
    assert.equal(pendant.offreEffective, "steering");
    assert.equal(apres.offreEffective, "forecast");
    assert.equal(apres.overrideActif, false);

    const s = situation({ offreActuelle: apres.offreContractuelle, essai: null, souscriptionPossible: false, portailDisponible: true });
    assert.deepEqual(incluses(s), []);
    assert.equal(etatCarte("forecast", s).action, "actuelle");
  });

  test("jours restants : arrondi au jour entamé, jamais 0, rien sans échéance", () => {
    const maintenant = new Date("2026-11-05T12:00:00Z");
    assert.equal(joursRestants(FIN, maintenant), 15);
    assert.equal(joursRestants("2026-11-05T13:00:00Z", maintenant), 1);
    assert.equal(joursRestants(null, maintenant), null);
    assert.equal(joursRestants("pas une date", maintenant), null);
  });
});

describe("prix", () => {
  test("format français, taxes et période issues de Stripe", () => {
    const prevision = formaterPrix({ montant: 1990, devise: "eur", intervalle: "month", taxes: "HT" });
    assert.equal(prevision.montant.replace(/\s/g, " "), "19,90 €");
    assert.equal(prevision.periode, "/ mois HT");
    const rond = formaterPrix({ montant: 3000, devise: "eur", intervalle: "year", taxes: null });
    assert.equal(rond.montant.replace(/\s/g, " "), "30 €");
    assert.equal(rond.periode, "/ an");
  });
});
