import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  calculerSynchronisation,
  candidatFactureClient,
  candidatFactureFournisseur,
  candidatVersFactureClient,
  candidatVersFactureFournisseur,
  CandidatFacturePennylane,
  candidatsClientsPennylane,
  candidatsFournisseursPennylane,
  decisionPaiementClient,
  decisionPaiementFournisseur,
  estAvoir,
  estPayeeFournisseur,
  extraireTiersEtNumero,
  FactureExistantePourSync,
  messageSyncPennylane,
  ResultatSyncPennylane,
} from "./pennylaneInvoiceAdapter";
import { PennylaneCustomerInvoiceListItem, PennylaneSupplierInvoiceListItem } from "./pennylaneClient";

function customerItemFactice(overrides: Partial<PennylaneCustomerInvoiceListItem> = {}): PennylaneCustomerInvoiceListItem {
  return {
    id: 28964101701632,
    invoice_number: "FA2609-0090",
    date: "2026-09-04",
    label: "Facture SOCIETE D'EXPLOITATION EOLIENNE ANGRIE - FA2609-0090 (label généré)",
    amount: "1680.0",
    deadline: "2026-10-04",
    paid: false,
    draft: false,
    ...overrides,
  };
}

function supplierItemFactice(overrides: Partial<PennylaneSupplierInvoiceListItem> = {}): PennylaneSupplierInvoiceListItem {
  return {
    id: 27218741563392,
    invoice_number: "12534",
    date: "2026-07-29",
    label: "Facture ENGISO - 12534 (label généré)",
    amount: "14270.0",
    deadline: "2026-08-28",
    paid: false,
    ...overrides,
  };
}

describe("estAvoir — détection d'un avoir (montant négatif)", () => {
  test("montant négatif -> avoir", () => assert.equal(estAvoir("-19800.0"), true));
  test("montant positif -> pas un avoir", () => assert.equal(estAvoir("19800.0"), false));
  test("zéro -> pas un avoir", () => assert.equal(estAvoir("0"), false));
});

describe("candidatFactureClient — J. avoir, K. brouillon, cas normal", () => {
  test("facture normale, non payée -> candidat construit depuis la liste seule (paid déjà présent)", () => {
    const candidat = candidatFactureClient(customerItemFactice());
    assert.ok(candidat);
    assert.equal(candidat!.pennylaneId, "28964101701632");
    assert.equal(candidat!.facture, "FA2609-0090");
    assert.equal(candidat!.tiers, "SOCIETE D'EXPLOITATION EOLIENNE ANGRIE");
    assert.equal(candidat!.montant, 1680);
    assert.equal(candidat!.dateEcheance, "2026-10-04");
    assert.equal(candidat!.payee, false);
  });

  test("J. avoir (montant négatif, cas réel 'Avoir EOLIA') -> jamais importé", () => {
    const candidat = candidatFactureClient(
      customerItemFactice({
        id: 21494940622848,
        invoice_number: "AV2603-0004",
        label: "Avoir EOLIA - AV2603-0004 (label généré)",
        amount: "-102886.56",
      })
    );
    assert.equal(candidat, null);
  });

  test("K. brouillon (draft: true) -> jamais importé", () => {
    const candidat = candidatFactureClient(customerItemFactice({ draft: true }));
    assert.equal(candidat, null);
  });

  test("paid: true -> candidat construit avec payee=true (le tri import/no-op se fait dans calculerSynchronisation)", () => {
    const candidat = candidatFactureClient(customerItemFactice({ paid: true }));
    assert.equal(candidat!.payee, true);
  });

  test("invoice_number absent -> repli sur le numéro extrait du libellé", () => {
    const candidat = candidatFactureClient(customerItemFactice({ invoice_number: null }));
    assert.equal(candidat!.facture, "FA2609-0090"); // extrait du libellé malgré tout
  });

  test("libellé sans nom de tiers -> libellé générique client, jamais une chaîne vide", () => {
    const candidat = candidatFactureClient(
      customerItemFactice({ label: "Facture - FA2604-0032 (label généré)", invoice_number: "FA2604-0032" })
    );
    assert.equal(candidat!.tiers, "Client Pennylane");
  });
});

describe("extraireTiersEtNumero — parsing best-effort des libellés réels Pennylane", () => {
  test("cas réel : 'Facture <TIERS> - <NUMERO> (label généré)'", () => {
    const r = extraireTiersEtNumero("Facture ENGISO - 12534 (label généré)", "fallback");
    assert.equal(r.tiers, "ENGISO");
    assert.equal(r.numero, "12534");
  });

  test("cas réel : 'Avoir <TIERS> - <NUMERO> (label généré)'", () => {
    const r = extraireTiersEtNumero("Avoir EOLIA - AV2607-0006 (label généré)", "fallback");
    assert.equal(r.tiers, "EOLIA");
    assert.equal(r.numero, "AV2607-0006");
  });

  test("cas réel : numéro contenant des parenthèses ('INV-407-...(2)')", () => {
    const r = extraireTiersEtNumero("Facture AMAZON - INV-407-1429953-4000307(2) (label généré)", "fallback");
    assert.equal(r.tiers, "AMAZON");
    assert.equal(r.numero, "INV-407-1429953-4000307(2)");
  });

  test("cas réel : nom du tiers absent ('Facture - <NUMERO> (label généré)')", () => {
    const r = extraireTiersEtNumero("Facture - 2026-3080464 (label généré)", "fallback", "Générique");
    assert.equal(r.tiers, "Générique");
    assert.equal(r.numero, "2026-3080464");
  });

  test("libellé qui ne correspond à aucun motif connu -> repli sur le libellé complet", () => {
    const r = extraireTiersEtNumero("Un libellé personnalisé sans le motif habituel", "fallback-id");
    assert.equal(r.tiers, "Un libellé personnalisé sans le motif habituel");
    assert.equal(r.numero, "fallback-id");
  });

  test("libellé null -> repli générique, jamais une exception", () => {
    const r = extraireTiersEtNumero(null, "fallback-id", "Générique");
    assert.equal(r.tiers, "Générique");
    assert.equal(r.numero, "fallback-id");
  });
});

describe("candidatFactureFournisseur", () => {
  test("facture normale -> candidat construit depuis la liste seule (paid déjà présent)", () => {
    const candidat = candidatFactureFournisseur(supplierItemFactice());
    assert.ok(candidat);
    assert.equal(candidat!.pennylaneId, "27218741563392");
    assert.equal(candidat!.facture, "12534");
    assert.equal(candidat!.tiers, "ENGISO");
    assert.equal(candidat!.montant, 14270);
    assert.equal(candidat!.payee, false);
  });

  test("montant négatif (avoir, par cohérence même si non observé côté fournisseurs) -> jamais importé", () => {
    const candidat = candidatFactureFournisseur(supplierItemFactice({ amount: "-100" }));
    assert.equal(candidat, null);
  });

  test("paid: true -> candidat payee=true", () => {
    const candidat = candidatFactureFournisseur(supplierItemFactice({ paid: true }));
    assert.equal(candidat!.payee, true);
  });

  test("invoice_number absent -> repli sur le numéro extrait du libellé", () => {
    const candidat = candidatFactureFournisseur(supplierItemFactice({ invoice_number: null }));
    assert.equal(candidat!.facture, "12534");
  });
});

describe("calculerSynchronisation — algorithme de synchronisation (diagnostic §12)", () => {
  function existante(overrides: Partial<FactureExistantePourSync> = {}): FactureExistantePourSync {
    return { id: "novanta-1", pennylaneId: "pnl-1", payee: false, ...overrides };
  }
  function candidat(overrides: Partial<CandidatFacturePennylane> = {}): CandidatFacturePennylane {
    return {
      pennylaneId: "pnl-1",
      facture: "FA-1",
      tiers: "ACME",
      montant: 100,
      dateEcheance: "2026-09-01",
      payee: false,
      ...overrides,
    };
  }

  test("A/B. candidat absent de Novanta, non payée -> INSERT une fois", () => {
    const resultat = calculerSynchronisation([candidat()], []);
    assert.equal(resultat.aInserer.length, 1);
    assert.equal(resultat.aInserer[0].pennylaneId, "pnl-1");
    assert.deepEqual(resultat.idsAMettreAJourPayee, []);
  });

  test("candidat absent de Novanta, déjà payée côté Pennylane -> jamais importée (règle produit A : seules les factures ouvertes)", () => {
    const resultat = calculerSynchronisation([candidat({ payee: true })], []);
    assert.deepEqual(resultat.aInserer, []);
    assert.deepEqual(resultat.idsAMettreAJourPayee, []);
  });

  test("C. synchronisation répétée -> aucun doublon (idempotence)", () => {
    const premierPassage = calculerSynchronisation([candidat()], []);
    assert.equal(premierPassage.aInserer.length, 1);

    const facturesApresInsertion: FactureExistantePourSync[] = [
      { id: "novanta-1", pennylaneId: "pnl-1", payee: false },
    ];
    const deuxiemePassage = calculerSynchronisation([candidat()], facturesApresInsertion);
    assert.deepEqual(deuxiemePassage.aInserer, []);
    assert.deepEqual(deuxiemePassage.idsAMettreAJourPayee, []);
  });

  test("D. facture connue devient payée côté Pennylane -> UPDATE payee=true", () => {
    const resultat = calculerSynchronisation([candidat({ payee: true })], [existante({ payee: false })]);
    assert.deepEqual(resultat.aInserer, []);
    assert.deepEqual(resultat.idsAMettreAJourPayee, ["novanta-1"]);
  });

  test("E. facture connue reste non payée -> aucun changement", () => {
    const resultat = calculerSynchronisation([candidat({ payee: false })], [existante({ payee: false })]);
    assert.deepEqual(resultat.aInserer, []);
    assert.deepEqual(resultat.idsAMettreAJourPayee, []);
  });

  test("F. facture Novanta déjà Payée, Pennylane toujours payée -> reste telle quelle (pas de re-update inutile)", () => {
    const resultat = calculerSynchronisation([candidat({ payee: true })], [existante({ payee: true })]);
    assert.deepEqual(resultat.aInserer, []);
    assert.deepEqual(resultat.idsAMettreAJourPayee, []);
  });

  test("G. Pennylane redevient non payée après avoir été payée côté Novanta -> JAMAIS repassée à false", () => {
    const resultat = calculerSynchronisation([candidat({ payee: false })], [existante({ payee: true })]);
    assert.deepEqual(resultat.aInserer, []);
    assert.deepEqual(resultat.idsAMettreAJourPayee, []);
  });

  test("H/I. la mise à jour ne porte jamais que sur l'id -> aucune donnée de date/litigieuse ne peut être écrasée par construction", () => {
    const resultat = calculerSynchronisation([candidat({ payee: true })], [existante({ payee: false })]);
    assert.deepEqual(resultat.idsAMettreAJourPayee, ["novanta-1"]);
  });

  test("M. factures client/fournisseur au même numéro -> aucune collision (le rapprochement se fait par pennylaneId, appelé séparément par type)", () => {
    const resultatClients = calculerSynchronisation(
      [candidat({ pennylaneId: "pnl-client-1", facture: "0001" })],
      []
    );
    const resultatFournisseurs = calculerSynchronisation(
      [candidat({ pennylaneId: "pnl-fournisseur-1", facture: "0001" })],
      []
    );
    assert.equal(resultatClients.aInserer.length, 1);
    assert.equal(resultatFournisseurs.aInserer.length, 1);
    assert.notEqual(resultatClients.aInserer[0].pennylaneId, resultatFournisseurs.aInserer[0].pennylaneId);
  });

  test("plusieurs candidats mêlant insertion, mise à jour et no-op dans un seul appel", () => {
    const candidats: CandidatFacturePennylane[] = [
      candidat({ pennylaneId: "nouveau-non-paye", payee: false }),
      candidat({ pennylaneId: "nouveau-paye", payee: true }),
      candidat({ pennylaneId: "connu-devient-paye", payee: true }),
      candidat({ pennylaneId: "connu-reste-non-paye", payee: false }),
      candidat({ pennylaneId: "connu-deja-paye", payee: true }),
    ];
    const existantes: FactureExistantePourSync[] = [
      { id: "id-connu-devient-paye", pennylaneId: "connu-devient-paye", payee: false },
      { id: "id-connu-reste-non-paye", pennylaneId: "connu-reste-non-paye", payee: false },
      { id: "id-connu-deja-paye", pennylaneId: "connu-deja-paye", payee: true },
    ];
    const resultat = calculerSynchronisation(candidats, existantes);
    assert.equal(resultat.aInserer.length, 1);
    assert.equal(resultat.aInserer[0].pennylaneId, "nouveau-non-paye");
    assert.deepEqual(resultat.idsAMettreAJourPayee, ["id-connu-devient-paye"]);
  });
});

describe("candidatVersFactureClient / candidatVersFactureFournisseur — conversion vers le modèle Novanta", () => {
  const candidat: CandidatFacturePennylane = {
    pennylaneId: "pnl-42",
    facture: "FA-42",
    tiers: "ACME",
    montant: 250,
    dateEcheance: "2026-10-01",
    payee: false,
  };

  test("FactureClient : pennylaneId conservé, payee=false, date prévue = échéance par défaut", () => {
    const facture = candidatVersFactureClient(candidat);
    assert.equal(facture.pennylaneId, "pnl-42");
    assert.equal(facture.facture, "FA-42");
    assert.equal(facture.client, "ACME");
    assert.equal(facture.montant, 250);
    assert.equal(facture.dateEcheance, "2026-10-01");
    assert.equal(facture.dateEncaissementAnticipee, "2026-10-01");
    assert.equal(facture.payee, false);
    assert.equal(facture.litigieuse, false);
    assert.equal(facture.paidAt, null);
    assert.ok(facture.id);
  });

  test("FactureFournisseur : même règle, avec datePaiementPrevue", () => {
    const facture = candidatVersFactureFournisseur(candidat);
    assert.equal(facture.pennylaneId, "pnl-42");
    assert.equal(facture.fournisseur, "ACME");
    assert.equal(facture.datePaiementPrevue, "2026-10-01");
    assert.equal(facture.payee, false);
  });

  test("deux appels sur le même candidat génèrent des id Novanta différents", () => {
    const a = candidatVersFactureClient(candidat);
    const b = candidatVersFactureClient(candidat);
    assert.notEqual(a.id, b.id);
  });
});

describe("messageSyncPennylane — distingue explicitement analysée (trouvée) de ajoutée (nouvelle)", () => {
  function resultat(overrides: Partial<ResultatSyncPennylane> = {}): ResultatSyncPennylane {
    return {
      nombreClientsAnalysees: 0,
      nombreFournisseursAnalysees: 0,
      nombreClientsAjoutes: 0,
      nombreFournisseursAjoutes: 0,
      nombreMarquesPayees: 0,
      nombreArchiveesRetirees: 0,
      erreurClients: null,
      erreurFournisseurs: null,
      ...overrides,
    };
  }

  test("0 analysée, 0 ajoutée -> le message le dit explicitement (jamais ambigu avec un échec silencieux)", () => {
    const msg = messageSyncPennylane(resultat());
    assert.ok(msg.includes("0 facture fournisseur"));
    assert.ok(msg.includes("0 nouvelle importée"));
  });

  test("115 analysées, 0 ajoutée (déjà toutes importées) -> les deux chiffres apparaissent, différents", () => {
    const msg = messageSyncPennylane(resultat({ nombreFournisseursAnalysees: 115, nombreFournisseursAjoutes: 0 }));
    assert.ok(msg.includes("115 factures fournisseurs"));
    assert.ok(msg.includes("0 nouvelle importée"));
  });

  test("39 analysées, 39 ajoutées (premier import) -> les deux chiffres coïncident", () => {
    const msg = messageSyncPennylane(resultat({ nombreFournisseursAnalysees: 39, nombreFournisseursAjoutes: 39 }));
    assert.ok(msg.includes("39 factures fournisseurs"));
    assert.ok(msg.includes("39 nouvelles importées"));
  });

  test("pluriel correct au singulier (1 facture, pas de s)", () => {
    const msg = messageSyncPennylane(resultat({ nombreFournisseursAnalysees: 1, nombreFournisseursAjoutes: 1, nombreMarquesPayees: 1 }));
    assert.ok(msg.includes("1 facture fournisseur"));
    assert.ok(!msg.includes("1 facture fournisseurs"));
    assert.ok(msg.includes("1 nouvelle importée"));
    assert.ok(msg.includes("1 facture marquée payée"));
    assert.ok(!msg.includes("archivée"));
  });

  test("factures archivées retirées -> mentionnées, avec le bon pluriel", () => {
    assert.ok(messageSyncPennylane(resultat({ nombreArchiveesRetirees: 1 })).includes("1 facture archivée dans Pennylane retirée."));
    assert.ok(messageSyncPennylane(resultat({ nombreArchiveesRetirees: 73 })).includes("73 factures archivées dans Pennylane retirées."));
  });
});

// Statut payé d'une facture fournisseur ACTIVE : le booléen `paid` de Pennylane arbitre, quel que
// soit payment_status (qui décrit le workflow) et sans jamais lire le reste à payer. Les cas
// reprennent la forme de factures réelles, sous des noms fictifs.
describe("statut de paiement fournisseur — decisionPaiementFournisseur", () => {
  test("to_be_processed, reste à payer 0, paid=true -> payée", () => {
    const item = supplierItemFactice({ amount: "9043.21", payment_status: "to_be_processed", accounting_status: "complete", paid: true });
    assert.deepEqual(decisionPaiementFournisseur(item), { payee: true, motifSolde: "payee", statutInconnu: null });
    assert.equal(candidatFactureFournisseur(item)!.payee, true);
  });

  test("to_be_processed, reste à payer 0, paid=false -> impayée", () => {
    const item = supplierItemFactice({ amount: "9043.21", payment_status: "to_be_processed", accounting_status: "complete", paid: false });
    assert.deepEqual(decisionPaiementFournisseur(item), { payee: false, motifSolde: null, statutInconnu: null });
  });

  test("to_be_paid, paid=true -> payée ; paid=false -> impayée", () => {
    assert.equal(estPayeeFournisseur(supplierItemFactice({ payment_status: "to_be_paid", accounting_status: "complete", paid: true })), true);
    assert.equal(estPayeeFournisseur(supplierItemFactice({ payment_status: "to_be_paid", accounting_status: "complete", paid: false })), false);
  });

  test("fully_paid, paid=true -> payée", () => {
    assert.equal(estPayeeFournisseur(supplierItemFactice({ payment_status: "fully_paid", accounting_status: "complete", paid: true })), true);
  });

  // Non-régression du premier bug : `paid` reste à false sur des factures pourtant réglées.
  test("fully_paid ou paid_offline avec paid=false (y compris en attente de validation comptable) -> payée", () => {
    for (const payment_status of ["fully_paid", "paid_offline"]) {
      for (const accounting_status of ["complete", "validation_needed"]) {
        const item = supplierItemFactice({ payment_status, accounting_status, paid: false });
        assert.equal(candidatFactureFournisseur(item)!.payee, true, `${payment_status}/${accounting_status}`);
      }
    }
  });

  test("statuts de workflow (partiel, émis, planifié, en erreur...) -> suivent `paid`", () => {
    for (const payment_status of ["partially_paid", "payment_emitted", "payment_scheduled", "payment_in_progress", "payment_found", "payment_error"]) {
      assert.deepEqual(decisionPaiementFournisseur(supplierItemFactice({ payment_status, paid: false })), { payee: false, motifSolde: null, statutInconnu: null }, payment_status);
      assert.equal(decisionPaiementFournisseur(supplierItemFactice({ payment_status, paid: true })).payee, true, payment_status);
    }
  });

  test("statut inconnu -> jamais deviné : suit `paid`, et le statut est remonté", () => {
    const impayee = decisionPaiementFournisseur(supplierItemFactice({ payment_status: "statut_futur", paid: false }));
    assert.deepEqual(impayee, { payee: false, motifSolde: null, statutInconnu: "statut_futur" });
    const payee = decisionPaiementFournisseur(supplierItemFactice({ payment_status: "statut_futur", paid: true }));
    assert.deepEqual(payee, { payee: true, motifSolde: "payee", statutInconnu: "statut_futur" });
  });

  test("réponse sans payment_status -> booléen `paid`", () => {
    assert.equal(decisionPaiementFournisseur(supplierItemFactice({ paid: true })).payee, true);
    assert.deepEqual(decisionPaiementFournisseur(supplierItemFactice()), { payee: false, motifSolde: null, statutInconnu: null });
  });

  test("avoir fournisseur (montant négatif) -> jamais importé, quel que soit le statut", () => {
    assert.equal(candidatFactureFournisseur(supplierItemFactice({ amount: "-52.1", payment_status: "to_be_paid" })), null);
  });

  test("les statuts inconnus sont comptés pour être journalisés", () => {
    const { statutsInconnus } = candidatsFournisseursPennylane([
      supplierItemFactice({ id: 50, payment_status: "statut_futur" }),
      supplierItemFactice({ id: 51, payment_status: "statut_futur" }),
      supplierItemFactice({ id: 52, payment_status: "fully_paid" }),
    ]);
    assert.deepEqual(statutsInconnus, { statut_futur: 2 });
  });
});

// Une version archivée dans Pennylane n'est pas une facture de trésorerie : ni importée, ni
// marquée Payée, et retirée de Novanta si elle y est déjà.
describe("factures fournisseurs archivées", () => {
  test("archivée (accounting_status ou archived_at), paid true ou false -> candidat à retirer", () => {
    for (const paid of [true, false]) {
      const parStatut = candidatFactureFournisseur(supplierItemFactice({ payment_status: "to_be_paid", accounting_status: "archived", paid }));
      assert.equal(parStatut!.aRetirer, true);
      assert.equal(parStatut!.motifSolde, "archivee");
    }
    const parDate = candidatFactureFournisseur(supplierItemFactice({ accounting_status: "complete", archived_at: "2026-09-12T08:00:00Z" }));
    assert.equal(parDate!.aRetirer, true);
    assert.equal(candidatFactureFournisseur(supplierItemFactice({ accounting_status: "complete" }))!.aRetirer, undefined);
  });

  test("archivée absente de Novanta -> jamais importée, payée ou non", () => {
    for (const paid of [true, false]) {
      const { candidats } = candidatsFournisseursPennylane([supplierItemFactice({ id: 70, payment_status: "to_be_processed", accounting_status: "archived", paid })]);
      assert.deepEqual(calculerSynchronisation(candidats, []), { aInserer: [], idsAMettreAJourPayee: [], idsASupprimer: [] });
    }
  });

  test("facture importée active, puis archivée dans Pennylane -> retirée à la synchronisation suivante", () => {
    const active = supplierItemFactice({ id: 71, payment_status: "to_be_paid", accounting_status: "complete" });
    const premiere = calculerSynchronisation(candidatsFournisseursPennylane([active]).candidats, []);
    assert.deepEqual(premiere.aInserer.map((c) => c.pennylaneId), ["71"]);

    const archivee = supplierItemFactice({ id: 71, payment_status: "to_be_paid", accounting_status: "archived" });
    for (const payee of [false, true]) {
      const existantes: FactureExistantePourSync[] = [{ id: "novanta-71", pennylaneId: "71", payee }];
      const seconde = calculerSynchronisation(candidatsFournisseursPennylane([archivee]).candidats, existantes);
      assert.deepEqual(seconde, { aInserer: [], idsAMettreAJourPayee: [], idsASupprimer: ["novanta-71"] });
    }
  });

  test("version archivée + version active du même numéro -> chacune traitée par son identifiant", () => {
    const archivee = supplierItemFactice({ id: 3345, invoice_number: "9BEF-3925", payment_status: "to_be_processed", accounting_status: "archived" });
    const activePayee = supplierItemFactice({ id: 3350, invoice_number: "9BEF-3925", payment_status: "paid_offline", accounting_status: "complete" });
    const activeOuverte = supplierItemFactice({ id: 3351, invoice_number: "9BEF-3925", payment_status: "to_be_paid", accounting_status: "complete" });
    const existantes: FactureExistantePourSync[] = [{ id: "novanta-1", pennylaneId: "3345", payee: true }];
    const { candidats } = candidatsFournisseursPennylane([archivee, activePayee, activeOuverte]);
    const resultat = calculerSynchronisation(candidats, existantes);
    assert.deepEqual(resultat.aInserer.map((c) => c.pennylaneId), ["3351"]);
    assert.deepEqual(resultat.idsASupprimer, ["novanta-1"]);
  });

  test("facture client archivée -> jamais retirée (comportement client inchangé)", () => {
    const { candidats } = candidatsClientsPennylane([customerItemFactice({ id: 80, status: "cancelled" })]);
    const resultat = calculerSynchronisation(candidats, [{ id: "novanta-80", pennylaneId: "80", payee: false }]);
    assert.deepEqual(resultat, { aInserer: [], idsAMettreAJourPayee: ["novanta-80"], idsASupprimer: [] });
  });
});

describe("synchronisations successives — création puis mise à jour", () => {
  test("facture impayée importée, puis `paid` passe à true dans Pennylane -> marquée payée à la synchronisation suivante", () => {
    const impayee = supplierItemFactice({ id: 60, payment_status: "to_be_paid", accounting_status: "complete" });
    const premiere = calculerSynchronisation(candidatsFournisseursPennylane([impayee]).candidats, []);
    assert.deepEqual(premiere.aInserer.map((c) => c.pennylaneId), ["60"]);

    const existantes: FactureExistantePourSync[] = [{ id: "novanta-60", pennylaneId: "60", payee: false }];
    for (const reglee of [
      supplierItemFactice({ id: 60, payment_status: "to_be_processed", accounting_status: "complete", paid: true }),
      supplierItemFactice({ id: 60, payment_status: "paid_offline", accounting_status: "complete", paid: false }),
    ]) {
      const seconde = calculerSynchronisation(candidatsFournisseursPennylane([reglee]).candidats, existantes);
      assert.deepEqual(seconde, { aInserer: [], idsAMettreAJourPayee: ["novanta-60"], idsASupprimer: [] });
    }
  });

  test("facture payée dès la première synchronisation -> jamais créée", () => {
    const payee = supplierItemFactice({ id: 61, payment_status: "to_be_processed", accounting_status: "complete", paid: true });
    assert.deepEqual(calculerSynchronisation(candidatsFournisseursPennylane([payee]).candidats, []), { aInserer: [], idsAMettreAJourPayee: [], idsASupprimer: [] });
  });
});

describe("statut de paiement client — decisionPaiementClient", () => {
  test("status « paid » -> payée même si `paid` est false", () => {
    assert.equal(candidatFactureClient(customerItemFactice({ status: "paid", paid: false }))!.payee, true);
  });

  test("late, upcoming, partially_paid -> ouvertes", () => {
    for (const status of ["late", "upcoming", "partially_paid"]) {
      assert.equal(decisionPaiementClient(customerItemFactice({ status })).payee, false, status);
    }
  });

  test("archivée ou annulée -> soldée, motif « archivee »", () => {
    assert.equal(decisionPaiementClient(customerItemFactice({ status: "cancelled" })).motifSolde, "archivee");
    assert.equal(decisionPaiementClient(customerItemFactice({ status: "upcoming", archived_at: "2026-09-01T00:00:00Z" })).motifSolde, "archivee");
  });

  test("réponse sans status -> comportement inchangé (booléen `paid`)", () => {
    const { candidats } = candidatsClientsPennylane([customerItemFactice(), customerItemFactice({ id: 2, paid: true })]);
    assert.deepEqual(candidats.map((c) => c.payee), [false, true]);
  });
});
