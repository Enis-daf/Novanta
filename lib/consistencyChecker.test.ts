import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  controlerCoherence,
  filtrerTransactionsRecentes,
  ConsistencyIssue,
  ParametresControleCoherence,
} from "./consistencyChecker";
import { normaliserLibelleBancaire } from "./bankTransaction";
import { NormalizedBankTransaction } from "./bankTransaction";
import { AutreDepense, FactureClient, FactureFournisseur, Financement } from "./types";

const DATE_REF = "2026-08-31";

function tx(date: string, labelOriginal: string, signedAmount: number): NormalizedBankTransaction {
  return { date, labelOriginal, labelNormalized: normaliserLibelleBancaire(labelOriginal), signedAmount };
}

function factureFournisseur(overrides: Partial<FactureFournisseur> = {}): FactureFournisseur {
  return {
    id: "ff-1",
    facture: "FA2607-0077",
    fournisseur: "Noxbat",
    montant: 4950,
    dateEcheance: "2026-08-19",
    datePaiementPrevue: "2026-08-19",
    litigieuse: false,
    payee: false,
    paidAt: null,
    ...overrides,
  };
}

function factureClient(overrides: Partial<FactureClient> = {}): FactureClient {
  return {
    id: "fc-1",
    facture: "FAC-100",
    client: "Client Un",
    montant: 1000,
    dateEcheance: "2026-08-19",
    dateEncaissementAnticipee: "2026-08-19",
    litigieuse: false,
    payee: false,
    paidAt: null,
    ...overrides,
  };
}

function autreDepense(overrides: Partial<AutreDepense> = {}): AutreDepense {
  return {
    id: "ad-1",
    libelle: "Fournitures",
    montant: 500,
    datePrevue: "2026-08-19",
    type: "certaine",
    facturee: false,
    ...overrides,
  };
}

function financement(overrides: Partial<Financement> = {}): Financement {
  return {
    id: "fin-1",
    libelle: "Prêt banque",
    montant: 20000,
    dateEncaissementPrevue: "2026-08-19",
    verse: false,
    ...overrides,
  };
}

function parametresVides(overrides: Partial<ParametresControleCoherence> = {}): ParametresControleCoherence {
  return {
    transactions: [],
    facturesClients: [],
    facturesFournisseurs: [],
    autresDepenses: [],
    financements: [],
    dateReference: DATE_REF,
    ...overrides,
  };
}

function issuesDeType(issues: ConsistencyIssue[], type: ConsistencyIssue["type"]): ConsistencyIssue[] {
  return issues.filter((i) => i.type === type);
}

describe("filtrerTransactionsRecentes — fenêtre 30 jours calendaires glissante", () => {
  test("K. transaction à J-31 : ignorée", () => {
    const transactions = [tx("2026-07-31", "VIR TEST", -100)];
    assert.equal(filtrerTransactionsRecentes(transactions, DATE_REF).length, 0);
  });

  test("L. transaction à J-29 : analysée (borne incluse)", () => {
    const transactions = [tx("2026-08-02", "VIR TEST", -100)];
    assert.equal(filtrerTransactionsRecentes(transactions, DATE_REF).length, 1);
  });

  test("transaction exactement à la date de référence (J-0) : analysée", () => {
    const transactions = [tx(DATE_REF, "VIR TEST", -100)];
    assert.equal(filtrerTransactionsRecentes(transactions, DATE_REF).length, 1);
  });

  test("transaction à J-30 (juste avant la fenêtre) : ignorée", () => {
    const transactions = [tx("2026-08-01", "VIR TEST", -100)];
    assert.equal(filtrerTransactionsRecentes(transactions, DATE_REF).length, 0);
  });
});

describe("controlerCoherence — factures fournisseurs / clients", () => {
  test("A. montant + référence facture retrouvée dans le libellé : alerte forte", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesFournisseurs: [factureFournisseur()],
        transactions: [tx("2026-08-19", "VIR NOXBAT FA2607-0077", -4950)],
      })
    );
    const issues = issuesDeType(resultat.issues, "invoice_maybe_paid");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "strong");
    assert.equal(issues[0].entityId, "ff-1");
    assert.equal(issues[0].actionPossible?.label, "Marquer comme Payée");
  });

  test("B. deux factures au même montant, transaction sans tiers ni référence identifiable : aucun choix arbitraire sur le seul montant", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesFournisseurs: [
          factureFournisseur({ id: "ff-a", fournisseur: "Fournisseur Alpha", facture: "FA-AAA", montant: 2100 }),
          factureFournisseur({ id: "ff-b", fournisseur: "Fournisseur Beta", facture: "FA-BBB", montant: 2100 }),
        ],
        transactions: [tx("2026-08-19", "VIR SEPA XR ZZZ01", -2100)],
      })
    );
    assert.equal(issuesDeType(resultat.issues, "invoice_maybe_paid").length, 0);
  });

  test("B (bis). le même cas, mais le libellé cite un des deux tiers : seule cette facture est proposée", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesFournisseurs: [
          factureFournisseur({ id: "ff-a", fournisseur: "Fournisseur Alpha", facture: "FA-AAA", montant: 2100 }),
          factureFournisseur({ id: "ff-b", fournisseur: "Fournisseur Beta", facture: "FA-BBB", montant: 2100 }),
        ],
        transactions: [tx("2026-08-19", "VIR FOURNISSEUR ALPHA", -2100)],
      })
    );
    const issues = issuesDeType(resultat.issues, "invoice_maybe_paid");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].entityId, "ff-a");
  });

  test("C. léger écart de montant (dans la tolérance) mais référence identique : match accepté", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesFournisseurs: [factureFournisseur({ montant: 1000, facture: "FA-1000" })],
        transactions: [tx("2026-08-19", "VIR NOXBAT FA-1000", -1000.45)],
      })
    );
    const issues = issuesDeType(resultat.issues, "invoice_maybe_paid");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "strong");
  });

  test("écart de montant hors tolérance : aucun match", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesFournisseurs: [factureFournisseur({ montant: 1000, facture: "FA-1000" })],
        transactions: [tx("2026-08-19", "VIR NOXBAT FA-1000", -1004)],
      })
    );
    assert.equal(issuesDeType(resultat.issues, "invoice_maybe_paid").length, 0);
  });

  test("D. facture Payée = true récemment, aucune transaction correspondante dans J-30 : information faible uniquement", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesFournisseurs: [
          factureFournisseur({ payee: true, paidAt: "2026-08-19T10:00:00.000Z" }),
        ],
        transactions: [],
      })
    );
    const issues = issuesDeType(resultat.issues, "invoice_paid_but_unmatched");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "informational");
    assert.equal(issues[0].actionPossible, null);
  });

  test("facture Payée = true dont le paiement est ANTÉRIEUR à la fenêtre : aucune conclusion, pas d'issue", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesFournisseurs: [factureFournisseur({ payee: true, paidAt: "2026-07-10T10:00:00.000Z" })],
        transactions: [],
      })
    );
    assert.equal(issuesDeType(resultat.issues, "invoice_paid_but_unmatched").length, 0);
  });

  test("facture client encaissée : même logique de match (crédit)", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesClients: [factureClient({ facture: "FAC-100", client: "Client Un", montant: 1000 })],
        transactions: [tx("2026-08-19", "VIR CLIENT UN FAC-100", 1000)],
      })
    );
    const issues = issuesDeType(resultat.issues, "invoice_maybe_paid");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].entityType, "facture_client");
  });

  test("le sens du montant compte : un débit ne matche jamais une facture client (créance)", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesClients: [factureClient({ facture: "FAC-100", client: "Client Un", montant: 1000 })],
        transactions: [tx("2026-08-19", "VIR CLIENT UN FAC-100", -1000)],
      })
    );
    assert.equal(issuesDeType(resultat.issues, "invoice_maybe_paid").length, 0);
  });
});

describe("controlerCoherence — autres dépenses", () => {
  test("E. dépense non facturée avec facture fournisseur correspondante : proposer Facturée", () => {
    const resultat = controlerCoherence(
      parametresVides({
        autresDepenses: [autreDepense({ libelle: "Kubii", montant: 300, facturee: false })],
        facturesFournisseurs: [factureFournisseur({ fournisseur: "Kubii", montant: 300 })],
      })
    );
    const issues = issuesDeType(resultat.issues, "other_expense_maybe_invoiced");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].actionPossible?.label, "Marquer comme Facturée");
  });

  test("F. dépense marquée Facturée sans facture fournisseur correspondante : alerte faible, pas d'action", () => {
    const resultat = controlerCoherence(
      parametresVides({
        autresDepenses: [autreDepense({ libelle: "Divers", montant: 300, facturee: true })],
        facturesFournisseurs: [],
      })
    );
    const issues = issuesDeType(resultat.issues, "other_expense_invoiced_but_missing_invoice");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "informational");
    assert.equal(issues[0].actionPossible, null);
  });
});

describe("controlerCoherence — financements", () => {
  test("G. financement non versé avec crédit bancaire correspondant : proposer Versé", () => {
    const resultat = controlerCoherence(
      parametresVides({
        financements: [financement({ libelle: "Prêt Bpifrance", montant: 20000, verse: false })],
        transactions: [tx("2026-08-19", "VIR BPIFRANCE PRET", 20000)],
      })
    );
    const issues = issuesDeType(resultat.issues, "financing_maybe_received");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].actionPossible?.label, "Marquer comme Versé");
  });

  test("H. financement Versé = true sans mouvement dans J-30 (date prévue dans la fenêtre) : signal faible", () => {
    const resultat = controlerCoherence(
      parametresVides({
        financements: [
          financement({ libelle: "Prêt Bpifrance", montant: 20000, verse: true, dateEncaissementPrevue: "2026-08-19" }),
        ],
        transactions: [],
      })
    );
    const issues = issuesDeType(resultat.issues, "financing_received_but_unmatched");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "informational");
  });

  test("financement Versé = true dont la date prévue est hors fenêtre : pas d'issue (rien à vérifier ici)", () => {
    const resultat = controlerCoherence(
      parametresVides({
        financements: [
          financement({ libelle: "Prêt Bpifrance", montant: 20000, verse: true, dateEncaissementPrevue: "2026-05-01" }),
        ],
        transactions: [],
      })
    );
    assert.equal(issuesDeType(resultat.issues, "financing_received_but_unmatched").length, 0);
  });
});

describe("controlerCoherence — doublons bancaires", () => {
  test("I. même date + même montant + même libellé normalisé : doublon potentiel", () => {
    const resultat = controlerCoherence(
      parametresVides({
        transactions: [tx("2026-08-26", "VIREMENT TEST SARL", -15000), tx("2026-08-26", "VIREMENT TEST SARL", -15000)],
      })
    );
    const issues = issuesDeType(resultat.issues, "bank_duplicate_candidate");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].transactions.length, 2);
  });

  test("J. même montant + même libellé mais mois différents : PAS un doublon", () => {
    const resultat = controlerCoherence(
      parametresVides({
        transactions: [tx("2026-08-05", "PRLV OVH SAS", -128), tx("2026-08-05", "PRLV OVH SAS", -128)],
      })
    );
    // Un seul groupe (même jour) doit ressortir ; en ajoutant une occurrence un autre jour, on ne
    // doit pas la voir fusionnée dans le même doublon.
    const resultat2 = controlerCoherence(
      parametresVides({
        transactions: [
          tx("2026-08-05", "PRLV OVH SAS", -128),
          tx("2026-08-05", "PRLV OVH SAS", -128),
          tx("2026-08-25", "PRLV OVH SAS", -128),
        ],
      })
    );
    assert.equal(issuesDeType(resultat.issues, "bank_duplicate_candidate").length, 1);
    const issues2 = issuesDeType(resultat2.issues, "bank_duplicate_candidate");
    assert.equal(issues2.length, 1);
    assert.equal(issues2[0].transactions.length, 2); // la 3e occurrence (jour différent) n'est jamais incluse
  });
});

describe("controlerCoherence — métadonnées de résultat", () => {
  test("compte le total du fichier et le sous-ensemble analysé séparément", () => {
    const resultat = controlerCoherence(
      parametresVides({
        transactions: [
          tx("2026-01-01", "ANCIEN", -10), // hors fenêtre
          tx("2026-08-15", "RECENT", -10), // dans la fenêtre
        ],
      })
    );
    assert.equal(resultat.totalTransactions, 2);
    assert.equal(resultat.transactionsAnalysees, 1);
    assert.deepEqual(resultat.periodeAnalysee, { debut: "2026-08-02", fin: "2026-08-31" });
  });

  test("aucune transaction dans la fenêtre : periodeAnalysee est null", () => {
    const resultat = controlerCoherence(parametresVides({ transactions: [tx("2026-01-01", "ANCIEN", -10)] }));
    assert.equal(resultat.transactionsAnalysees, 0);
    assert.equal(resultat.periodeAnalysee, null);
  });
});
