import { test, describe } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { genererExportExcel, ParametresExportExcel } from "./exportExcel";
import { ResultatProjectionCash } from "./cash-engine";
import { ResultatSyntheseMensuelle } from "./syntheseMensuelle";
import { AutreDepense, ChargeFixe, FactureClient, FactureFournisseur, Financement, RentreeReguliere } from "./types";
import { OccurrencesParId, PeriodeFiltre } from "./periodeFiltre";

const NOMS_ONGLETS = [
  "Synthèse",
  "Factures clients",
  "Factures fournisseurs",
  "Charges fixes",
  "Rentrées régulières",
  "Autres dépenses",
  "Financements",
];

const RESULTAT_TEST: ResultatProjectionCash = {
  serie: [],
  soldeJ90: 12345,
  pointBas: -678,
  dateDuPointBas: "2026-02-01",
  datePassageSousZero: "2026-03-01",
};

const SYNTHESE_TEST: ResultatSyntheseMensuelle = {
  mois: [
    { cle: "2026-01", libelle: "Janv." },
    { cle: "2026-02", libelle: "Févr." },
  ],
  lignes: [
    { libelle: "Factures clients", montantsParMois: [100, 200], total: 300 },
    { libelle: "Rentrées régulières", montantsParMois: [10, 20], total: 30 },
    { libelle: "Financements", montantsParMois: [0, 0], total: 0 },
    { libelle: "Factures fournisseurs", montantsParMois: [-50, -60], total: -110 },
    { libelle: "Charges fixes", montantsParMois: [-5, -5], total: -10 },
    { libelle: "Autres dépenses", montantsParMois: [0, -1], total: -1 },
  ],
};

function factureClient(overrides: Partial<FactureClient> = {}): FactureClient {
  return {
    id: "fc-1",
    facture: "FC-001",
    client: "Client A",
    montant: 1000,
    dateEcheance: "2026-01-10",
    dateEncaissementAnticipee: "2026-01-10",
    litigieuse: false,
    payee: false,
    paidAt: null,
    ...overrides,
  };
}

function factureFournisseur(overrides: Partial<FactureFournisseur> = {}): FactureFournisseur {
  return {
    id: "ff-1",
    facture: "FF-001",
    fournisseur: "Fournisseur A",
    montant: 500,
    dateEcheance: "2026-01-10",
    datePaiementPrevue: "2026-01-10",
    litigieuse: false,
    payee: false,
    paidAt: null,
    ...overrides,
  };
}

function chargeFixe(overrides: Partial<ChargeFixe> = {}): ChargeFixe {
  return {
    id: "cf-1",
    libelle: "Charge",
    montant: 100,
    datePrevue: "2026-01-01",
    recurrence: "mensuel",
    dateFin: null,
    modeMontant: "fixe",
    tauxCalcul: null,
    sourceCalculId: null,
    sourceCalculType: null,
    aCouper: false,
    ...overrides,
  };
}

function rentree(overrides: Partial<RentreeReguliere> = {}): RentreeReguliere {
  return {
    id: "rr-1",
    libelle: "Rentrée",
    montant: 100,
    dateDebut: "2026-01-01",
    frequence: "mensuel",
    dateFin: null,
    modeMontant: "fixe",
    profilSaisonnalite: null,
    ...overrides,
  };
}

function autreDepense(overrides: Partial<AutreDepense> = {}): AutreDepense {
  return {
    id: "ad-1",
    libelle: "Dépense",
    montant: 200,
    datePrevue: "2026-01-01",
    type: "certaine",
    facturee: false,
    ...overrides,
  };
}

function financement(overrides: Partial<Financement> = {}): Financement {
  return {
    id: "fi-1",
    libelle: "Financement",
    montant: 5000,
    dateEncaissementPrevue: "2026-01-01",
    verse: false,
    ...overrides,
  };
}

function baseParams(overrides: Partial<ParametresExportExcel> = {}): ParametresExportExcel {
  return {
    recherche: "",
    tri: "date",
    soldeInitial: 10000,
    dateReleve: "2026-01-01",
    horizonJours: 90,
    resultat: RESULTAT_TEST,
    syntheseMensuelle: SYNTHESE_TEST,
    facturesClients: [],
    facturesFournisseurs: [],
    chargesFixes: [],
    autresDepenses: [],
    financements: [],
    rentreesRegulieres: [],
    filtresParCategorie: {
      facturesClients: null,
      facturesFournisseurs: null,
      chargesFixes: null,
      autresDepenses: null,
      financements: null,
      rentreesRegulieres: null,
    },
    periodeFiltre: null,
    ...overrides,
  };
}

async function chargerClasseur(blob: Blob): Promise<ExcelJS.Workbook> {
  const buffer = Buffer.from(await blob.arrayBuffer());
  const classeur = new ExcelJS.Workbook();
  await classeur.xlsx.load(buffer as unknown as ArrayBuffer);
  return classeur;
}

describe("genererExportExcel — export complet", () => {
  test("fichier .xlsx valide contenant exactement les 7 onglets attendus, dans l'ordre", async () => {
    const blob = await genererExportExcel(baseParams());
    assert.equal(blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const classeur = await chargerClasseur(blob);
    assert.deepEqual(
      classeur.worksheets.map((f) => f.name),
      NOMS_ONGLETS
    );
  });
});

describe("Recherche — seules les lignes visibles sont exportées", () => {
  test("une recherche active exclut les factures qui ne correspondent pas", async () => {
    const params = baseParams({
      recherche: "Client A",
      facturesClients: [
        factureClient({ id: "fc-1", client: "Client A" }),
        factureClient({ id: "fc-2", client: "Client B", facture: "FC-002" }),
      ],
    });
    const classeur = await chargerClasseur(await genererExportExcel(params));
    const feuille = classeur.getWorksheet("Factures clients")!;
    assert.equal(feuille.rowCount, 2); // en-tête + 1 ligne
    assert.equal(feuille.getRow(2).getCell(2).value, "Client A"); // colonne 2 = Client
  });
});

describe("Tri — ordre cohérent dans l'Excel", () => {
  test("tri par montant décroissant reflété dans l'ordre des lignes", async () => {
    const params = baseParams({
      tri: "montant",
      financements: [
        financement({ id: "fi-1", libelle: "Petit", montant: 1000 }),
        financement({ id: "fi-2", libelle: "Grand", montant: 9000 }),
      ],
    });
    const classeur = await chargerClasseur(await genererExportExcel(params));
    const feuille = classeur.getWorksheet("Financements")!;
    assert.equal(feuille.getRow(2).getCell(1).value, "Grand"); // colonne 1 = Libellé
    assert.equal(feuille.getRow(3).getCell(1).value, "Petit");
  });
});

describe("Filtre de courbe — seules les lignes visibles dans le panneau droit sont exportées", () => {
  test("une charge fixe hors de la plage sélectionnée est absente de l'export", async () => {
    const filtre: OccurrencesParId = new Map([["cf-1", ["2026-01-01"]]]);
    const params = baseParams({
      chargesFixes: [chargeFixe({ id: "cf-1", libelle: "Visible" }), chargeFixe({ id: "cf-2", libelle: "Hors plage" })],
      filtresParCategorie: {
        facturesClients: null,
        facturesFournisseurs: null,
        chargesFixes: filtre,
        autresDepenses: null,
        financements: null,
        rentreesRegulieres: null,
      },
    });
    const classeur = await chargerClasseur(await genererExportExcel(params));
    const feuille = classeur.getWorksheet("Charges fixes")!;
    assert.equal(feuille.rowCount, 2);
    assert.equal(feuille.getRow(2).getCell(1).value, "Visible"); // colonne 1 = Libellé
  });
});

describe("Lignes exclues du calcul — restent exportées si visibles", () => {
  test("facture payée/litigieuse, dépense facturée, financement versé, charge à couper : tous exportés avec leur statut", async () => {
    const params = baseParams({
      facturesClients: [factureClient({ payee: true, litigieuse: true, paidAt: null })],
      autresDepenses: [autreDepense({ facturee: true })],
      financements: [financement({ verse: true })],
      chargesFixes: [chargeFixe({ aCouper: true })],
    });
    const classeur = await chargerClasseur(await genererExportExcel(params));

    const fc = classeur.getWorksheet("Factures clients")!;
    assert.equal(fc.rowCount, 2);
    assert.equal(fc.getRow(2).getCell(7).value, "Oui"); // colonne 7 = Payée
    assert.equal(fc.getRow(2).getCell(6).value, "Oui"); // colonne 6 = Litigieuse

    const ad = classeur.getWorksheet("Autres dépenses")!;
    assert.equal(ad.getRow(2).getCell(5).value, "Oui"); // colonne 5 = Facturée

    const fi = classeur.getWorksheet("Financements")!;
    assert.equal(fi.getRow(2).getCell(4).value, "Oui"); // colonne 4 = Versé

    const cf = classeur.getWorksheet("Charges fixes")!;
    assert.equal(cf.getRow(2).getCell(6).value, "Oui"); // colonne 6 = À couper
  });
});

describe("Charge fixe calculée — une seule ligne, sans duplication", () => {
  test("taux et source visibles, une seule ligne malgré le montant variable dans le temps", async () => {
    const ca = rentree({ id: "ca", libelle: "CA", montant: 1000, frequence: "quotidien" });
    const ads = chargeFixe({
      id: "ads",
      libelle: "Ads",
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
      recurrence: "hebdomadaire",
    });
    const params = baseParams({ chargesFixes: [ads], rentreesRegulieres: [ca] });
    const classeur = await chargerClasseur(await genererExportExcel(params));
    const feuille = classeur.getWorksheet("Charges fixes")!;
    assert.equal(feuille.rowCount, 2); // en-tête + 1 seule ligne
    const ligne = feuille.getRow(2);
    assert.equal(ligne.getCell(7).value, "Calculé"); // Mode de montant
    assert.equal(ligne.getCell(8).value, 40); // Taux
    assert.equal(ligne.getCell(9).value, "CA"); // Source
    assert.equal(ligne.getCell(10).value, "Rentrée régulière"); // Type de source
    assert.ok(typeof ligne.getCell(11).value === "number"); // Montant calculé affiché
  });
});

describe("Rentrée saisonnalisée — une seule ligne, sans duplication en 12 lignes", () => {
  test("montant annuel et 12 pondérations exportés sur une seule ligne", async () => {
    const ponderations = [8, 7, 6, 7, 8, 9, 10, 15, 10, 9, 8, 3];
    const params = baseParams({
      rentreesRegulieres: [
        rentree({
          id: "ca",
          libelle: "CA",
          modeMontant: "saisonnalise",
          profilSaisonnalite: { montantAnnuel: 1200000, ponderationsMensuelles: ponderations },
        }),
      ],
    });
    const classeur = await chargerClasseur(await genererExportExcel(params));
    const feuille = classeur.getWorksheet("Rentrées régulières")!;
    assert.equal(feuille.rowCount, 2); // en-tête + 1 seule ligne, jamais 12
    const ligne = feuille.getRow(2);
    const entetes = (feuille.getRow(1).values as unknown[]).map(String);
    assert.equal(ligne.getCell(2).value, "Saisonnalisé"); // Mode
    assert.equal(ligne.getCell(4).value, 1200000); // Montant annuel
    assert.equal(entetes[8], "Janvier %"); // vérifie l'alignement des colonnes mensuelles
    assert.equal(ligne.getCell(8).value, 8); // Janvier % (index 0 du profil)
    assert.equal(ligne.getCell(15).value, 15); // Août % (index 7 du profil)
    assert.equal(ligne.getCell(19).value, 3); // Décembre % (index 11 du profil)
  });
});

describe("Sans données — onglet vide mais valide", () => {
  test("chaque onglet de données ne contient que l'en-tête, sans erreur", async () => {
    const classeur = await chargerClasseur(await genererExportExcel(baseParams()));
    for (const nom of NOMS_ONGLETS) {
      if (nom === "Synthèse") continue;
      const feuille = classeur.getWorksheet(nom)!;
      assert.ok(feuille, `onglet manquant : ${nom}`);
      assert.equal(feuille.rowCount, 1, `${nom} devrait n'avoir que l'en-tête`);
    }
  });
});

describe("Synthèse — KPIs et synthèse mensuelle repris tels quels (jamais recalculés)", () => {
  test("les valeurs de resultat/syntheseMensuelle apparaissent exactement dans l'onglet", async () => {
    const classeur = await chargerClasseur(await genererExportExcel(baseParams()));
    const feuille = classeur.getWorksheet("Synthèse")!;
    const valeurs = feuille
      .getSheetValues()
      .flat()
      .filter((v) => typeof v === "number");
    // Les KPIs de test doivent être présents tels quels, sans arrondi ni recalcul.
    assert.ok(valeurs.includes(12345), "soldeJ90 attendu tel quel");
    assert.ok(valeurs.includes(-678), "pointBas attendu tel quel");
    // Synthèse mensuelle : les montants et totaux de test doivent être présents.
    assert.ok(valeurs.includes(300), "total Factures clients attendu");
    assert.ok(valeurs.includes(-110), "total Factures fournisseurs attendu");
  });
});
