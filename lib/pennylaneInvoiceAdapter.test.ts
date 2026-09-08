import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  calculerSynchronisation,
  candidatFactureClient,
  candidatFactureFournisseur,
  candidatVersFactureClient,
  candidatVersFactureFournisseur,
  CandidatFacturePennylane,
  estAvoir,
  extraireTiersEtNumero,
  FactureExistantePourSync,
  pennylanePayee,
} from "./pennylaneInvoiceAdapter";
import { PennylaneCustomerInvoiceDetail, PennylaneSupplierInvoiceListItem } from "./pennylaneClient";

function detailFactice(overrides: Partial<PennylaneCustomerInvoiceDetail> = {}): PennylaneCustomerInvoiceDetail {
  return {
    id: 28964101701632,
    number: "FA2609-0090",
    date: "2026-09-04",
    deadline: "2026-10-04",
    amount: "1680.0",
    draft: false,
    payment_status: "to_be_processed",
    customer_name: "SOCIETE D'EXPLOITATION EOLIENNE ANGRIE",
    ...overrides,
  };
}

function supplierItemFactice(overrides: Partial<PennylaneSupplierInvoiceListItem> = {}): PennylaneSupplierInvoiceListItem {
  return {
    id: 27218741563392,
    date: "2026-07-29",
    label: "Facture ENGISO - 12534 (label généré)",
    amount: "14270.0",
    deadline: "2026-08-28",
    payment_status: "to_be_paid",
    paid_at: null,
    ...overrides,
  };
}

describe("pennylanePayee — statut réel Pennylane -> booléen Novanta", () => {
  test("fully_paid -> payée", () => assert.equal(pennylanePayee("fully_paid"), true));
  test("paid_offline -> payée", () => assert.equal(pennylanePayee("paid_offline"), true));
  test("to_be_processed -> non payée", () => assert.equal(pennylanePayee("to_be_processed"), false));
  test("to_be_paid -> non payée", () => assert.equal(pennylanePayee("to_be_paid"), false));
  test("partially_paid -> non payée (paiement partiel, jamais considéré soldé)", () =>
    assert.equal(pennylanePayee("partially_paid"), false));
  test("payment_found -> non payée (rapprochement en cours, pas encore confirmé soldé)", () =>
    assert.equal(pennylanePayee("payment_found"), false));
  test("payment_emitted / payment_scheduled / payment_in_progress / payment_error -> non payée", () => {
    for (const statut of ["payment_emitted", "payment_scheduled", "payment_in_progress", "payment_error"]) {
      assert.equal(pennylanePayee(statut), false, statut);
    }
  });
});

describe("estAvoir — détection d'un avoir (montant négatif)", () => {
  test("montant négatif -> avoir", () => assert.equal(estAvoir("-19800.0"), true));
  test("montant positif -> pas un avoir", () => assert.equal(estAvoir("19800.0"), false));
  test("zéro -> pas un avoir", () => assert.equal(estAvoir("0"), false));
});

describe("candidatFactureClient — J. avoir, K. brouillon, cas normal", () => {
  test("facture normale, non payée -> candidat construit", () => {
    const candidat = candidatFactureClient(detailFactice());
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
      detailFactice({ id: 21494940622848, number: "AV2603-0004", amount: "-102886.56", customer_name: null })
    );
    assert.equal(candidat, null);
  });

  test("K. brouillon (draft: true) -> jamais importé", () => {
    const candidat = candidatFactureClient(detailFactice({ draft: true }));
    assert.equal(candidat, null);
  });

  test("facture payée (fully_paid) -> candidat construit avec payee=true (le tri import/no-op se fait dans calculerSynchronisation)", () => {
    const candidat = candidatFactureClient(detailFactice({ payment_status: "fully_paid" }));
    assert.equal(candidat!.payee, true);
  });

  test("customer_name absent -> libellé générique, jamais une chaîne vide", () => {
    const candidat = candidatFactureClient(detailFactice({ customer_name: null }));
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
    const r = extraireTiersEtNumero("Facture - 2026-3080464 (label généré)", "fallback");
    assert.equal(r.tiers, "Fournisseur Pennylane");
    assert.equal(r.numero, "2026-3080464");
  });

  test("libellé qui ne correspond à aucun motif connu -> repli sur le libellé complet", () => {
    const r = extraireTiersEtNumero("Un libellé personnalisé sans le motif habituel", "fallback-id");
    assert.equal(r.tiers, "Un libellé personnalisé sans le motif habituel");
    assert.equal(r.numero, "fallback-id");
  });

  test("libellé null -> repli générique, jamais une exception", () => {
    const r = extraireTiersEtNumero(null, "fallback-id");
    assert.equal(r.tiers, "Fournisseur Pennylane");
    assert.equal(r.numero, "fallback-id");
  });
});

describe("candidatFactureFournisseur", () => {
  test("facture normale -> candidat construit depuis la liste seule (payment_status déjà présent)", () => {
    const candidat = candidatFactureFournisseur(supplierItemFactice());
    assert.ok(candidat);
    assert.equal(candidat!.pennylaneId, "27218741563392");
    assert.equal(candidat!.facture, "12534");
    assert.equal(candidat!.tiers, "ENGISO");
    assert.equal(candidat!.montant, 14270);
    assert.equal(candidat!.payee, false); // to_be_paid n'est pas un statut "payée"
  });

  test("montant négatif (avoir, par cohérence même si non observé côté fournisseurs) -> jamais importé", () => {
    const candidat = candidatFactureFournisseur(supplierItemFactice({ amount: "-100" }));
    assert.equal(candidat, null);
  });

  test("payment_status fully_paid -> candidat payee=true", () => {
    const candidat = candidatFactureFournisseur(supplierItemFactice({ payment_status: "fully_paid" }));
    assert.equal(candidat!.payee, true);
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

    // Deuxième passage : la facture insérée existe maintenant côté Novanta.
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

  test("G. Pennylane redevient non payée après avoir été payée côté Novanta -> JAMAIS repassée à false (aucun id renvoyé pour repasser à false, la fonction ne le fait structurellement jamais)", () => {
    const resultat = calculerSynchronisation([candidat({ payee: false })], [existante({ payee: true })]);
    assert.deepEqual(resultat.aInserer, []);
    assert.deepEqual(resultat.idsAMettreAJourPayee, []);
    // La fonction ne renvoie que des ids à passer à true — aucun mécanisme de mise à false n'existe.
  });

  test("H/I. la mise à jour ne porte jamais que sur l'id -> aucune donnée de date/litigieuse ne peut être écrasée par construction", () => {
    const resultat = calculerSynchronisation([candidat({ payee: true })], [existante({ payee: false })]);
    assert.deepEqual(resultat.idsAMettreAJourPayee, ["novanta-1"]);
    // idsAMettreAJourPayee est un tableau de string (id) : aucune valeur de date/litigieuse n'y
    // transite, donc rien d'autre que "payee" ne peut jamais être patché par l'appelant.
  });

  test("M. factures client/fournisseur au même numéro -> aucune collision (le rapprochement se fait par pennylaneId, appelé séparément par type)", () => {
    // calculerSynchronisation est appelée une fois pour les clients et une fois pour les
    // fournisseurs (voir app/page.tsx) : deux ensembles de facturesExistantes totalement
    // indépendants, même si deux factures de types différents partagent le même numéro affiché.
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
      candidat({ pennylaneId: "nouveau-paye", payee: true }), // jamais importée
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
    assert.ok(facture.id); // un id Novanta est généré, jamais l'id Pennylane réutilisé comme id Novanta
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
