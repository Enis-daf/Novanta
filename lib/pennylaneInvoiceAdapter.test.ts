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
  doublonsFournisseursEcartes,
  estAvoir,
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
  });
});

// Non-régression du bug « factures payées dans Pennylane importées comme impayées ». Les cas
// reprennent la forme de factures réelles (statuts, montants, reste à payer), sous des noms fictifs.
// Le booléen `paid` y est volontairement à false : c'est précisément le cas où il ne suffit pas.
describe("statut de paiement fournisseur — decisionPaiementFournisseur", () => {
  const fournisseur = { id: 501 };

  test("fully_paid -> payée", () => {
    const item = supplierItemFactice({ payment_status: "fully_paid", accounting_status: "complete" });
    assert.deepEqual(decisionPaiementFournisseur(item), { payee: true, motifSolde: "payee", statutInconnu: null });
    assert.equal(candidatFactureFournisseur(item)!.payee, true);
  });

  test("paid_offline -> payée, même si `paid` est false et que le reste à payer n'a pas été soldé", () => {
    const item = supplierItemFactice({ amount: "1000.0", payment_status: "paid_offline", accounting_status: "complete", paid: false });
    assert.equal(candidatFactureFournisseur(item)!.payee, true);
  });

  test("payée mais en attente de validation comptable (validation_needed) -> payée", () => {
    const item = supplierItemFactice({ payment_status: "fully_paid", accounting_status: "validation_needed", paid: false });
    assert.equal(candidatFactureFournisseur(item)!.payee, true);
  });

  test("facture réellement impayée (to_be_paid, to_be_processed) -> impayée", () => {
    for (const payment_status of ["to_be_paid", "to_be_processed"]) {
      const item = supplierItemFactice({ payment_status, accounting_status: "complete" });
      assert.deepEqual(decisionPaiementFournisseur(item), { payee: false, motifSolde: null, statutInconnu: null });
    }
  });

  test("partiellement payée -> reste ouverte (pas de reste à payer suivi en V1)", () => {
    const item = supplierItemFactice({ payment_status: "partially_paid", accounting_status: "complete" });
    assert.equal(candidatFactureFournisseur(item)!.payee, false);
  });

  test("paiement seulement émis, planifié ou en erreur -> reste ouverte", () => {
    for (const payment_status of ["payment_emitted", "payment_scheduled", "payment_in_progress", "payment_found", "payment_error"]) {
      const decision = decisionPaiementFournisseur(supplierItemFactice({ payment_status }));
      assert.equal(decision.payee, false, payment_status);
      assert.equal(decision.statutInconnu, null, payment_status);
    }
  });

  test("statut incohérent : to_be_processed alors que Pennylane dit paid=true (reste à payer 0) -> payée", () => {
    const item = supplierItemFactice({ payment_status: "to_be_processed", accounting_status: "complete", paid: true });
    assert.equal(decisionPaiementFournisseur(item).payee, true);
  });

  test("statut inconnu -> jamais deviné : suit `paid`, et le statut est remonté", () => {
    const impayee = decisionPaiementFournisseur(supplierItemFactice({ payment_status: "statut_futur", paid: false }));
    assert.deepEqual(impayee, { payee: false, motifSolde: null, statutInconnu: "statut_futur" });
    const payee = decisionPaiementFournisseur(supplierItemFactice({ payment_status: "statut_futur", paid: true }));
    assert.deepEqual(payee, { payee: true, motifSolde: "payee", statutInconnu: "statut_futur" });
  });

  test("ancienne réponse sans payment_status -> comportement inchangé (booléen `paid`)", () => {
    assert.equal(decisionPaiementFournisseur(supplierItemFactice({ paid: true })).payee, true);
    assert.deepEqual(decisionPaiementFournisseur(supplierItemFactice()), { payee: false, motifSolde: null, statutInconnu: null });
  });

  test("archivée (accounting_status ou archived_at) -> soldée, motif « archivee »", () => {
    const parStatut = supplierItemFactice({ payment_status: "to_be_processed", accounting_status: "archived" });
    assert.deepEqual(decisionPaiementFournisseur(parStatut), { payee: true, motifSolde: "archivee", statutInconnu: null });
    const parDate = supplierItemFactice({ payment_status: "to_be_paid", accounting_status: "complete", archived_at: "2026-09-12T08:00:00Z" });
    assert.equal(decisionPaiementFournisseur(parDate).motifSolde, "archivee");
  });

  test("avoir fournisseur (montant et reste à payer négatifs) -> jamais importé, quel que soit le statut", () => {
    assert.equal(candidatFactureFournisseur(supplierItemFactice({ amount: "-52.1", payment_status: "to_be_paid", supplier: fournisseur })), null);
  });
});

describe("factures fournisseurs en double — candidatsFournisseursPennylane", () => {
  const fournisseur = { id: 501 };

  test("version archivée impayée + version complète payée du même numéro -> aucune facture ouverte", () => {
    const archivee = supplierItemFactice({ id: 3345, invoice_number: "9BEF-3925", amount: "1221.96", supplier: fournisseur, payment_status: "to_be_processed", accounting_status: "archived" });
    const complete = supplierItemFactice({ id: 3350, invoice_number: "9BEF-3925", amount: "1221.96", supplier: fournisseur, payment_status: "paid_offline", accounting_status: "complete" });
    const { candidats } = candidatsFournisseursPennylane([archivee, complete]);
    assert.deepEqual(candidats.map((c) => [c.pennylaneId, c.payee, c.motifSolde]), [["3345", true, "archivee"], ["3350", true, "payee"]]);
    // Rien n'est importé...
    assert.deepEqual(calculerSynchronisation(candidats, []).aInserer, []);
    // ...et la version archivée déjà importée à tort comme impayée est soldée.
    const existantes: FactureExistantePourSync[] = [{ id: "novanta-1", pennylaneId: "3345", payee: false }];
    assert.deepEqual(calculerSynchronisation(candidats, existantes).idsAMettreAJourPayee, ["novanta-1"]);
  });

  test("version archivée + version complète réellement impayée -> une seule facture ouverte, la complète", () => {
    const archivee = supplierItemFactice({ id: 10, invoice_number: "F-77", supplier: fournisseur, payment_status: "to_be_paid", accounting_status: "archived" });
    const complete = supplierItemFactice({ id: 11, invoice_number: "F-77", supplier: fournisseur, payment_status: "to_be_paid", accounting_status: "complete" });
    const { candidats } = candidatsFournisseursPennylane([archivee, complete]);
    assert.deepEqual(calculerSynchronisation(candidats, []).aInserer.map((c) => c.pennylaneId), ["11"]);
  });

  test("deux versions non archivées impayées -> la plus aboutie est gardée, l'autre soldée comme doublon", () => {
    const aValider = supplierItemFactice({ id: 21, invoice_number: "F-88", supplier: fournisseur, payment_status: "to_be_paid", accounting_status: "validation_needed" });
    const complete = supplierItemFactice({ id: 20, invoice_number: "F-88", supplier: fournisseur, payment_status: "to_be_paid", accounting_status: "complete" });
    assert.deepEqual([...doublonsFournisseursEcartes([aValider, complete])], ["21"]);
    const { candidats } = candidatsFournisseursPennylane([aValider, complete]);
    assert.equal(candidats.find((c) => c.pennylaneId === "21")!.motifSolde, "doublon");
    assert.deepEqual(calculerSynchronisation(candidats, []).aInserer.map((c) => c.pennylaneId), ["20"]);
  });

  test("à statut comptable égal, la version la plus récente (identifiant le plus grand) est gardée", () => {
    const ancienne = supplierItemFactice({ id: 30, invoice_number: "F-99", supplier: fournisseur, accounting_status: "complete" });
    const recente = supplierItemFactice({ id: 31, invoice_number: "F-99", supplier: fournisseur, accounting_status: "complete" });
    assert.deepEqual([...doublonsFournisseursEcartes([ancienne, recente])], ["30"]);
  });

  test("même numéro chez deux fournisseurs différents, ou fournisseur inconnu -> pas un doublon", () => {
    const a = supplierItemFactice({ id: 40, invoice_number: "2026-001", supplier: { id: 1 } });
    const b = supplierItemFactice({ id: 41, invoice_number: "2026-001", supplier: { id: 2 } });
    const c = supplierItemFactice({ id: 42, invoice_number: "2026-001" });
    const d = supplierItemFactice({ id: 43, invoice_number: "2026-001" });
    assert.equal(doublonsFournisseursEcartes([a, b, c, d]).size, 0);
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

describe("synchronisations successives — création puis mise à jour", () => {
  test("facture impayée importée, puis payée dans Pennylane -> marquée payée à la synchronisation suivante", () => {
    const impayee = supplierItemFactice({ id: 60, payment_status: "to_be_paid", accounting_status: "complete" });
    const premiere = calculerSynchronisation(candidatsFournisseursPennylane([impayee]).candidats, []);
    assert.deepEqual(premiere.aInserer.map((c) => c.pennylaneId), ["60"]);

    const existantes: FactureExistantePourSync[] = [{ id: "novanta-60", pennylaneId: "60", payee: false }];
    const reglee = supplierItemFactice({ id: 60, payment_status: "paid_offline", accounting_status: "complete", paid: false });
    const seconde = calculerSynchronisation(candidatsFournisseursPennylane([reglee]).candidats, existantes);
    assert.deepEqual(seconde, { aInserer: [], idsAMettreAJourPayee: ["novanta-60"] });
  });

  test("facture payée dès la première synchronisation -> jamais créée", () => {
    const payee = supplierItemFactice({ id: 61, payment_status: "fully_paid", accounting_status: "validation_needed", paid: false });
    assert.deepEqual(calculerSynchronisation(candidatsFournisseursPennylane([payee]).candidats, []), { aInserer: [], idsAMettreAJourPayee: [] });
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
