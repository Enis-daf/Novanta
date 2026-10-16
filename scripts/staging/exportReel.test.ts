import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ExportInvalide, Jeu, lireExport, preparerExportReel, TABLES_DONNEES } from "./exportReel";
import { chargesFixesSynthetiques, jeuSynthetique } from "./fixtures";

// Export fictif, de même forme que le résultat de scripts/staging/export-qannt.sql.
function exportFictif(): Jeu {
  return {
    cash_settings: { company_id: "soc-origine", solde_initial: 228100, date_releve: "2026-10-13", horizon_jours: 90, updated_at: "2026-10-13T08:00:00Z" },
    fixed_charges: [
      { id: "ch-salaires", company_id: "soc-origine", libelle: "Salaires (personnel à juillet 2026)", montant: 43947.94, date_prevue: "2026-07-28", recurrence: "mensuel", date_fin: null, mode_montant: "fixe", taux_calcul: null, source_calcul_id: null, source_calcul_type: null, a_couper: false, updated_at: "x" },
      { id: "ch-urssaf", company_id: "soc-origine", libelle: "URSSAF", montant: 0, date_prevue: "2026-08-15", recurrence: "mensuel", date_fin: "2027-01-15", mode_montant: "calcule", taux_calcul: 45, source_calcul_id: "ch-salaires", source_calcul_type: "charge_fixe", a_couper: true, updated_at: "x" },
    ],
    recurring_income: [{ id: "re-1", company_id: "soc-origine", libelle: "Abonnements", montant: 1200, date_debut: "2026-10-01", frequence: "mensuel", date_fin: null, mode_montant: "fixe", profil_saisonnalite: null, updated_at: "x" }],
    supplier_invoices: [
      { id: "ff-1", company_id: "soc-origine", facture: "CRO-2026-10", fournisseur: "Crocatus SAS", montant: 1990, date_echeance: "2026-10-15", date_paiement_prevue: "2026-10-30", litigieuse: false, paid: false, paid_at: null, pennylane_id: null, updated_at: "x" },
      { id: "ff-2", company_id: "soc-origine", facture: "EDF-88", fournisseur: "EDF", montant: 412.5, date_echeance: null, date_paiement_prevue: null, litigieuse: true, paid: true, paid_at: "2026-10-01T09:00:00Z", pennylane_id: "123456", updated_at: "x" },
    ],
    customer_invoices: [
      { id: "fc-1", company_id: "soc-origine", facture: "FA2609-0090", client: "Société d'Exploitation Éolienne Angrie", montant: 19800, date_echeance: "2026-10-20", date_encaissement_anticipee: "2026-11-05", litigieuse: false, paid: false, paid_at: null, pennylane_id: "777", updated_at: "x" },
      { id: "fc-2", company_id: "soc-origine", facture: "FA2609-0091", client: "Mairie de Nantes", montant: 5400, date_echeance: "2026-09-30", date_encaissement_anticipee: "2026-09-30", litigieuse: true, paid: true, paid_at: "2026-10-02T10:00:00Z", pennylane_id: null, updated_at: "x" },
      // Un vrai client peut s'appeler ainsi : la valeur doit passer telle quelle.
      { id: "fc-3", company_id: "soc-origine", facture: "FC-0001", client: "Client 01", montant: 100, date_echeance: "2026-10-01", date_encaissement_anticipee: "2026-10-01", litigieuse: false, paid: false, paid_at: null, pennylane_id: null, updated_at: "x" },
    ],
    other_expenses: [{ id: "ad-1", company_id: "soc-origine", libelle: "Salon professionnel", montant: 3500, date_prevue: "2026-11-12", type: "probable", facturee: false, payee: false, updated_at: "x" }],
    financings: [{ id: "fi-1", company_id: "soc-origine", libelle: "Prêt Karmen", montant: 50000, date_encaissement_prevue: "2026-10-28", verse: false, updated_at: "x" }],
  };
}

let compteur = 0;
const uuidPrevisible = () => `nouveau-${++compteur}`;

const TECHNIQUES = new Set(["id", "company_id", "updated_at", "source_calcul_id"]);
const metier = (ligne: Record<string, unknown>) => Object.fromEntries(Object.entries(ligne).filter(([colonne]) => !TECHNIQUES.has(colonne)));

describe("import d'un export réel : données métier conservées telles quelles", () => {
  const source = exportFictif();
  const prepare = preparerExportReel(exportFictif(), uuidPrevisible);

  test("toutes les tables, toutes les lignes, dans le même ordre", () => {
    for (const table of TABLES_DONNEES) assert.equal(prepare[table].length, source[table].length, table);
  });

  test("chaque colonne métier de chaque ligne est identique à la source", () => {
    for (const table of TABLES_DONNEES) {
      source[table].forEach((ligne, index) => assert.deepEqual(metier(prepare[table][index]), metier(ligne), `${table}[${index}]`));
    }
    assert.deepEqual(prepare.cash_settings, { solde_initial: 228100, date_releve: "2026-10-13", horizon_jours: 90 });
  });

  test("noms de clients et numéros de factures clients : valeurs d'origine", () => {
    assert.deepEqual(prepare.customer_invoices.map((f) => f.client), ["Société d'Exploitation Éolienne Angrie", "Mairie de Nantes", "Client 01"]);
    assert.deepEqual(prepare.customer_invoices.map((f) => f.facture), ["FA2609-0090", "FA2609-0091", "FC-0001"]);
  });

  test("aucun « Client NN » ni « FC-NNNN » n'est fabriqué : seuls ceux de la source existent", () => {
    const motifs = (jeu: Jeu) => JSON.stringify(jeu).match(/Client \d+|FC-\d+/g) ?? [];
    assert.deepEqual(motifs(prepare), motifs(source));
    assert.deepEqual(motifs(prepare), ["FC-0001", "Client 01"]);

    const sansHomonyme = exportFictif();
    sansHomonyme.customer_invoices = sansHomonyme.customer_invoices.slice(0, 2);
    assert.deepEqual(motifs(preparerExportReel(sansHomonyme, uuidPrevisible)), []);
  });

  test("fournisseurs, libellés, montants, dates et statuts : valeurs d'origine", () => {
    assert.deepEqual(prepare.supplier_invoices.map((f) => [f.fournisseur, f.facture, f.montant, f.date_echeance, f.date_paiement_prevue, f.paid, f.paid_at, f.litigieuse, f.pennylane_id]), [
      ["Crocatus SAS", "CRO-2026-10", 1990, "2026-10-15", "2026-10-30", false, null, false, null],
      ["EDF", "EDF-88", 412.5, null, null, true, "2026-10-01T09:00:00Z", true, "123456"],
    ]);
    assert.deepEqual(prepare.fixed_charges.map((c) => [c.libelle, c.montant, c.date_prevue, c.date_fin, c.recurrence, c.mode_montant, c.taux_calcul, c.a_couper]), [
      ["Salaires (personnel à juillet 2026)", 43947.94, "2026-07-28", null, "mensuel", "fixe", null, false],
      ["URSSAF", 0, "2026-08-15", "2027-01-15", "mensuel", "calcule", 45, true],
    ]);
    assert.equal(prepare.financings[0].libelle, "Prêt Karmen");
    assert.equal(prepare.other_expenses[0].type, "probable");
  });
});

describe("import d'un export réel : seules transformations, techniques", () => {
  const source = exportFictif();
  const prepare = preparerExportReel(exportFictif(), uuidPrevisible);

  test("aucun identifiant de la base d'origine n'est réutilisé, tous sont distincts", () => {
    const anciens = new Set(TABLES_DONNEES.flatMap((table) => source[table].map((l) => l.id)));
    const nouveaux = TABLES_DONNEES.flatMap((table) => prepare[table].map((l) => l.id as string));
    assert.equal(nouveaux.some((id) => anciens.has(id)), false);
    assert.equal(new Set(nouveaux).size, nouveaux.length);
  });

  test("une charge calculée suit le nouvel identifiant de sa source", () => {
    const [salaires, urssaf] = prepare.fixed_charges;
    assert.equal(urssaf.source_calcul_id, salaires.id);
    assert.equal(urssaf.source_calcul_type, "charge_fixe");
    assert.equal(salaires.source_calcul_id, null);
  });

  test("company_id et updated_at de la base d'origine ne sont jamais repris", () => {
    for (const table of TABLES_DONNEES) {
      for (const ligne of prepare[table]) {
        assert.equal("company_id" in ligne, false);
        assert.equal("updated_at" in ligne, false);
      }
    }
  });

  test("la source n'est pas modifiée", () => {
    const avant = exportFictif();
    preparerExportReel(avant, uuidPrevisible);
    assert.deepEqual(avant, exportFictif());
  });
});

describe("lecture du fichier d'export", () => {
  const objet = exportFictif();

  test("accepte l'objet, la ligne { export } de l'éditeur Supabase, et l'objet sérialisé en chaîne", () => {
    assert.deepEqual(lireExport(JSON.stringify(objet)), objet);
    assert.deepEqual(lireExport(JSON.stringify([{ export: objet }])), objet);
    assert.deepEqual(lireExport(JSON.stringify([{ export: JSON.stringify(objet) }])), objet);
  });

  test("refuse un fichier incomplet ou une ligne sans identifiant", () => {
    assert.throws(() => lireExport(JSON.stringify({ fixed_charges: [] })), ExportInvalide);
    assert.throws(() => lireExport(JSON.stringify([1, 2])), ExportInvalide);
    const sansId = exportFictif();
    sansId.financings = [{ libelle: "x" }];
    assert.throws(() => lireExport(JSON.stringify(sansId)), ExportInvalide);
  });
});

describe("mode synthétique : distinct, entièrement fabriqué", () => {
  const jeu = jeuSynthetique(new Date(2026, 9, 13), uuidPrevisible);

  test("ne contient que les Charges fixes du jeu de test, aucune facture", () => {
    assert.deepEqual(jeu.fixed_charges.map((c) => c.libelle), chargesFixesSynthetiques.map((c) => c.libelle));
    assert.deepEqual([jeu.supplier_invoices, jeu.customer_invoices, jeu.other_expenses, jeu.financings, jeu.recurring_income], [[], [], [], [], []]);
    assert.equal(jeu.fixed_charges.find((c) => c.libelle === "DAF part-time")?.date_prevue, "2026-10-05");
  });

  test("la charge calculée synthétique pointe sur sa source", () => {
    const daf = jeu.fixed_charges.find((c) => c.libelle === "DAF part-time");
    const commission = jeu.fixed_charges.find((c) => c.libelle === "Commission sur DAF");
    assert.equal(commission?.source_calcul_id, daf?.id);
  });
});
