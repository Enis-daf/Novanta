import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  controlerCoherence,
  filtrerTransactionsRecentes,
  trierIssuesParImpact,
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
    payee: false,
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

describe("CAS A — paiement fractionné en plusieurs transactions", () => {
  test("facture Payée, réglée en 2 virements (66 000 + 7 000) au même tiers/référence : aucune anomalie", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesFournisseurs: [
          factureFournisseur({
            id: "ff-frac",
            fournisseur: "MegaCorp Industries",
            facture: "FA2607-0090",
            montant: 73000,
            payee: true,
            paidAt: "2026-08-15T10:00:00.000Z",
          }),
        ],
        transactions: [
          tx("2026-08-15", "VIR MEGACORP INDUSTRIES FA2607-0090 ACOMPTE", -66000),
          tx("2026-08-16", "VIR MEGACORP INDUSTRIES FA2607-0090 SOLDE", -7000),
        ],
      })
    );
    assert.equal(issuesDeType(resultat.issues, "invoice_paid_but_unmatched").length, 0);
  });

  test("même cas mais la facture n'est pas encore marquée Payée : propose Payée avec les 2 mouvements agrégés", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesFournisseurs: [
          factureFournisseur({ id: "ff-frac2", fournisseur: "MegaCorp Industries", facture: "FA2607-0090", montant: 73000, payee: false }),
        ],
        transactions: [
          tx("2026-08-15", "VIR MEGACORP INDUSTRIES FA2607-0090 ACOMPTE", -66000),
          tx("2026-08-16", "VIR MEGACORP INDUSTRIES FA2607-0090 SOLDE", -7000),
        ],
      })
    );
    const issues = issuesDeType(resultat.issues, "invoice_maybe_paid");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "strong");
    assert.equal(issues[0].transactions.length, 2);
  });

  test("2 montants qui s'additionnent au bon total mais SANS aucun lien de tiers/référence : jamais rapproché", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesFournisseurs: [
          factureFournisseur({ id: "ff-coincidence", fournisseur: "Boulangerie du Coin", facture: "FA-9999", montant: 73000, payee: false }),
        ],
        transactions: [tx("2026-08-15", "VIR SEPA XR ZZZ01", -66000), tx("2026-08-16", "PRLV SFR MOBILE", -7000)],
      })
    );
    assert.equal(issuesDeType(resultat.issues, "invoice_maybe_paid").length, 0);
  });

  test("3 virements dont la somme correspond, même tiers : reconnu (triplet)", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesFournisseurs: [
          factureFournisseur({ id: "ff-triplet", fournisseur: "MegaCorp Industries", facture: "FA2607-0090", montant: 73000, payee: false }),
        ],
        transactions: [
          tx("2026-08-14", "VIR MEGACORP INDUSTRIES FA2607-0090", -30000),
          tx("2026-08-15", "VIR MEGACORP INDUSTRIES FA2607-0090", -36000),
          tx("2026-08-16", "VIR MEGACORP INDUSTRIES FA2607-0090", -7000),
        ],
      })
    );
    const issues = issuesDeType(resultat.issues, "invoice_maybe_paid");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].transactions.length, 3);
  });
});

describe("CAS B — fenêtre J-30 : absence de match hors fenêtre = aucune conclusion", () => {
  test("aujourd'hui 01/09/2026, facture payée le 07/07/2026, aucune transaction analysée en juillet : aucune anomalie", () => {
    const resultat = controlerCoherence({
      transactions: [],
      facturesClients: [],
      facturesFournisseurs: [
        factureFournisseur({
          dateEcheance: "2026-07-07",
          datePaiementPrevue: "2026-07-07",
          payee: true,
          paidAt: "2026-07-07T10:00:00.000Z",
        }),
      ],
      autresDepenses: [],
      financements: [],
      dateReference: "2026-09-01",
    });
    assert.equal(issuesDeType(resultat.issues, "invoice_paid_but_unmatched").length, 0);
  });

  test("échéance réelle hors fenêtre (07/07) MAIS la case a été cochée aujourd'hui (paidAt récent) : toujours aucune anomalie — paidAt seul ne suffit pas à prouver que la fenêtre couvre le paiement", () => {
    const resultat = controlerCoherence({
      transactions: [],
      facturesClients: [],
      facturesFournisseurs: [
        factureFournisseur({
          dateEcheance: "2026-07-07",
          datePaiementPrevue: "2026-07-07",
          payee: true,
          paidAt: "2026-09-01T09:00:00.000Z", // coché aujourd'hui, mais la facture était déjà réglée en juillet
        }),
      ],
      autresDepenses: [],
      financements: [],
      dateReference: "2026-09-01",
    });
    assert.equal(issuesDeType(resultat.issues, "invoice_paid_but_unmatched").length, 0);
  });

  test("toutes les dates pertinentes tombent dans la fenêtre, aucun mouvement trouvé : l'anomalie reste générée (ne pas sur-corriger)", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesFournisseurs: [
          factureFournisseur({
            dateEcheance: "2026-08-19",
            datePaiementPrevue: "2026-08-19",
            payee: true,
            paidAt: "2026-08-19T10:00:00.000Z",
          }),
        ],
        transactions: [],
      })
    );
    const issues = issuesDeType(resultat.issues, "invoice_paid_but_unmatched");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "informational");
  });
});

describe("CAS C — rapprochement de référence partielle (suffixe) + tiers", () => {
  test("TILLIERES / FA2607-0070 : la banque ne garde que le suffixe '0070' et répète le tiers — reconnu, aucune anomalie", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesFournisseurs: [
          factureFournisseur({
            fournisseur: "TILLIERES O&M Sem2",
            facture: "FA2607-0070",
            montant: 4500,
            dateEcheance: "2026-08-19",
            datePaiementPrevue: "2026-08-19",
            payee: true,
            paidAt: "2026-08-19T10:00:00.000Z",
          }),
        ],
        transactions: [
          tx(
            "2026-08-19",
            "VIREMENT EN VOTRE FAVEUR FERME EOLIENNE TILLIERES TILLIER TILLIERES QANNT 0070 060726 TILLIERES QANNT 0070 060726",
            -4500
          ),
        ],
      })
    );
    assert.equal(issuesDeType(resultat.issues, "invoice_paid_but_unmatched").length, 0);
  });

  test("le suffixe seul, SANS aucun token de tiers compatible, ne suffit jamais à rapprocher", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesFournisseurs: [
          factureFournisseur({ fournisseur: "TILLIERES O&M Sem2", facture: "FA2607-0070", montant: 4500, payee: false }),
        ],
        // "0070" apparaît par pure coïncidence dans un libellé totalement sans rapport
        transactions: [tx("2026-08-19", "PRLV EDF ENERGIE REF 0070 CONTRAT", -4500)],
      })
    );
    assert.equal(issuesDeType(resultat.issues, "invoice_maybe_paid").length, 0);
  });

  test("deux fournisseurs différents portant chacun le même suffixe de référence, une seule transaction : seule la bonne facture est proposée", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesFournisseurs: [
          factureFournisseur({ id: "ff-x", fournisseur: "TILLIERES O&M Sem2", facture: "FA2607-0070", montant: 4500, payee: false }),
          factureFournisseur({ id: "ff-y", fournisseur: "Noxbat", facture: "FA9999-0070", montant: 4500, payee: false }),
        ],
        transactions: [tx("2026-08-19", "VIR TILLIERES QANNT 0070", -4500)],
      })
    );
    const issues = issuesDeType(resultat.issues, "invoice_maybe_paid");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].entityId, "ff-x");
  });
});

describe("CAS D — financements : terminologie de déblocage de prêt", () => {
  test("prêt FOSTER Crédit Agricole / 'REALISATION DE PRET ... DEBLOCAGE' : reconnu sans exiger 'CREDIT AGRICOLE' dans le libellé bancaire", () => {
    const resultat = controlerCoherence(
      parametresVides({
        financements: [
          financement({ libelle: "prêt FOSTER CREDIT AGRICOLE Languedoc", montant: 100000, dateEncaissementPrevue: "2026-08-19", verse: false }),
        ],
        transactions: [tx("2026-08-19", "REALISATION DE PRET 00007331996 DEBLOCAGE 03/08/26", 100000)],
      })
    );
    const issues = issuesDeType(resultat.issues, "financing_maybe_received");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "strong");
    assert.equal(issues[0].actionPossible?.label, "Marquer comme Versé");
  });

  test("terminologie de prêt présente mais montant incompatible : pas de match", () => {
    const resultat = controlerCoherence(
      parametresVides({
        financements: [financement({ libelle: "Prêt X", montant: 100000, dateEncaissementPrevue: "2026-08-19", verse: false })],
        transactions: [tx("2026-08-19", "REALISATION DE PRET DEBLOCAGE", 5000)],
      })
    );
    assert.equal(issuesDeType(resultat.issues, "financing_maybe_received").length, 0);
  });

  test("un crédit du bon montant SANS terminologie de prêt et sans tiers compatible : pas de match (le montant seul ne suffit jamais)", () => {
    const resultat = controlerCoherence(
      parametresVides({
        financements: [financement({ libelle: "prêt FOSTER CREDIT AGRICOLE Languedoc", montant: 100000, dateEncaissementPrevue: "2026-08-19", verse: false })],
        transactions: [tx("2026-08-19", "VIR CLIENT DIVERS FACTURE", 100000)],
      })
    );
    assert.equal(issuesDeType(resultat.issues, "financing_maybe_received").length, 0);
  });
});

describe("Financements — cas FOSTER exact (spec) + terminologie élargie + ambiguïté multi-financements", () => {
  test("prêt FOSTER CREDIT AGRICOLE Languedoc / REALISATION DE PRET 00007331996 DEBLOCAGE 03/08/26, Versé=false : proposer Marquer comme Versé", () => {
    const resultat = controlerCoherence(
      parametresVides({
        financements: [
          financement({ libelle: "prêt FOSTER CREDIT AGRICOLE Languedoc", montant: 200000, dateEncaissementPrevue: "2026-08-02", verse: false }),
        ],
        transactions: [tx("2026-08-03", "REALISATION DE PRET 00007331996 DEBLOCAGE 03/08/26", 200000)],
      })
    );
    const issues = issuesDeType(resultat.issues, "financing_maybe_received");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "strong");
    assert.equal(issues[0].actionPossible?.label, "Marquer comme Versé");
  });

  test("même cas mais Versé=true : aucune anomalie (le mouvement correspondant est bien retrouvé)", () => {
    const resultat = controlerCoherence(
      parametresVides({
        financements: [
          financement({ libelle: "prêt FOSTER CREDIT AGRICOLE Languedoc", montant: 200000, dateEncaissementPrevue: "2026-08-02", verse: true }),
        ],
        transactions: [tx("2026-08-03", "REALISATION DE PRET 00007331996 DEBLOCAGE 03/08/26", 200000)],
      })
    );
    assert.equal(issuesDeType(resultat.issues, "financing_received_but_unmatched").length, 0);
  });

  test("A. même montant mais libellé 'VIREMENT CLIENT' : pas classé automatiquement comme prêt", () => {
    const resultat = controlerCoherence(
      parametresVides({
        financements: [financement({ libelle: "prêt FOSTER CREDIT AGRICOLE Languedoc", montant: 200000, verse: false })],
        transactions: [tx("2026-08-19", "VIREMENT CLIENT FACTURE DIVERS", 200000)],
      })
    );
    assert.equal(issuesDeType(resultat.issues, "financing_maybe_received").length, 0);
  });

  test("B. 'REALISATION DE PRET' mais mauvais montant : pas de match fort", () => {
    const resultat = controlerCoherence(
      parametresVides({
        financements: [financement({ libelle: "prêt FOSTER CREDIT AGRICOLE Languedoc", montant: 200000, verse: false })],
        transactions: [tx("2026-08-19", "REALISATION DE PRET 00099999 DEBLOCAGE", 50000)],
      })
    );
    assert.equal(issuesDeType(resultat.issues, "financing_maybe_received").length, 0);
  });

  test("C. deux financements de même montant : la transaction unique ne les matche pas tous les deux en 'fort' — ramené à 'possible'", () => {
    const resultat = controlerCoherence(
      parametresVides({
        financements: [
          financement({ id: "fin-un", libelle: "Prêt Un", montant: 50000, verse: false }),
          financement({ id: "fin-deux", libelle: "Prêt Deux", montant: 50000, verse: false }),
        ],
        transactions: [tx("2026-08-19", "REALISATION DE PRET DEBLOCAGE", 50000)],
      })
    );
    const issues = issuesDeType(resultat.issues, "financing_maybe_received");
    assert.equal(issues.length, 2); // les deux sont remontés, mais aucun n'est affirmé "fort"
    assert.ok(issues.every((i) => i.severity === "possible"));
  });

  test("terminologie élargie : 'MISE A DISPOSITION' est reconnue comme un déblocage de financement", () => {
    const resultat = controlerCoherence(
      parametresVides({
        financements: [financement({ libelle: "Emprunt Société Générale", montant: 30000, verse: false })],
        transactions: [tx("2026-08-19", "MISE A DISPOSITION DE FONDS REF 4471982", 30000)],
      })
    );
    const issues = issuesDeType(resultat.issues, "financing_maybe_received");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "strong");
  });

  test("terminologie élargie : 'CREDIT' seul (montant + date cohérents) suffit", () => {
    const resultat = controlerCoherence(
      parametresVides({
        financements: [financement({ libelle: "Financement BNP", montant: 45000, verse: false })],
        transactions: [tx("2026-08-19", "CREDIT COMPTE COURTAGE REF 8823", 45000)],
      })
    );
    const issues = issuesDeType(resultat.issues, "financing_maybe_received");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "strong");
  });

  test("un match par tiers/référence n'est jamais requalifié 'possible', même si un autre financement (par simple terminologie) cible la même transaction", () => {
    const resultat = controlerCoherence(
      parametresVides({
        financements: [
          // Cite explicitement "BPIFRANCE" : signal de tiers propre à CETTE ligne, pas seulement la
          // terminologie générique — reste "fort" quoi qu'il arrive.
          financement({ id: "fin-nomme", libelle: "Prêt Bpifrance Innovation", montant: 50000, verse: false }),
          // Aucun signal propre : ne matche que via la terminologie générique partagée avec l'autre —
          // ambigu, ramené à "possible".
          financement({ id: "fin-autre", libelle: "Avance associé", montant: 50000, verse: false }),
        ],
        transactions: [tx("2026-08-19", "VIR BPIFRANCE INNOVATION PRET", 50000)],
      })
    );
    const issues = issuesDeType(resultat.issues, "financing_maybe_received");
    const nomme = issues.find((i) => i.entityId === "fin-nomme");
    const autre = issues.find((i) => i.entityId === "fin-autre");
    assert.equal(nomme?.severity, "strong");
    assert.equal(autre?.severity, "possible");
  });
});

describe("CAS E — faux match sur montant seul (régression)", () => {
  test("deux factures au même montant, une seule transaction sans tiers/référence identifiable pour aucune des deux : ne rapproche ni l'une ni l'autre", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesFournisseurs: [
          factureFournisseur({ id: "ff-e1", fournisseur: "Société Un", facture: "FA-E1", montant: 3000, payee: false }),
          factureFournisseur({ id: "ff-e2", fournisseur: "Société Deux", facture: "FA-E2", montant: 3000, payee: false }),
        ],
        transactions: [tx("2026-08-19", "VIR SEPA REF INCONNUE", -3000)],
      })
    );
    assert.equal(issuesDeType(resultat.issues, "invoice_maybe_paid").length, 0);
  });
});

describe("trierIssuesParImpact — tri purement visuel par impact cash décroissant", () => {
  function issue(montant: number, date: string | null, libelle: string): ConsistencyIssue {
    return {
      id: `${libelle}-${montant}`,
      type: "invoice_maybe_paid",
      severity: "strong",
      entityType: "facture_fournisseur",
      entityId: "x",
      transactions: [],
      message: "m",
      raison: "r",
      actionPossible: null,
      donneesAffichage: { libelle, montant, date },
    };
  }

  test("trie par montant absolu décroissant, quel que soit le signe", () => {
    const issues = [issue(-500, "2026-08-01", "A"), issue(2000, "2026-08-01", "B"), issue(-1000, "2026-08-01", "C")];
    const tries = trierIssuesParImpact(issues);
    assert.deepEqual(tries.map((i) => i.donneesAffichage.libelle), ["B", "C", "A"]);
  });

  test("à montant égal : date la plus récente d'abord", () => {
    const issues = [issue(1000, "2026-08-01", "Ancienne"), issue(1000, "2026-08-20", "Récente")];
    const tries = trierIssuesParImpact(issues);
    assert.deepEqual(tries.map((i) => i.donneesAffichage.libelle), ["Récente", "Ancienne"]);
  });

  test("à montant et date égaux : libellé alphabétique", () => {
    const issues = [issue(1000, "2026-08-01", "Zèbre"), issue(1000, "2026-08-01", "Alpha")];
    const tries = trierIssuesParImpact(issues);
    assert.deepEqual(tries.map((i) => i.donneesAffichage.libelle), ["Alpha", "Zèbre"]);
  });

  test("ne mute pas le tableau d'origine", () => {
    const issues = [issue(500, "2026-08-01", "A"), issue(2000, "2026-08-01", "B")];
    const original = [...issues];
    trierIssuesParImpact(issues);
    assert.deepEqual(issues, original);
  });

  test("purement visuel : controlerCoherence lui-même n'est pas trié en interne (ordre par type de contrôle)", () => {
    const resultat = controlerCoherence(
      parametresVides({
        facturesFournisseurs: [factureFournisseur({ montant: 500, facture: "FA2607-0077" })],
        transactions: [
          tx("2026-08-19", "VIR NOXBAT FA2607-0077", -500),
          tx("2026-08-19", "VIR BPIFRANCE PRET", 20000),
        ],
        financements: [financement({ libelle: "Prêt Bpifrance", montant: 20000, verse: false })],
      })
    );
    // le résultat brut n'est pas garanti trié par montant (la facture à 500 sort avant le financement
    // à 20000 car controlerFacturesFournisseurs est appelé avant controlerFinancements)
    assert.equal(resultat.issues[0].donneesAffichage.montant, 500);
    // trierIssuesParImpact, lui, remet bien le plus gros montant en premier
    const tries = trierIssuesParImpact(resultat.issues);
    assert.equal(tries[0].donneesAffichage.montant, 20000);
  });
});
