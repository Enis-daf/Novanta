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
  appliquerFusion,
  choixManquants,
  clePaire,
  proposerFusion,
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

  test("3. même n° + montant quasi identique (arrondi à l'euro, ou écart d'au plus 1 %) : confiance renforcée", () => {
    const d = statut(f("ZZ-20261", "Alpha", 34_171), f("ZZ-20261", "Omega", 34_171.2));
    assert.equal(d.statut, "SAME_DOCUMENT");
    assert.deepEqual(d.signaux.includes("montant_arrondi"), true);
    assert.ok(statut(f("ZZ-20261", "Alpha", 10_000), f("ZZ-20261", "Omega", 10_100)).signaux.includes("montant_arrondi"), "1 % : quasi identique");
    assert.equal(statut(f("ZZ-20261", "Alpha", 10_000), f("ZZ-20261", "Omega", 10_150)).statut, "REVIEW", "au-delà de 1 % : plus de signal montant");
    assert.ok(statut(f("ZZ-20261", "Alpha", 15.2), f("ZZ-20261", "Omega", 15.84)).signaux.includes("montant_arrondi"), "petit montant : arrondi à l'euro");
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
    // Fusionnable sur confirmation : le document retiré ne sera plus importé (voir la synchronisation).
    const resultat = appliquerFusion(
      { ...a, datePrevue: a.dateEcheance, payee: false, litigieuse: false },
      { ...b, datePrevue: b.dateEcheance, payee: false, litigieuse: false },
      proposerFusion({ ...a, datePrevue: a.dateEcheance, payee: false, litigieuse: false }, { ...b, datePrevue: b.dateEcheance, payee: false, litigieuse: false }),
      {}
    );
    assert.equal(resultat?.pennylaneIdRetire, "pl-b");
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

describe("fusion confirmée : cas réels du staging", () => {
  // Lignes telles qu'en base de staging (n°, tiers, montants, échéances, statuts).
  const ligne = (id: string, facture: string, tiers: string, montant: number, dateEcheance: string, extra: Partial<FactureFusionnable> = {}): FactureFusionnable => ({
    id,
    facture,
    tiers,
    montant,
    dateEcheance,
    datePrevue: dateEcheance,
    payee: false,
    litigieuse: false,
    pennylaneId: null,
    ...extra,
  });
  const A = {
    novanta: ligne("nov-a", "FR-SI-262590", "TKH 8ht parl", 2_996, "2026-09-10", { payee: true }),
    pennylane: ligne("pl-a", "FR-SI-262590", "TKH SECURITY SAS", 2_996.06, "2026-09-10", { payee: true, pennylaneId: "pl-262590" }),
  };
  const B = {
    pennylane: ligne("pl-b", "F-202610-7", "CHAUDRONNERIE DE LA CERE", 17_988.48, "2026-11-07", { pennylaneId: "pl-202610" }),
    novanta: ligne("nov-b", "F-202610-7", "CDLC boxes 8 éoliennes", 17_498, "2026-11-07", { datePrevue: "2026-11-12" }),
  };
  const C = {
    pennylane: ligne("pl-c", "FR-SI-262819", "TKH SECURITY SAS", 5_330.81, "2026-09-30", { payee: true, pennylaneId: "pl-262819" }),
    novanta: ligne("nov-c", "FR-SI-262819", "TKH 6disk durs", 3_731, "2026-09-30", { payee: true, datePrevue: "2026-10-07" }),
  };
  const D = {
    novanta: ligne("nov-d", "FR-SI-261751", "TKH 133MiniPTZ solde", 27_871.2, "2026-07-04", { payee: true }),
    pennylane: ligne("pl-d", "FR-SI-261751", "TKH SECURITY SAS", 39_816, "2026-07-09", { pennylaneId: "pl-261751" }),
  };

  test("A. montants quasi identiques : référence Pennylane, montant à choisir (aucun écart deviné)", () => {
    const proposition = proposerFusion(A.novanta, A.pennylane);
    assert.equal(proposition.referenceId, "pl-a");
    assert.equal(proposition.referenceImposee, true);
    assert.deepEqual(choixManquants(proposition, {}), ["montant"]);
    assert.equal(appliquerFusion(A.novanta, A.pennylane, proposition, {}), null, "pas de fusion tant qu'un choix manque");
    const resultat = appliquerFusion(A.novanta, A.pennylane, proposition, { montant: "b" })!;
    assert.equal(resultat.reference.id, "pl-a");
    assert.equal(resultat.reference.montant, 2_996.06);
    assert.equal(resultat.reference.montantSource, null);
    assert.equal(resultat.retiree.id, "nov-a");
    assert.equal(resultat.pennylaneIdRetire, null);
  });

  test("B. montants différents : fusion possible, montant Novanta retenu pour la prévision, montant Pennylane conservé à part", () => {
    const proposition = proposerFusion(B.pennylane, B.novanta);
    const montant = proposition.differences.find((d) => d.champ === "montant")!;
    assert.equal(montant.parDefaut, null);
    // Date prévue déplacée sur la seule ligne Novanta : son réglage est repris d'office.
    assert.equal(proposition.differences.find((d) => d.champ === "datePrevue")!.parDefaut, "b");
    const resultat = appliquerFusion(B.pennylane, B.novanta, proposition, { montant: "b" })!;
    assert.equal(resultat.reference.id, "pl-b");
    assert.equal(resultat.reference.pennylaneId, "pl-202610");
    assert.equal(resultat.reference.montant, 17_498);
    assert.equal(resultat.reference.montantSource, 17_988.48);
    assert.equal(resultat.reference.datePrevue, "2026-11-12");
    assert.equal(resultat.reference.facture, "F-202610-7");
  });

  test("C. montants différents, Pennylane retenu : aucun montant source à part", () => {
    const proposition = proposerFusion(C.pennylane, C.novanta);
    const resultat = appliquerFusion(C.pennylane, C.novanta, proposition, { montant: "a" })!;
    assert.equal(resultat.reference.montant, 5_330.81);
    assert.equal(resultat.reference.montantSource, null);
    assert.equal(resultat.reference.payee, true);
    assert.equal(resultat.reference.datePrevue, "2026-10-07", "réglage de la ligne Novanta repris");
  });

  test("D. montants et statuts contradictoires : rien de choisi d'office", () => {
    const proposition = proposerFusion(D.novanta, D.pennylane);
    assert.deepEqual(choixManquants(proposition, {}).sort(), ["montant", "payee"]);
    // Les deux dates prévues sont leurs échéances : aucune n'est un réglage, celle de la référence est proposée.
    assert.equal(proposition.differences.find((d) => d.champ === "datePrevue")!.parDefaut, "b");
    const resultat = appliquerFusion(D.novanta, D.pennylane, proposition, { montant: "a", payee: "a" })!;
    assert.deepEqual([resultat.reference.id, resultat.reference.montant, resultat.reference.montantSource, resultat.reference.payee], ["pl-d", 27_871.2, 39_816, true]);
  });

  test("réglages contradictoires (deux dates prévues déplacées) : choix obligatoire ; un choix explicite l'emporte", () => {
    const x = ligne("x", "FA2609-0091", "SOLVEO", 100, "2026-10-01", { datePrevue: "2026-10-05" });
    const y = ligne("y", "FA2609-0091", "SOLVEO", 100, "2026-10-01", { datePrevue: "2026-10-20", litigieuse: true });
    const proposition = proposerFusion(x, y);
    assert.deepEqual(choixManquants(proposition, {}), ["datePrevue"]);
    assert.equal(proposition.differences.find((d) => d.champ === "litigieuse")!.parDefaut, "b");
    const resultat = appliquerFusion(x, y, proposition, { datePrevue: "a", litigieuse: "a" })!;
    assert.deepEqual([resultat.reference.datePrevue, resultat.reference.litigieuse], ["2026-10-05", false]);
  });

  test("sans réglage ni écart : rien à choisir, deux lignes Novanta → la référence se choisit", () => {
    const x = ligne("x", "FA2609-0091", "SOLVEO", 100, "2026-10-01");
    const y = ligne("y", "FA2609-0091", "SOLVEO", 100, "2026-10-01");
    const proposition = proposerFusion(x, y);
    assert.deepEqual([proposition.differences, proposition.referenceImposee, proposition.referenceId], [[], false, "x"]);
    assert.equal(proposerFusion(x, y, "y").referenceId, "y");
    assert.equal(appliquerFusion(x, y, proposerFusion(x, y, "y"), {})!.retiree.id, "x");
  });

  test("une facture Pennylane reste toujours la référence, quel que soit le choix demandé", () => {
    assert.equal(proposerFusion(B.pennylane, B.novanta, "nov-b").referenceId, "pl-b");
  });

  test("clé de paire indépendante de l'ordre", () => {
    assert.equal(clePaire("b", "a"), clePaire("a", "b"));
  });

  test("rattachement d'un clic proposé seulement si les montants concordent", () => {
    const meme = comparerFactures(f("PE080084/L26", "FLS PEMP Cuxac", 12_086), f("PE080084/L26", "FLS", 12_086.4), FOURNISSEUR);
    const different = comparerFactures(f("FR-SI-262792", "TKH 200miniPTZ", 24_360), f("FR-SI-262792", "TKH SECURITY SAS", 34_800), FOURNISSEUR);
    assert.equal(rattachementPossible(meme), true);
    assert.equal(rattachementPossible(different), false);
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

  test("après fusion : la facture Pennylane retirée n'est ni réimportée ni reproposée ; la référence reste reconnue", () => {
    const candidats = [candidat("pl-a", "FR-SI-263009", "TKH SECURITY SAS", 7_996.21), candidat("pl-b", "FR-SI-263009", "TKH SECURITY SAS", 7_996.21)];
    // pl-a conservée (référence), pl-b retirée par la fusion.
    const etat = [existante("ref", "FR-SI-263009", "TKH SECURITY SAS", 7_996.21, "pl-a")];
    const sansMemoire = calculerSynchronisation(candidats, etat, "fournisseur");
    assert.deepEqual(sansMemoire.aInserer.map((c) => c.pennylaneId), ["pl-b"], "sans la mémoire de la fusion, le doublon reviendrait");
    const resultat = calculerSynchronisation(candidats, etat, "fournisseur", new Set(["pl-b"]));
    assert.deepEqual([resultat.aInserer, resultat.aRattacher, resultat.idsAMettreAJourPayee], [[], [], []]);
    // Ligne Novanta retirée (sans identifiant) : rien à mémoriser, la référence Pennylane est reconnue.
    const apresFusionNovanta = calculerSynchronisation([candidat("pl-a", "FR-SI-263009", "TKH SECURITY SAS", 7_996.21)], etat, "fournisseur");
    assert.deepEqual([apresFusionNovanta.aInserer, apresFusionNovanta.aRattacher], [[], []]);
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
