import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CategorieFacture,
  categoriesARelire,
  classerDepense,
  correspondAuFiltreEtage,
  CorrespondanceFutur,
  ETAGES_DEPENSE,
  estFiltreEtage,
  etageAutomatique,
  EtageDepense,
  groupeDeClassement,
  GROUPES_ETAGE,
  grouperParEtage,
  idsAAffecter,
  infobulleClassement,
  lireCorrespondance,
  reunirEtagesManuels,
} from "./futurPnl";
import { ETAGES_PNL, EtagePnl } from "./pastCategoryMapping";
import { categoriesDeFacture, calculerSynchronisation, CandidatFacturePennylane } from "./pennylaneInvoiceAdapter";
import { calculerProjectionCash } from "./cash-engine";
import { calculerFluxPeriode } from "./periodeFiltre";
import { estEtageConvertiEnHt } from "./pastHtEstime";
import { AutreDepense, ChargeFixe, FactureFournisseur } from "./types";

// Correspondance partagée de l'organisation (past_category_mappings), telle que la renvoie
// future_pnl_correspondance : identifiant Pennylane de la catégorie -> étage.
const correspondance = (etages: Record<string, EtagePnl>, axe: string | null = "axe-1"): CorrespondanceFutur => ({
  axe,
  etages: new Map(Object.entries(etages).map(([id, etage]) => [id, { axe: "axe-1", etage }])),
});
const cat = (id: string, label: string, groupId = "axe-1", weight = 1): CategorieFacture => ({ id, label, groupId, weight });

const MAPPING = correspondance({
  "101": "gross_margin", // Matières premières
  "102": "contribution_margin", // Publicité & marketing
  "103": "ebitda", // Logiciels
  "104": "ebitda", // Abonnements
  "105": "revenue", // Ventes (ne s'applique pas à une dépense)
});

const facture = (patch: Partial<FactureFournisseur> = {}): FactureFournisseur => ({
  id: "f1",
  facture: "F-1",
  fournisseur: "Fournisseur",
  montant: 1000,
  dateEcheance: "2026-11-10",
  datePaiementPrevue: "2026-11-10",
  litigieuse: false,
  payee: false,
  paidAt: null,
  pennylaneId: "pl-1",
  ...patch,
});

describe("nomenclature : celle de Passé, sans « Encaissements »", () => {
  test("mêmes clés et mêmes libellés que Passé, dans le même ordre", () => {
    assert.deepEqual(
      ETAGES_DEPENSE.map((e) => [e.cle, e.libelle]),
      ETAGES_PNL.filter((e) => e.cle !== "revenue").map((e) => [e.cle, e.libelle])
    );
    assert.deepEqual(
      ETAGES_DEPENSE.map((e) => e.libelle),
      ["Coûts directs", "Autres coûts variables", "Coûts de structure", "Extra P&L", "TVA", "Virements internes & Financement"]
    );
  });
});

describe("classement automatique par la correspondance partagée", () => {
  test("catégorie mappée -> bon étage, provenance correspondance", () => {
    assert.deepEqual(classerDepense(facture({ categoriesPennylane: [cat("101", "Matières premières")] }), MAPPING), {
      etage: "gross_margin",
      provenance: "correspondance",
    });
    assert.equal(etageAutomatique([cat("102", "Publicité & marketing")], MAPPING), "contribution_margin");
    assert.equal(etageAutomatique([cat("103", "Logiciels")], MAPPING), "ebitda");
  });

  test("catégorie sans mapping -> À classer", () => {
    assert.deepEqual(classerDepense(facture({ categoriesPennylane: [cat("999", "Inconnue")] }), MAPPING), {
      etage: null,
      provenance: "a_classer",
    });
  });

  test("aucune catégorie, catégories jamais lues -> À classer, jamais un étage par défaut", () => {
    assert.equal(etageAutomatique([], MAPPING), null);
    assert.equal(etageAutomatique(null, MAPPING), null);
    assert.equal(classerDepense(facture(), MAPPING).etage, null);
  });

  test("catégories ambiguës -> À classer, aucun choix arbitraire (même au plus fort poids)", () => {
    assert.equal(etageAutomatique([cat("101", "Matières premières", "axe-1", 0.9), cat("103", "Logiciels", "axe-1", 0.1)], MAPPING), null);
  });

  test("plusieurs catégories aboutissant au même étage -> cet étage", () => {
    assert.equal(etageAutomatique([cat("103", "Logiciels", "axe-1", 0.5), cat("104", "Abonnements", "axe-1", 0.5)], MAPPING), "ebitda");
  });

  test("une catégorie mappée et une non mappée -> À classer", () => {
    assert.equal(etageAutomatique([cat("103", "Logiciels"), cat("999", "Inconnue")], MAPPING), null);
  });

  test("catégorie rattachée à « Encaissements » -> À classer (pas un étage de dépense)", () => {
    assert.equal(etageAutomatique([cat("105", "Ventes")], MAPPING), null);
  });

  test("axe de référence de Passé : seules ses catégories comptent", () => {
    const categories = [cat("103", "Logiciels", "axe-1"), cat("201", "Projet A", "axe-2")];
    assert.equal(etageAutomatique(categories, MAPPING), "ebitda");
    // Facture catégorisée uniquement sur un autre axe : À classer.
    assert.equal(etageAutomatique([cat("201", "Projet A", "axe-2")], MAPPING), null);
  });

  test("sans axe configuré : toutes les catégories comptent, sans arbitrage", () => {
    const sansAxe = correspondance({ "103": "ebitda", "201": "gross_margin" }, null);
    assert.equal(etageAutomatique([cat("103", "Logiciels", "axe-1")], sansAxe), "ebitda");
    assert.equal(etageAutomatique([cat("103", "Logiciels", "axe-1"), cat("201", "Projet A", "axe-2")], sansAxe), null);
  });

  test("catégorie sans identifiant : même identité que dans Passé (clé dérivée du nom)", () => {
    const parNom = correspondance({ "nom:logiciels": "ebitda" });
    assert.equal(etageAutomatique([{ id: null, label: "Logiciels", groupId: "axe-1", weight: 1 }], parNom), "ebitda");
  });
});

describe("priorité du choix manuel", () => {
  test("le choix manuel prime sur la correspondance", () => {
    const f = facture({ categoriesPennylane: [cat("103", "Logiciels")], etagePnlManuel: "gross_margin" });
    assert.deepEqual(classerDepense(f, MAPPING), { etage: "gross_margin", provenance: "manuel" });
  });

  test("Reprendre le classement automatique (choix retiré) -> le mapping reprend", () => {
    const f = facture({ categoriesPennylane: [cat("103", "Logiciels")], etagePnlManuel: null });
    assert.deepEqual(classerDepense(f, MAPPING), { etage: "ebitda", provenance: "correspondance" });
  });

  test("Reprendre le classement automatique sans mapping -> À classer", () => {
    assert.deepEqual(classerDepense({ etagePnlManuel: null }, MAPPING), { etage: null, provenance: "a_classer" });
  });

  test("changement du mapping partagé : dépenses automatiques mises à jour, choix manuels inchangés", () => {
    const auto = facture({ id: "a", categoriesPennylane: [cat("103", "Logiciels")] });
    const manuelle = facture({ id: "m", categoriesPennylane: [cat("103", "Logiciels")], etagePnlManuel: "ebitda" });
    const nouveauMapping = correspondance({ "103": "contribution_margin" });
    assert.equal(classerDepense(auto, nouveauMapping).etage, "contribution_margin");
    assert.deepEqual(classerDepense(manuelle, nouveauMapping), { etage: "ebitda", provenance: "manuel" });
  });

  test("infobulle discrète selon la provenance", () => {
    assert.equal(infobulleClassement({ etage: "ebitda", provenance: "correspondance" }), "Issu de la correspondance P&L");
    assert.equal(infobulleClassement({ etage: "ebitda", provenance: "manuel" }), "Défini dans Futur");
    assert.equal(infobulleClassement({ etage: null, provenance: "a_classer" }), "À classer");
  });
});

describe("dépenses saisies dans Futur (sans Pennylane, sans Passé)", () => {
  test("dépense manuelle : étage enregistrable, aucune correspondance nécessaire", () => {
    const vide = lireCorrespondance(null);
    const depense: Pick<AutreDepense, "etagePnlManuel"> = { etagePnlManuel: "vat" };
    assert.deepEqual(classerDepense(depense, vide), { etage: "vat", provenance: "manuel" });
    assert.deepEqual(classerDepense({}, vide), { etage: null, provenance: "a_classer" });
  });

  test("correspondance illisible ou vide (utilisateur Futur seul) : rien d'inventé", () => {
    for (const brut of [null, undefined, "x", {}, { axe: 3, correspondances: "x" }]) {
      const c = lireCorrespondance(brut);
      assert.equal(c.axe, null);
      assert.equal(c.etages.size, 0);
    }
    const c = lireCorrespondance({
      axe: "axe-1",
      correspondances: [
        { id: "103", axe: "axe-1", etage: "ebitda" },
        { id: "x", etage: "inconnu" },
        { etage: "ebitda" },
      ],
    });
    assert.equal(c.axe, "axe-1");
    assert.deepEqual([...c.etages.keys()], ["103"]);
  });
});

describe("charge récurrente : étage porté par la charge source", () => {
  test("toutes les occurrences futures reprennent l'étage de la charge, sans copie", () => {
    const charge: ChargeFixe = {
      id: "loyer",
      libelle: "Prestataire de production",
      montant: 500,
      datePrevue: "2026-11-05",
      recurrence: "mensuel",
      dateFin: null,
      modeMontant: "fixe",
      tauxCalcul: null,
      sourceCalculId: null,
      sourceCalculType: null,
      aCouper: false,
      etagePnlManuel: "gross_margin",
    };
    const flux = calculerFluxPeriode({
      debut: "2026-11-01",
      fin: "2027-01-31",
      facturesClients: [],
      facturesFournisseurs: [],
      chargesFixes: [charge],
      autresDepenses: [],
      financements: [],
      rentreesRegulieres: [],
    });
    const occurrences = flux.occurrencesChargesFixes.get("loyer") ?? [];
    assert.equal(occurrences.length, 3);
    // Chaque occurrence renvoie à la charge source, qui porte l'étage.
    for (const _ of occurrences) assert.equal(classerDepense(charge, lireCorrespondance(null)).etage, "gross_margin");
  });

  test("une charge récurrente n'est jamais classée en Coûts de structure d'office", () => {
    const charge = { etagePnlManuel: undefined };
    assert.equal(classerDepense(charge, MAPPING).etage, null);
  });
});

describe("classement multiple et filtres", () => {
  test("Affecter un étage P&L : seules les lignes cochées ET affichées", () => {
    const selection = new Set(["a", "c", "masquee"]);
    assert.deepEqual(idsAAffecter(selection, ["a", "b", "c"]), ["a", "c"]);
    assert.deepEqual(idsAAffecter(new Set(), ["a"]), []);
  });

  test("filtre : Tous, À classer, un étage", () => {
    const lignes = [
      { id: "1", c: { etage: null, provenance: "a_classer" as const } },
      { id: "2", c: { etage: "ebitda" as EtageDepense, provenance: "manuel" as const } },
      { id: "3", c: { etage: "vat" as EtageDepense, provenance: "correspondance" as const } },
    ];
    const ids = (f: Parameters<typeof correspondAuFiltreEtage>[1]) => lignes.filter((l) => correspondAuFiltreEtage(l.c, f)).map((l) => l.id);
    assert.deepEqual(ids("tous"), ["1", "2", "3"]);
    assert.deepEqual(ids("a_classer"), ["1"]);
    assert.deepEqual(ids("ebitda"), ["2"]);
    assert.deepEqual(ids("financing"), []);
  });
});

describe("non classé ne veut pas dire exclu : projection inchangée", () => {
  const base = {
    soldeInitial: 10_000,
    facturesClients: [],
    financements: [],
    rentreesRegulieres: [],
    dateDepart: "2026-10-22",
  };
  const charge = (etagePnlManuel?: EtageDepense | null): ChargeFixe => ({
    id: "c",
    libelle: "Charge",
    montant: 300,
    datePrevue: "2026-11-01",
    recurrence: "mensuel",
    dateFin: null,
    modeMontant: "fixe",
    tauxCalcul: null,
    sourceCalculId: null,
    sourceCalculType: null,
    aCouper: false,
    etagePnlManuel,
  });
  const autre = (etagePnlManuel?: EtageDepense | null): AutreDepense => ({
    id: "d",
    libelle: "Dépense",
    montant: 200,
    datePrevue: "2026-11-15",
    type: "certaine",
    facturee: false,
    payee: false,
    etagePnlManuel,
  });

  test("À classer, TVA, Extra P&L, Financement : même série de trésorerie que sans classement", () => {
    const sans = calculerProjectionCash({
      ...base,
      facturesFournisseurs: [facture()],
      chargesFixes: [charge()],
      autresDepenses: [autre()],
    });
    for (const etage of [null, "vat", "extra_pnl", "financing", "ebitda"] as (EtageDepense | null)[]) {
      const avec = calculerProjectionCash({
        ...base,
        facturesFournisseurs: [facture({ etagePnlManuel: etage, categoriesPennylane: [cat("103", "Logiciels")] })],
        chargesFixes: [charge(etage)],
        autresDepenses: [autre(etage)],
      });
      assert.deepEqual(avec, sans, `étage ${etage}`);
    }
    // Et les dépenses comptent bien : 1 000 + 3 × 300 + 200 sortent d'ici fin janvier.
    assert.ok(sans.soldeJ90 < 10_000);
  });
});

describe("synchronisation Pennylane : le choix manuel est un réglage local préservé", () => {
  test("facture déjà connue : la synchronisation ne propose aucune écriture d'étage", () => {
    const candidat: CandidatFacturePennylane = {
      pennylaneId: "pl-1",
      facture: "F-1",
      tiers: "Fournisseur",
      montant: 800,
      montantFacture: 1000,
      dateEcheance: "2026-11-10",
      payee: false,
      motifSolde: null,
    };
    const resultat = calculerSynchronisation(
      [candidat],
      [{ id: "f1", pennylaneId: "pl-1", payee: false, facture: "F-1", tiers: "Fournisseur", montant: 1000, dateEcheance: "2026-11-10" }]
    );
    assert.equal(resultat.aInserer.length, 0);
    // Le document est actualisé (montant restant dû) : aucune clé d'étage dans le plan de synchronisation.
    assert.equal(resultat.misesAJourDocument.length, 1);
    assert.equal(resultat.misesAJourDocument[0].montant, 800);
    assert.ok(!JSON.stringify(resultat).toLowerCase().includes("etage"));
  });

  test("catégories relues : à la synchronisation, le choix manuel l'emporte toujours", () => {
    const avant = facture({ etagePnlManuel: "contribution_margin", categoriesPennylane: null });
    const apres = { ...avant, categoriesPennylane: [cat("103", "Logiciels")] };
    assert.deepEqual(classerDepense(apres, MAPPING), { etage: "contribution_margin", provenance: "manuel" });
  });

  test("normalisation des catégories Pennylane d'une facture", () => {
    assert.deepEqual(
      categoriesDeFacture([
        { id: 103, label: " Logiciels ", weight: "0.25", category_group: { id: 7 } },
        { id: 104, label: "Abonnements", weight: null, category_group: null },
        { id: 105, label: "", weight: "1" },
      ]),
      [
        { id: "103", label: "Logiciels", groupId: "7", weight: 0.25 },
        { id: "104", label: "Abonnements", groupId: null, weight: 1 },
      ]
    );
  });

  test("factures à relire : Pennylane, à payer, jamais lues / sans catégorie / lues il y a plus de 7 jours", () => {
    const maintenant = new Date("2026-10-22T12:00:00Z");
    assert.equal(categoriesARelire(facture(), maintenant), true);
    assert.equal(categoriesARelire(facture({ categoriesPennylane: [], categoriesLuesLe: "2026-10-22T00:00:00Z" }), maintenant), true);
    assert.equal(categoriesARelire(facture({ categoriesPennylane: [cat("103", "L")], categoriesLuesLe: "2026-10-20T00:00:00Z" }), maintenant), false);
    assert.equal(categoriesARelire(facture({ categoriesPennylane: [cat("103", "L")], categoriesLuesLe: "2026-10-10T00:00:00Z" }), maintenant), true);
    assert.equal(categoriesARelire(facture({ pennylaneId: null }), maintenant), false);
    assert.equal(categoriesARelire(facture({ payee: true }), maintenant), false);
  });
});

describe("fusion de doublons : deux choix manuels ne s'écrasent pas en silence", () => {
  test("un seul choix, ou deux identiques : repris", () => {
    assert.deepEqual(reunirEtagesManuels("ebitda", null), { etage: "ebitda", conflit: null });
    assert.deepEqual(reunirEtagesManuels(undefined, "vat"), { etage: "vat", conflit: null });
    assert.deepEqual(reunirEtagesManuels("vat", "vat"), { etage: "vat", conflit: null });
    assert.deepEqual(reunirEtagesManuels(null, null), { etage: null, conflit: null });
  });

  test("deux choix différents : conflit à trancher", () => {
    assert.deepEqual(reunirEtagesManuels("ebitda", "gross_margin"), { etage: null, conflit: { a: "ebitda", b: "gross_margin" } });
  });
});

describe("présentation simplifiée de Futur : TVA sous Extra P&L, « Financement »", () => {
  test("groupes, ordre et libellés de Futur", () => {
    assert.deepEqual(
      GROUPES_ETAGE.map((g) => [g.cle, g.libelle]),
      [
        ["gross_margin", "Coûts directs"],
        ["contribution_margin", "Autres coûts variables"],
        ["ebitda", "Coûts de structure"],
        ["extra_pnl", "Extra P&L"],
        ["financing", "Financement"],
      ]
    );
    assert.ok(!GROUPES_ETAGE.some((g) => g.libelle === "TVA"));
  });

  test("Passé garde sa nomenclature : TVA distincte, libellé Financement d'origine, TVA exclue du HT", () => {
    assert.equal(ETAGES_PNL.find((e) => e.cle === "vat")?.libelle, "TVA");
    assert.equal(ETAGES_PNL.find((e) => e.cle === "financing")?.libelle, "Virements internes & Financement");
    assert.equal(estEtageConvertiEnHt("vat"), false);
  });

  test("une facture mappée TVA s'affiche sous Extra P&L sans perdre sa classification source", () => {
    const tva = correspondance({ "301": "vat" });
    const classement = classerDepense(facture({ categoriesPennylane: [cat("301", "TVA décaissée")] }), tva);
    assert.deepEqual(classement, { etage: "vat", provenance: "correspondance" });
    assert.equal(groupeDeClassement(classement), "extra_pnl");
    assert.equal(infobulleClassement(classement), "Issu de la correspondance P&L (classée TVA)");
  });

  test("filtre Extra P&L : retrouve Extra P&L et TVA ; filtre Financement : virements et financements", () => {
    const c = (etage: EtageDepense | null) => ({ etage, provenance: etage ? ("manuel" as const) : ("a_classer" as const) });
    assert.equal(correspondAuFiltreEtage(c("extra_pnl"), "extra_pnl"), true);
    assert.equal(correspondAuFiltreEtage(c("vat"), "extra_pnl"), true);
    assert.equal(correspondAuFiltreEtage(c("ebitda"), "extra_pnl"), false);
    assert.equal(correspondAuFiltreEtage(c("financing"), "financing"), true);
    assert.equal(correspondAuFiltreEtage(c(null), "a_classer"), true);
    assert.equal(estFiltreEtage("vat"), false);
  });
});

describe("regroupement des lignes sous des sous-titres", () => {
  const ligne = (id: string, etage: EtageDepense | null) => ({ id, etagePnlManuel: etage });
  const classer = (l: { etagePnlManuel: EtageDepense | null }) => classerDepense(l, lireCorrespondance(null));

  test("ordre fixe des groupes, À classer en dernier, aucun groupe vide, ordre interne conservé", () => {
    const lignes = [
      ligne("1", null),
      ligne("2", "financing"),
      ligne("3", "vat"),
      ligne("4", "gross_margin"),
      ligne("5", "extra_pnl"),
      ligne("6", "gross_margin"),
      ligne("7", null),
    ];
    const groupes = grouperParEtage(lignes, classer);
    assert.deepEqual(
      groupes.map((g) => [g.libelle, g.lignes.map((l) => l.id)]),
      [
        ["Coûts directs", ["4", "6"]],
        ["Extra P&L", ["3", "5"]],
        ["Financement", ["2"]],
        ["À classer", ["1", "7"]],
      ]
    );
  });

  test("chaque ligne apparaît une fois, aucune perdue", () => {
    const lignes = Array.from({ length: 40 }, (_, i) =>
      ligne(String(i), ([null, "gross_margin", "contribution_margin", "ebitda", "extra_pnl", "vat", "financing"] as const)[i % 7])
    );
    const ids = grouperParEtage(lignes, classer).flatMap((g) => g.lignes.map((l) => l.id));
    assert.equal(ids.length, 40);
    assert.equal(new Set(ids).size, 40);
  });

  test("aucune dépense non classée : pas de groupe À classer ; liste vide : aucun sous-titre", () => {
    assert.deepEqual(grouperParEtage([ligne("1", "ebitda")], classer).map((g) => g.libelle), ["Coûts de structure"]);
    assert.deepEqual(grouperParEtage([], classer), []);
  });
});
