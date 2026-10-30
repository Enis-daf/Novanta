import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { indexerRegles, MODELE_CORRESPONDANCE } from "./comptaCorrespondance";
import { servicesDemo, TRANSACTIONS_DEMO, MAPPINGS_DEMO, AXE_DEMO } from "./comptaDemo";
import { comptesNouveaux, filtrerComptes, lignesCorrespondance, lignesDuRapport, structuresDuRapport, TEXTE_DEUX_PNL } from "./comptaLecture";
import { calculerPnlComptable, soldesDepuisLignes } from "./comptaPnl";
import { LIGNES_FIXTURES } from "./comptaFixtures";
import { indexerMappings } from "./pastCategoryMapping";
import { calculerPnlCashEstime } from "./pastPnlCashEstime";
import { capacitesDeLOffre, droitsOrganisation } from "./offres";
import { pnlComptableActif } from "./featureFlags";

const PERIODE = { debut: "2026-01-01", fin: "2026-03-31" };
const pnl = calculerPnlComptable({ soldes: soldesDepuisLignes(LIGNES_FIXTURES, PERIODE), regles: [...MODELE_CORRESPONDANCE] });

describe("Présentation du P&L comptable", () => {
  test("les libellés et l'ordre de la cascade demandée", () => {
    const libelles = lignesDuRapport(pnl).flat().map((l) => l.libelle);
    assert.deepEqual(libelles, [
      "Chiffre d'affaires",
      "Coûts directs",
      "Variation de stocks",
      "Marge brute",
      "Autres coûts variables",
      "Marge contributive",
      "Coûts de structure",
      "EBITDA",
      "Amortissements et dotations",
      "Résultat d'exploitation",
      "Éléments financiers",
      "Autres éléments",
      "Impôts",
      "Résultat net",
    ]);
  });

  test("le rapport ne recalcule rien : ses lignes sont celles du moteur", () => {
    const lignes = lignesDuRapport(pnl).flat();
    assert.equal(lignes.find((l) => l.cle === "resultat_net")!.montant, pnl.resultatNet);
  });

  test("le détail par catégorie somme à sa ligne", () => {
    for (const ligne of lignesDuRapport(pnl).flat().filter((l) => l.categories)) {
      const somme = ligne.categories!.reduce((t, c) => t + c.montant, 0);
      assert.equal(Math.round(somme * 100) / 100, ligne.montant, ligne.libelle);
    }
  });

  test("répartitions : réutilisent le calcul des graphiques existants", () => {
    const { revenus, couts } = structuresDuRapport(pnl);
    assert.ok(revenus.parts.length > 0);
    assert.ok(couts.parts.every((p) => p.montant < 0));
  });

  test("texte pédagogique générique, sans chiffre ni rapprochement", () => {
    assert.doesNotMatch(TEXTE_DEUX_PNL, /\d/);
    assert.match(TEXTE_DEUX_PNL, /n'ont pas vocation à donner le même chiffre/);
  });
});

describe("Écran de correspondance", () => {
  test("non affectés d'abord, statut suivant la règle courante", () => {
    const lignes = lignesCorrespondance(pnl.comptes, indexerRegles([...MODELE_CORRESPONDANCE]), new Set());
    assert.equal(lignes[0].statut, "non_affecte");
    assert.equal(lignes[0].compte, "780000");
  });

  test("filtres", () => {
    const lignes = lignesCorrespondance(pnl.comptes, indexerRegles([...MODELE_CORRESPONDANCE]), new Set());
    assert.deepEqual(filtrerComptes(lignes, "non_affectes").map((l) => l.compte), ["780000"]);
    assert.ok(filtrerComptes(lignes, "bilan").every((l) => /^[1-5]/.test(l.compte)));
    assert.equal(filtrerComptes(lignes, "tous").length, lignes.length);
  });

  test("détection des nouveaux comptes depuis la dernière synchronisation", () => {
    const nouveaux = comptesNouveaux([{ numero: "1", premiereVue: "2026-03-01T00:00:00Z" }, { numero: "2", premiereVue: "2026-01-01T00:00:00Z" }], "2026-02-01T00:00:00Z");
    assert.deepEqual([...nouveaux], ["1"]);
    assert.equal(comptesNouveaux([{ numero: "1", premiereVue: "x" }], null).size, 0);
  });
});

describe("Société sans données comptables", () => {
  test("son P&L cash estimé reste calculé et utilisable", () => {
    const cash = calculerPnlCashEstime(TRANSACTIONS_DEMO, AXE_DEMO, indexerMappings(MAPPINGS_DEMO), []);
    const compta = calculerPnlComptable({ soldes: [], regles: [] });
    assert.ok(cash.ca > 0);
    assert.equal(compta.aDesEcritures, false);
  });
});

describe("Droits", () => {
  test("P&L comptable réservé à Pilotage ; Essentiel et Prévision refusés", () => {
    assert.equal(capacitesDeLOffre("essential").canViewAccountingPnl, false);
    assert.equal(capacitesDeLOffre("forecast").canViewAccountingPnl, false);
    assert.equal(capacitesDeLOffre("steering").canViewAccountingPnl, true);
  });

  test("valeur inconnue : fail-closed", () => {
    assert.equal(droitsOrganisation({ plan: "bizarre" }).capacites.canViewAccountingPnl, false);
  });

  test("matrice de reporting inchangée", () => {
    assert.equal(capacitesDeLOffre("essential").canViewReporting, true);
    assert.equal(capacitesDeLOffre("forecast").canViewWorkingCapital, false);
    assert.equal(capacitesDeLOffre("forecast").canViewActions, false);
  });

  test("le drapeau est éteint par défaut", () => {
    assert.equal(pnlComptableActif(), false);
  });
});

describe("Données de démonstration", () => {
  test("services en mémoire : conflit de stocks puis arbitrage", async () => {
    const services = servicesDemo({ avecStocksNovanta: true });
    assert.equal((await services.charger(PERIODE)).pnl.stock.conflit, true);
    await services.modifier({ action: "source_stock", source: "novanta" });
    const r = await services.charger(PERIODE);
    assert.equal(r.pnl.stock.source, "novanta");
    assert.equal(r.pnl.stock.conflit, false);
  });

  test("appliquer le modèle n'écrase pas une racine déjà paramétrée", async () => {
    const services = servicesDemo({ reglesInitiales: [{ prefixe: "70", destination: "other_items", categorie: "Choix" }] });
    await services.modifier({ action: "appliquer_modele" });
    const r = await services.charger(PERIODE);
    assert.equal(r.regles.find((x) => x.prefixe === "70")!.categorie, "Choix");
    assert.ok(r.regles.length > 10);
  });
});
