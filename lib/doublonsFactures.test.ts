import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  comparerContreparties,
  comparerFactures,
  detecterDoublons,
  estNumeroFiable,
  FactureComparable,
  FactureFusionnable,
  normaliserNumero,
  planFusion,
  rattachementPossible,
} from "./doublonsFactures";
import { calculerSynchronisation, CandidatFacturePennylane, FactureExistantePourSync } from "./pennylaneInvoiceAdapter";

let compteur = 0;
function f(facture: string, tiers: string, montant: number, dateEcheance = "2026-10-30", pennylaneId: string | null = null): FactureComparable {
  return { id: `f${++compteur}`, facture, tiers, montant, dateEcheance, pennylaneId };
}
const FOURNISSEUR = "fournisseur" as const;
const statut = (a: FactureComparable, b: FactureComparable, sens: "client" | "fournisseur" = FOURNISSEUR) => comparerFactures(a, b, sens);

describe("briques", () => {
  test("n° normalisé : casse et espaces seulement, la ponctuation reste", () => {
    assert.equal(normaliserNumero(" fa2609-0091 "), "FA2609-0091");
    assert.equal(normaliserNumero("PE080084 / L26"), "PE080084/L26");
    assert.notEqual(normaliserNumero("FA2609-0091"), normaliserNumero("FA26090091"));
  });

  test("références génériques ou trop courtes : jamais fiables seules", () => {
    for (const numero of ["003", "Simulation", "Simulation O&M", "Proforma", "12", ""]) assert.equal(estNumeroFiable(numero), false, numero);
    for (const numero of ["FA2609-0091", "PE080084/L26", "12601", "DE26-078628"]) assert.equal(estNumeroFiable(numero), true, numero);
  });

  test("contrepartie : mot distinctif commun, sigle, mots descriptifs ignorés — sans nom codé en dur", () => {
    assert.equal(comparerContreparties("SUPERMAGNETE", "Supermagnete"), "identique");
    assert.equal(comparerContreparties("SOLVEO acompte", "SOLVEO ENERGIES"), "similaire");
    assert.equal(comparerContreparties("FLS", "FLS PEMP Cuxac"), "similaire");
    assert.equal(comparerContreparties("CDLC boxes 8 éoliennes", "CHAUDRONNERIE DE LA CERE"), "similaire");
    assert.equal(comparerContreparties("Garrigade montage", "Puech montage"), null, "un mot descriptif commun ne suffit pas");
    assert.equal(comparerContreparties("Bois de l'Aiguille MES", "Q ENERGY FRANCE"), null);
  });
});

describe("hiérarchie des signaux", () => {
  test("11. même identifiant Pennylane : DUPLICATE_CERTAIN", () => {
    const d = statut(f("X-1", "A", 10, "2026-01-01", "pl-1"), f("Y-2", "B", 99, "2026-02-01", "pl-1"));
    assert.equal(d.statut, "DUPLICATE_CERTAIN");
    assert.equal(d.libelle, "Doublon certain");
  });

  test("1. même n° fiable seul : candidat remonté (REVIEW, doublon possible)", () => {
    const d = statut(f("FA2609-0001", "Alpha", 1000, "2026-10-01"), f("FA2609-0001", "Omega", 5000, "2026-12-01"));
    assert.equal(d.statut, "REVIEW");
    assert.equal(d.libelle, "Doublon possible");
    assert.equal(d.raison, "Même n° de facture");
  });

  test("2. même n° + même montant : confiance renforcée (SAME_DOCUMENT probable)", () => {
    const d = statut(f("FA2609-0092", "Bois de l'Aiguille MES", 44_748, "2026-10-21"), f("FA2609-0092", "Q ENERGY FRANCE", 44_748, "2026-10-22"));
    assert.equal(d.statut, "SAME_DOCUMENT");
    assert.equal(d.confiance, "probable");
    assert.equal(d.raison, "Même n° de facture · même montant");
  });

  test("3. même n° + montant quasi identique (arrondi à l'euro) : confiance renforcée", () => {
    const d = statut(f("ZZ-20261", "Alpha", 34_171), f("ZZ-20261", "Omega", 34_171.2));
    assert.equal(d.statut, "SAME_DOCUMENT");
    assert.deepEqual(d.signaux.includes("montant_arrondi"), true);
    assert.equal(statut(f("ZZ-20261", "Alpha", 34_171), f("ZZ-20261", "Omega", 34_175)).statut, "REVIEW", "au-delà de l'arrondi : plus de signal montant");
  });

  test("4. même n° + fournisseur similaire : confiance renforcée", () => {
    const d = statut(f("FR-SI-262792", "TKH 200miniPTZ", 24_360, "2026-10-05"), f("FR-SI-262792", "TKH SECURITY SAS", 34_800, "2026-10-04"));
    assert.equal(d.statut, "SAME_DOCUMENT");
    assert.equal(d.confiance, "probable");
    assert.equal(d.raison, "Même n° de facture · fournisseur similaire");
  });

  test("5. même n° + même montant + nom similaire : SAME_DOCUMENT très forte confiance", () => {
    const d = statut(f("12601", "ENGISO 160 aimants", 8_995, "2026-11-05"), f("12601", "ENGISO", 8_995, "2026-11-05", "pl-9"));
    assert.equal(d.statut, "SAME_DOCUMENT");
    assert.equal(d.libelle, "Doublon quasi certain");
    assert.equal(d.raison, "Même n° de facture · même montant · fournisseur similaire · même échéance");
  });

  test("6. SOLVEO ENERGIES / SOLVEO acompte, même n° : candidat très fort", () => {
    const d = statut(f("FA2609-0091", "SOLVEO acompte", 34_171, "2026-09-18"), f("FA2609-0091", "SOLVEO ENERGIES", 34_171.2, "2026-09-12", "pl-1"), "client");
    assert.equal(d.libelle, "Doublon quasi certain");
    assert.equal(d.raison, "Même n° de facture · montant quasi identique · client similaire");
  });

  test("7. FLS / FLS PEMP Cuxac, même n° : candidat très fort", () => {
    const d = statut(f("PE080084/L26", "FLS PEMP Cuxac", 12_086, "2026-09-30"), f("PE080084/L26", "FLS", 12_086.4, "2026-09-30", "pl-2"));
    assert.equal(d.libelle, "Doublon quasi certain");
  });

  test("8. référence générique « 003 » seule, fournisseurs différents : distinctes", () => {
    assert.equal(statut(f("003", "ASF", 250), f("003", "AESIO MUTUELLE", 255)).statut, "DISTINCT");
    assert.equal(statut(f("003", "ASF", 250), f("003", "AESIO MUTUELLE", 250)).statut, "DISTINCT");
  });

  test("9. plusieurs « Simulation » : jamais fusionnées sur le seul numéro", () => {
    assert.equal(statut(f("Simulation", "Garrigade montage", 90_906, "2026-11-30"), f("Simulation", "Puech montage", 90_906, "2026-11-30")).statut, "DISTINCT");
    // Référence générique : seulement une suggestion, et seulement si tout concorde.
    const tout = statut(f("Simulation", "Coivert MES", 17_244, "2026-12-15"), f("Simulation", "Coivert MES", 17_244, "2026-12-15"));
    assert.equal(tout.statut, "REVIEW");
  });

  test("10. même fournisseur + même montant, numéros différents : distinctes", () => {
    assert.equal(statut(f("INV-407-1429953", "AMAZON", 15.84, "2026-10-01"), f("INV-407-1531277", "AMAZON", 15.84, "2026-10-01")).statut, "DISTINCT");
    assert.equal(statut(f("FREE-202609-1", "FREE", 29.99), f("FREE-202610-1", "FREE", 29.99)).statut, "DISTINCT");
  });

  test("même montant sans même numéro : ne suffit jamais", () => {
    assert.equal(statut(f("A-2026-1", "MISE SUR ORBITE", 15.84), f("A-2026-2", "MISE SUR ORBITE", 15.84)).statut, "DISTINCT");
  });

  test("ligne strictement identique (deux saisies) : DUPLICATE_CERTAIN", () => {
    const d = statut(f("FA2607-0074", "Ferme Eolienne le Buret", 17_160, "2026-08-06"), f("FA2607-0074", "Ferme Eolienne le Buret", 17_160, "2026-08-06"), "client");
    assert.equal(d.statut, "DUPLICATE_CERTAIN");
  });

  test("FR-SI-263009 : deux documents Pennylane distincts, même n°, même montant — signalés, jamais fusionnés", () => {
    const a = f("FR-SI-263009", "TKH SECURITY SAS", 7_996.21, "2026-10-25", "pl-a");
    const b = f("FR-SI-263009", "TKH SECURITY SAS", 7_996.21, "2026-10-25", "pl-b");
    const d = statut(a, b);
    assert.equal(d.statut, "SAME_DOCUMENT");
    assert.equal(d.deuxDocumentsSource, true);
    assert.match(d.raison, /deux documents Pennylane distincts/);
    const plan = planFusion({ ...a, datePrevue: a.dateEcheance, payee: false, litigieuse: false }, { ...b, datePrevue: b.dateEcheance, payee: false, litigieuse: false });
    assert.equal(plan.possible, false);
  });

  test("detecterDoublons : ne compare que n° ou identifiant communs, du plus sûr au moins sûr", () => {
    const factures = [
      f("FA2609-0091", "SOLVEO acompte", 34_171),
      f("FA2609-0091", "SOLVEO ENERGIES", 34_171.2, "2026-10-30", "pl-1"),
      f("INV-1", "AMAZON", 15.84),
      f("INV-2", "AMAZON", 15.84),
      f("FA2609-0001", "Alpha", 1),
      f("FA2609-0001", "Omega", 2),
    ];
    const paires = detecterDoublons(factures, "client");
    assert.deepEqual(paires.map((p) => p.detection.statut), ["SAME_DOCUMENT", "REVIEW"]);
  });
});

describe("fusion conservatrice", () => {
  const ligne = (id: string, pennylaneId: string | null, extra: Partial<FactureFusionnable> = {}): FactureFusionnable => ({
    id,
    facture: "FR-SI-262792",
    tiers: pennylaneId ? "TKH SECURITY SAS" : "TKH 200miniPTZ",
    montant: pennylaneId ? 34_800 : 24_360,
    dateEcheance: "2026-10-04",
    datePrevue: "2026-10-04",
    payee: false,
    litigieuse: false,
    pennylaneId,
    ...extra,
  });

  test("4. ligne Novanta modifiée (date) + import Pennylane, même montant : la ligne Novanta reste et reçoit l'identité source", () => {
    const novanta = ligne("nov", null, { montant: 12_086, datePrevue: "2026-10-16" });
    const source = ligne("pl", "pl-29540726988800", { montant: 12_086.4 });
    const plan = planFusion(novanta, source);
    assert.ok(plan.possible);
    if (!plan.possible) return;
    assert.equal(plan.survivantId, "nov");
    assert.equal(plan.surnumeraireId, "pl");
    assert.equal(plan.pennylaneIdATransferer, "pl-29540726988800");
    assert.deepEqual(
      plan.ecarts.map((e) => e.replace(/[\u202f\u00a0]/g, " ")),
      ["Montant : 12 086 € / 12 086,4 €", "Date prévue : 2026-10-16 / 2026-10-04"]
    );
  });

  test("5. montants différents (au-delà de l'arrondi) : jamais fusionnés, question laissée ouverte", () => {
    const plan = planFusion(ligne("nov", null), ligne("pl", "pl-28387979223040"));
    assert.equal(plan.possible, false);
    if (!plan.possible) assert.match(plan.motif, /Montants différents : à vérifier et traiter à la main/);
  });

  test("rattachement d'un clic proposé seulement si les montants concordent", () => {
    const meme = comparerFactures(f("PE080084/L26", "FLS PEMP Cuxac", 12_086), f("PE080084/L26", "FLS", 12_086.4), FOURNISSEUR);
    const different = comparerFactures(f("FR-SI-262792", "TKH 200miniPTZ", 24_360), f("FR-SI-262792", "TKH SECURITY SAS", 34_800), FOURNISSEUR);
    assert.equal(rattachementPossible(meme), true);
    assert.equal(rattachementPossible(different), false);
  });

  test("ligne Pennylane elle aussi modifiée : pas de fusion automatique, décision de l'utilisateur", () => {
    const plan = planFusion(ligne("nov", null), ligne("pl", "pl-1", { datePrevue: "2026-11-02" }));
    assert.equal(plan.possible, false);
  });
});

describe("synchronisation Pennylane : plus de seconde facture", () => {
  const candidat = (pennylaneId: string, facture: string, tiers: string, montant: number, extra: Partial<CandidatFacturePennylane> = {}): CandidatFacturePennylane => ({
    pennylaneId,
    facture,
    tiers,
    montant,
    dateEcheance: "2026-09-30",
    payee: false,
    motifSolde: null,
    ...extra,
  });
  const existante = (id: string, facture: string, tiers: string, montant: number, pennylaneId: string | null = null): FactureExistantePourSync => ({
    id,
    pennylaneId,
    payee: false,
    facture,
    tiers,
    montant,
    dateEcheance: "2026-09-30",
  });

  test("1. même identifiant Pennylane présenté deux fois : une seule facture", () => {
    const c = candidat("pl-1", "PE080085/L26", "FLS", 2_208);
    assert.equal(calculerSynchronisation([c, c], []).aInserer.length, 1);
  });

  test("3. facture saisie dans Novanta (nom enrichi) puis synchronisée : rattachement proposé, pas d'insertion", () => {
    const resultat = calculerSynchronisation([candidat("pl-1", "PE080084/L26", "FLS", 12_086.4)], [existante("nov-1", "PE080084/L26", "FLS PEMP Cuxac", 12_086)]);
    assert.deepEqual(resultat.aInserer, []);
    assert.equal(resultat.aRattacher.length, 1);
    assert.equal(resultat.aRattacher[0].existanteId, "nov-1");
    assert.equal(resultat.aRattacher[0].detection.libelle, "Doublon quasi certain");
  });

  test("même n° seulement : rattachement proposé aussi (suggestion), jamais une seconde ligne silencieuse", () => {
    const resultat = calculerSynchronisation([candidat("pl-1", "FR-SI-261751", "TKH SECURITY SAS", 39_816)], [existante("nov-1", "FR-SI-261751", "Alpha", 27_871.2)]);
    assert.deepEqual(resultat.aInserer, []);
    assert.equal(resultat.aRattacher[0].detection.statut, "REVIEW");
  });

  test("après rattachement (identifiant posé sur la ligne Novanta) : reconnue, rien à insérer", () => {
    const resultat = calculerSynchronisation([candidat("pl-1", "PE080084/L26", "FLS", 12_086.4)], [existante("nov-1", "PE080084/L26", "FLS PEMP Cuxac", 12_086, "pl-1")]);
    assert.deepEqual([resultat.aInserer, resultat.aRattacher], [[], []]);
  });

  test("10. synchronisation exécutée deux fois : idempotente, aucune facture supplémentaire", () => {
    const candidats = [candidat("pl-1", "NEW-2026-1", "Alpha", 100), candidat("pl-2", "PE080084/L26", "FLS", 12_086.4)];
    const etat = [existante("nov-1", "PE080084/L26", "FLS PEMP Cuxac", 12_086)];
    const premiere = calculerSynchronisation(candidats, etat);
    assert.deepEqual(premiere.aInserer.map((c) => c.pennylaneId), ["pl-1"]);
    const apres = [...etat, existante("ins-1", "NEW-2026-1", "Alpha", 100, "pl-1")];
    const seconde = calculerSynchronisation(candidats, apres);
    assert.deepEqual(seconde.aInserer, []);
    assert.deepEqual(seconde.aRattacher.map((r) => r.existanteId), ["nov-1"], "la proposition reste la même tant que l'utilisateur n'a pas choisi");
    assert.deepEqual(calculerSynchronisation(candidats, apres), seconde);
  });

  test("factures distinctes au même montant chez le même fournisseur : toutes importées", () => {
    const resultat = calculerSynchronisation(
      [candidat("pl-1", "INV-407-1", "AMAZON", 15.84), candidat("pl-2", "INV-407-2", "AMAZON", 15.84)],
      [existante("nov-1", "INV-407-0", "AMAZON", 15.84)]
    );
    assert.equal(resultat.aInserer.length, 2);
    assert.deepEqual(resultat.aRattacher, []);
  });

  test("référence générique : jamais retenue au rattachement sans tous les autres signaux", () => {
    const resultat = calculerSynchronisation([candidat("pl-1", "003", "ASF", 250)], [existante("nov-1", "003", "AESIO MUTUELLE", 255)]);
    assert.equal(resultat.aInserer.length, 1);
  });

  test("ligne déjà rattachée à un autre document Pennylane : le second document est importé (deux sources distinctes)", () => {
    const resultat = calculerSynchronisation([candidat("pl-b", "FR-SI-263009", "TKH SECURITY SAS", 7_996.21)], [existante("pl-a-row", "FR-SI-263009", "TKH SECURITY SAS", 7_996.21, "pl-a")]);
    assert.equal(resultat.aInserer.length, 1);
  });
});
