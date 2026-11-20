import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calculerProjectionCash, listerFluxProjetes } from "./cash-engine";
import { calculerSyntheseMensuelle } from "./syntheseMensuelle";
import { calculerControleMensuel } from "./controleMensuel";
import { calculerFluxPeriode } from "./periodeFiltre";
import { construireReference } from "./fiabiliteProjection";
import { CORRESPONDANCE_VIDE } from "./futurPnl";
import { filtrerFacturesPrevisionnelles } from "./recherche";
import {
  annulerRapprochement,
  clientsProches,
  deplacerRapprochements,
  estPrevisionnelleActive,
  FacturePrevisionnelle,
  facturesRapprochables,
  ignorerFacture,
  libelleStatut,
  previsionnellesARattacher,
  proposerRapprochementsPrevisionnelles,
  rapprocher,
  statutPrevisionnelle,
} from "./facturesPrevisionnelles";
import { FactureClient } from "./types";

/**
 * Factures prévisionnelles : une prévisionnelle « À facturer » compte à sa date d'encaissement
 * prévue ; rapprochée d'une vraie facture, elle ne compte plus nulle part (courbe, KPIs, point bas,
 * synthèse, contrôle mensuel, filtre de période, prévision de référence), quel que soit ensuite le
 * statut de la vraie facture. Aucune neutralisation sans décision explicite de l'utilisateur.
 */

const DEBUT = "2026-11-18";
const HORIZON = 90; // jusqu'au 16/02/2027
const SOLDE = 100_000;
const MAINTENANT = new Date(2026, 10, 18, 12, 0, 0);

function prevision(overrides: Partial<FacturePrevisionnelle> = {}): FacturePrevisionnelle {
  return {
    id: "prev-acme",
    client: "ACME",
    montant: 20_000,
    dateFacturationPrevue: "2026-12-01",
    dateEncaissementPrevue: "2026-12-31",
    rapprochement: null,
    facturesIgnorees: [],
    ...overrides,
  };
}

function factureClient(overrides: Partial<FactureClient> = {}): FactureClient {
  return {
    id: "fc-123",
    facture: "FAC-2026-123",
    client: "ACME SAS",
    montant: 19_850,
    dateEcheance: "2026-12-30",
    dateEncaissementAnticipee: "2026-12-30",
    litigieuse: false,
    payee: false,
    paidAt: null,
    pennylaneId: "pl-123",
    ...overrides,
  };
}

const VIDES = { facturesFournisseurs: [], chargesFixes: [], autresDepenses: [], financements: [], rentreesRegulieres: [] };

function donnees(facturesPrevisionnelles: FacturePrevisionnelle[], facturesClients: FactureClient[] = []) {
  return { ...VIDES, facturesClients, facturesPrevisionnelles };
}

function projeter(facturesPrevisionnelles: FacturePrevisionnelle[], facturesClients: FactureClient[] = []) {
  return calculerProjectionCash({ ...donnees(facturesPrevisionnelles, facturesClients), soldeInitial: SOLDE, dateDepart: DEBUT, horizonJours: HORIZON });
}

function soldeLe(serie: { date: string; solde: number }[], date: string): number {
  const point = serie.find((p) => p.date === date);
  assert.ok(point, `pas de point au ${date}`);
  return point.solde;
}

function entreesSynthese(facturesPrevisionnelles: FacturePrevisionnelle[], facturesClients: FactureClient[] = []) {
  const synthese = calculerSyntheseMensuelle({ ...donnees(facturesPrevisionnelles, facturesClients), dateReleve: DEBUT, horizonJours: HORIZON });
  const ligne = (libelle: string) => synthese.lignes.find((l) => l.libelle === libelle)!;
  return { previsionnelles: ligne("Factures prévisionnelles"), clients: ligne("Factures clients"), mois: synthese.mois };
}

/** Tous les consommateurs du moteur, comparés au même total attendu (test J). */
function verifierCoherence(facturesPrevisionnelles: FacturePrevisionnelle[], facturesClients: FactureClient[], entreesAttendues: number) {
  const resultat = projeter(facturesPrevisionnelles, facturesClients);
  // Moteur : courbe et KPIs.
  assert.equal(resultat.soldeJ90, SOLDE + entreesAttendues, "KPI solde fin d'horizon");
  assert.equal(resultat.serie[resultat.serie.length - 1].solde, SOLDE + entreesAttendues, "courbe");
  assert.equal(resultat.pointBas, SOLDE, "point bas : aucune sortie, le solde initial");
  // Flux unitaires (base de la prévision de référence).
  const flux = listerFluxProjetes({ ...donnees(facturesPrevisionnelles, facturesClients), dateDepart: DEBUT, horizonJours: HORIZON });
  assert.equal(flux.reduce((s, f) => s + f.montant, 0), entreesAttendues, "flux du moteur");
  // Synthèse mensuelle.
  const synthese = calculerSyntheseMensuelle({ ...donnees(facturesPrevisionnelles, facturesClients), dateReleve: DEBUT, horizonJours: HORIZON });
  assert.equal(synthese.lignes.reduce((s, l) => s + l.total, 0), entreesAttendues, "synthèse mensuelle");
  // Filtre de période (clic sur la courbe) sur tout l'horizon.
  const periode = calculerFluxPeriode({ ...donnees(facturesPrevisionnelles, facturesClients), debut: DEBUT, fin: "2027-02-16", dateDepart: DEBUT });
  assert.equal(periode.resume.entrees, entreesAttendues, "filtre de période");
  // Prévision de référence (fiabilité de la projection), période de décembre.
  const reference = construireReference(
    donnees(facturesPrevisionnelles, facturesClients),
    { type: "month", debut: "2026-12-01", fin: "2026-12-31" } as Parameters<typeof construireReference>[1],
    CORRESPONDANCE_VIDE
  );
  assert.equal(reference.totaux.encaissements, entreesAttendues, "prévision de référence");
}

describe("Factures prévisionnelles — projection", () => {
  test("A. Prévisionnelle active 20 000 € au 31/12 → +20 000 € le 31/12, et seulement à cette date", () => {
    const { serie } = projeter([prevision()]);
    assert.equal(soldeLe(serie, "2026-12-30"), SOLDE);
    assert.equal(soldeLe(serie, "2026-12-31"), SOLDE + 20_000);
    const flux = listerFluxProjetes({ ...donnees([prevision()]), dateDepart: DEBUT, horizonJours: HORIZON });
    assert.deepEqual(
      flux.map((f) => ({ source: f.source, date: f.date, montant: f.montant })),
      [{ source: "facture_previsionnelle", date: "2026-12-31", montant: 20_000 }]
    );
    // La date de facturation prévue est informative : elle ne crée aucun flux.
    assert.equal(soldeLe(serie, "2026-12-01"), SOLDE);
  });

  test("A bis. Sans date d'encaissement prévue : aucune entrée (jamais de repli silencieux sur la facturation)", () => {
    const { soldeJ90 } = projeter([prevision({ dateEncaissementPrevue: "" })]);
    assert.equal(soldeJ90, SOLDE);
  });

  test("B. Prévisionnelle active + vraie facture non rapprochée : deux objets distincts, tous deux comptés", () => {
    const prev = prevision();
    const facture = factureClient();
    assert.equal(statutPrevisionnelle(prev), "a_facturer");
    const flux = listerFluxProjetes({ ...donnees([prev], [facture]), dateDepart: DEBUT, horizonJours: HORIZON });
    assert.deepEqual(flux.map((f) => [f.source, f.sourceId, f.montant]).sort(), [
      ["facture_client", "fc-123", 19_850],
      ["facture_previsionnelle", "prev-acme", 20_000],
    ]);
    // Le risque de double compte existe tant que l'utilisateur n'a pas rapproché : 39 850 €.
    assert.equal(projeter([prev], [facture]).soldeJ90, SOLDE + 39_850);
  });

  test("C. Après rapprochement : seule la vraie facture compte ; la prévisionnelle reste conservée", () => {
    const facture = factureClient();
    const prev = rapprocher(prevision(), facture, MAINTENANT);
    assert.equal(estPrevisionnelleActive(prev), false);
    assert.equal(statutPrevisionnelle(prev), "facturee");
    assert.equal(prev.client, "ACME", "identité de la prévisionnelle préservée");
    assert.equal(prev.montant, 20_000);
    assert.deepEqual(prev.rapprochement, {
      factureClientId: "fc-123",
      factureNumero: "FAC-2026-123",
      facturePennylaneId: "pl-123",
      montantFacture: 19_850,
      rapprocheLe: MAINTENANT.toISOString(),
    });
    assert.equal(libelleStatut(prev, [facture]), "Facturée — FAC-2026-123");
    const flux = listerFluxProjetes({ ...donnees([prev], [facture]), dateDepart: DEBUT, horizonJours: HORIZON });
    assert.deepEqual(flux.map((f) => f.source), ["facture_client"]);
  });

  test("D. Prévisionnelle 20 000 € + vraie facture 19 850 € → après rapprochement 19 850 €, jamais 39 850 €", () => {
    const facture = factureClient();
    assert.equal(projeter([prevision()], [facture]).soldeJ90, SOLDE + 39_850, "avant");
    assert.equal(projeter([rapprocher(prevision(), facture)], [facture]).soldeJ90, SOLDE + 19_850, "après");
  });

  test("E. La vraie facture rapprochée devient Payée : elle sort, la prévisionnelle ne réapparaît pas", () => {
    const facture = factureClient();
    const prev = rapprocher(prevision(), facture);
    const payee = { ...facture, payee: true, paidAt: MAINTENANT.toISOString() };
    assert.equal(projeter([prev], [payee]).soldeJ90, SOLDE);
    assert.equal(estPrevisionnelleActive(prev), false);
    // Même chose si la vraie facture est Litigieuse, modifiée, ou supprimée de Novanta.
    assert.equal(projeter([prev], [{ ...facture, litigieuse: true }]).soldeJ90, SOLDE);
    assert.equal(projeter([prev], [{ ...facture, montant: 18_000 }]).soldeJ90, SOLDE + 18_000);
    const supprimee = { ...prev, rapprochement: { ...prev.rapprochement!, factureClientId: null } };
    assert.equal(projeter([supprimee], []).soldeJ90, SOLDE);
    assert.equal(libelleStatut(supprimee, []), "Facturée — FAC-2026-123 (facture supprimée)");
  });

  test("F. Annulation volontaire : la prévisionnelle redevient À facturer et compte de nouveau ; la vraie facture est inchangée", () => {
    const facture = factureClient();
    const avant = structuredClone(facture);
    const annulee = annulerRapprochement(rapprocher(prevision(), facture));
    assert.equal(statutPrevisionnelle(annulee), "a_facturer");
    assert.equal(projeter([annulee], [facture]).soldeJ90, SOLDE + 39_850);
    assert.deepEqual(facture, avant);
  });
});

describe("Factures prévisionnelles — suggestions après synchronisation Pennylane", () => {
  test("G. Nouvelle facture Pennylane proche d'une prévisionnelle → une suggestion, rien de neutralisé", () => {
    const prev = prevision();
    const suggestions = proposerRapprochementsPrevisionnelles([prev], [factureClient()]);
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].factureClientId, "fc-123");
    assert.deepEqual(suggestions[0].candidats.map((c) => c.previsionnelleId), ["prev-acme"]);
    assert.equal(suggestions[0].candidats[0].ecartJours, 1);
    // Proposer ne modifie rien : la prévisionnelle est toujours active.
    assert.equal(estPrevisionnelleActive(prev), true);
  });

  test("G bis. Signaux : client (forme juridique, accents, casse), montant à 10 %, date à 45 jours", () => {
    assert.equal(clientsProches("ACME", "Acme S.A.S."), true);
    assert.equal(clientsProches("Société Générale", "SOCIETE GENERALE SA"), true);
    assert.equal(clientsProches("ACME", "ACME Industrie"), true);
    assert.equal(clientsProches("ACME", "ACMEX"), false);
    assert.equal(clientsProches("", "ACME"), false);
    const prev = [prevision()];
    assert.equal(proposerRapprochementsPrevisionnelles(prev, [factureClient({ client: "Autre client" })]).length, 0, "client différent");
    assert.equal(proposerRapprochementsPrevisionnelles(prev, [factureClient({ montant: 17_500 })]).length, 0, "montant à −12,5 %");
    assert.equal(proposerRapprochementsPrevisionnelles(prev, [factureClient({ montant: 21_900 })]).length, 1, "montant à +9,5 %");
    assert.equal(proposerRapprochementsPrevisionnelles(prev, [factureClient({ dateEcheance: "2027-03-01" })]).length, 0, "échéance à 60 jours");
    // Pas de date d'encaissement prévue : la date de facturation prévue sert de repère.
    assert.equal(
      proposerRapprochementsPrevisionnelles([prevision({ dateEncaissementPrevue: "" })], [factureClient({ dateEcheance: "2026-12-15" })]).length,
      1
    );
  });

  test("G ter. Jamais proposée : une vraie facture déjà rapprochée, ni une prévisionnelle déjà Facturée", () => {
    const facture = factureClient();
    const autre = prevision({ id: "prev-2" });
    assert.equal(proposerRapprochementsPrevisionnelles([rapprocher(prevision(), facture), autre], [facture]).length, 0);
    assert.equal(proposerRapprochementsPrevisionnelles([rapprocher(prevision(), factureClient({ id: "fc-autre" }))], [facture]).length, 0);
  });

  test("H. Suggestion refusée (« Ignorer ») : aucune neutralisation, plus jamais reproposée, même réimportée", () => {
    const facture = factureClient();
    const ignoree = ignorerFacture(prevision(), facture);
    assert.equal(estPrevisionnelleActive(ignoree), true);
    assert.equal(projeter([ignoree], [facture]).soldeJ90, SOLDE + 39_850, "les deux comptent toujours");
    assert.equal(proposerRapprochementsPrevisionnelles([ignoree], [facture]).length, 0);
    // Même facture Pennylane réimportée sous un nouvel identifiant interne : toujours écartée.
    assert.equal(proposerRapprochementsPrevisionnelles([ignoree], [{ ...facture, id: "fc-nouvel-id" }]).length, 0);
    // Une autre facture du même client reste proposable.
    assert.equal(proposerRapprochementsPrevisionnelles([ignoree], [factureClient({ id: "fc-124", pennylaneId: "pl-124" })]).length, 1);
    // Le rapprochement manuel reste toujours possible.
    assert.deepEqual(facturesRapprochables(ignoree, [ignoree], [facture]).map((f) => f.id), ["fc-123"]);
  });

  test("I. Deux prévisionnelles plausibles : ambiguïté présentée, aucune décision automatique", () => {
    const decembre = prevision({ id: "prev-dec" });
    const janvier = prevision({ id: "prev-jan", dateFacturationPrevue: "2026-12-15", dateEncaissementPrevue: "2027-01-14" });
    const suggestions = proposerRapprochementsPrevisionnelles([janvier, decembre], [factureClient()]);
    assert.equal(suggestions.length, 1);
    assert.deepEqual(
      suggestions[0].candidats.map((c) => c.previsionnelleId),
      ["prev-dec", "prev-jan"],
      "les deux candidates, la plus proche en date d'abord"
    );
    assert.ok([janvier, decembre].every(estPrevisionnelleActive), "aucune n'est neutralisée");
    assert.equal(projeter([janvier, decembre], [factureClient()]).soldeJ90, SOLDE + 59_850);
  });
});

describe("Factures prévisionnelles — persistance du lien", () => {
  test("Facture Pennylane réimportée sous un nouvel identifiant interne : le lien y est rattaché", () => {
    const prev = rapprocher(prevision(), factureClient());
    const orpheline = { ...prev, rapprochement: { ...prev.rapprochement!, factureClientId: null } };
    const reimportee = factureClient({ id: "fc-nouveau" });
    const [rattachee] = previsionnellesARattacher([orpheline], [reimportee]);
    assert.equal(rattachee.rapprochement!.factureClientId, "fc-nouveau");
    assert.equal(rattachee.rapprochement!.rapprocheLe, prev.rapprochement!.rapprocheLe);
    assert.deepEqual(previsionnellesARattacher([prev], [factureClient()]), [], "lien intact : rien à faire");
  });

  test("Fusion de doublons : le rapprochement passe de la facture retirée à la facture gardée", () => {
    const prev = rapprocher(prevision(), factureClient({ id: "fc-retiree", pennylaneId: null }));
    const [deplacee] = deplacerRapprochements([prev], "fc-retiree", factureClient({ id: "fc-gardee" }));
    assert.equal(deplacee.rapprochement!.factureClientId, "fc-gardee");
    assert.equal(deplacee.rapprochement!.facturePennylaneId, "pl-123");
  });

  test("Recherche : par client, montant ou numéro de la vraie facture rapprochée", () => {
    const prev = rapprocher(prevision(), factureClient());
    assert.equal(filtrerFacturesPrevisionnelles([prev], "acme").length, 1);
    assert.equal(filtrerFacturesPrevisionnelles([prev], "FAC-2026-123").length, 1);
    assert.equal(filtrerFacturesPrevisionnelles([prev], "inconnu").length, 0);
  });
});

describe("Factures prévisionnelles — J. cohérence de tous les consommateurs", () => {
  test("Active seule : +20 000 € partout (moteur, KPIs, courbe, synthèse, filtre, référence)", () => {
    verifierCoherence([prevision()], [], 20_000);
    const { previsionnelles, mois } = entreesSynthese([prevision()]);
    assert.equal(previsionnelles.montantsParMois[mois.findIndex((m) => m.cle === "2026-12")], 20_000);
  });

  test("Active + vraie facture non rapprochée : 39 850 € partout", () => {
    verifierCoherence([prevision()], [factureClient()], 39_850);
  });

  test("Rapprochée : 19 850 € partout, ligne « Factures prévisionnelles » de la synthèse à zéro", () => {
    const facture = factureClient();
    const prev = rapprocher(prevision(), facture);
    verifierCoherence([prev], [facture], 19_850);
    const { previsionnelles, clients } = entreesSynthese([prev], [facture]);
    assert.equal(previsionnelles.total, 0);
    assert.equal(clients.total, 19_850);
  });

  test("Rapprochée, vraie facture payée : 0 € partout", () => {
    const facture = factureClient();
    verifierCoherence([rapprocher(prevision(), facture)], [{ ...facture, payee: true, paidAt: MAINTENANT.toISOString() }], 0);
  });

  test("Filtre de période : une prévisionnelle rapprochée n'apparaît pas dans la fenêtre cliquée", () => {
    const facture = factureClient();
    const fenetre = { debut: "2026-12-28", fin: "2027-01-03", dateDepart: DEBUT };
    const active = calculerFluxPeriode({ ...donnees([prevision()]), ...fenetre });
    assert.deepEqual([...active.idsFacturesPrevisionnelles.keys()], ["prev-acme"]);
    const rapprochee = calculerFluxPeriode({ ...donnees([rapprocher(prevision(), facture)], [facture]), ...fenetre });
    assert.equal(rapprochee.idsFacturesPrevisionnelles.size, 0);
    assert.equal(rapprochee.resume.entrees, 19_850);
  });

  test("Contrôle mensuel : active comptée comme les autres lignes prévues, rapprochée jamais", () => {
    const ancienne = prevision({ dateFacturationPrevue: "2026-09-01", dateEncaissementPrevue: "2026-09-30" });
    const vraie = factureClient({ dateEcheance: "2026-09-28", dateEncaissementAnticipee: "2026-09-28", payee: true });
    const septembre = (prev: FacturePrevisionnelle, factures: FactureClient[]) => {
      const controle = calculerControleMensuel({ ...donnees([prev], factures) }, MAINTENANT);
      return controle.totauxParMois[controle.mois.findIndex((m) => m.cle === "2026-09")].entrees;
    };
    assert.equal(septembre(ancienne, []), 20_000);
    assert.equal(septembre(rapprocher(ancienne, vraie), [vraie]), 19_850, "seule la vraie facture (payée) compte");
  });

  test("Sans prévisionnelle : moteur strictement inchangé (paramètre absent ou vide)", () => {
    const facture = factureClient();
    const sans = calculerProjectionCash({ ...VIDES, facturesClients: [facture], soldeInitial: SOLDE, dateDepart: DEBUT, horizonJours: HORIZON });
    const vide = projeter([], [facture]);
    assert.deepEqual(sans, vide);
  });
});
