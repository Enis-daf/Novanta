import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { indexerRegles, MODELE_CORRESPONDANCE } from "./comptaCorrespondance";
import { servicesDemo, TRANSACTIONS_DEMO, MAPPINGS_DEMO, AXE_DEMO } from "./comptaDemo";
import { comptesNouveaux, filtrerComptes, lignesCorrespondance, lignesDuRapport, MENTION_BALANCE, moisALire, periodePartielle, resumeSynchro, structuresDuRapport, TEXTE_DEUX_PNL, TEXTE_PROVISOIRE, TITRE_PROVISOIRE } from "./comptaLecture";
import { calculerPnlComptable, soldesDepuisLignes } from "./comptaPnl";
import { LIGNES_FIXTURES } from "./comptaFixtures";
import { indexerMappings } from "./pastCategoryMapping";
import { calculerPnlCashEstime } from "./pastPnlCashEstime";
import { capacitesDeLOffre, droitsOrganisation } from "./offres";
import { moduleActionActif, pnlComptableActif } from "./featureFlags";
import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exigerAccesCompta } from "./comptaAcces";
import { Cible, ciblesCashEstime, ecartsVsCibles } from "./pastTargets";

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
    // Le compte est enregistré pendant la synchronisation : sa première vue précède la date de fin.
    const nouveaux = comptesNouveaux([{ numero: "1", premiereVue: "2026-03-01T10:00:00Z" }, { numero: "2", premiereVue: "2026-01-01T00:00:00Z" }], "2026-03-01T10:00:30Z");
    assert.deepEqual([...nouveaux], ["1"]);
    assert.equal(comptesNouveaux([{ numero: "1", premiereVue: "2026-03-01T10:00:00Z" }], null).size, 0);
  });
});

describe("Balance mensuelle à l'écran", () => {
  test("période partielle détectée ; mois entiers non signalés", () => {
    assert.equal(periodePartielle({ debut: "2026-03-10", fin: "2026-03-31" }), true);
    assert.equal(periodePartielle({ debut: "2026-03-01", fin: "2026-03-20" }), true);
    assert.equal(periodePartielle({ debut: "2026-01-01", fin: "2026-03-31" }), false);
  });

  test("les mois à venir ne sont jamais lus, le mois en cours l'est", () => {
    assert.deepEqual(moisALire({ debut: "2026-09-01", fin: "2026-12-31" }, "2026-10-30"), ["2026-09", "2026-10"]);
  });

  test("l'écran dit que la balance comprend le non-validé et peut changer", () => {
    assert.match(MENTION_BALANCE, /en attente de validation/);
    assert.match(TEXTE_PROVISOIRE, /évoluer jusqu'à la clôture/);
    assert.equal(TITRE_PROVISOIRE, "Comptabilité provisoire — exercice non clôturé");
    assert.match(readFileSync(join(process.cwd(), "components/PasseCompta.tsx"), "utf8"), /MENTION_BALANCE/);
  });
});

describe("Résumé d'une synchronisation", () => {
  const bilan = { statut: "partial" as const, moisDemandes: 3, moisActualises: 2, moisEnEchec: [{ mois: "2026-02", raison: "troncature" as const }], nouveauxComptes: 1, comptesIllisibles: 0, limites: [], codeErreur: null };

  test("dit ce qui est actualisé et ce qui garde ses chiffres précédents", () => {
    const texte = resumeSynchro(bilan);
    assert.match(texte, /2 mois actualisés sur 3/);
    assert.match(texte, /garde ses chiffres précédents \(réponse incomplète\)/);
    assert.match(texte, /1 nouveau compte/);
  });

  test("aucun score de fiabilité ni blocage dans l'écran", () => {
    const source = readFileSync(join(process.cwd(), "components/PasseCompta.tsx"), "utf8");
    assert.doesNotMatch(source, /score|fiabilit/i);
    assert.match(source, /TITRE_PROVISOIRE/);
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
    await services.modifier({ action: "source_stock", debut: "2026-01-01", fin: "2026-12-31", source: "novanta" });
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

describe("Garde des routes comptables", () => {
  const requete = () => new NextRequest("http://localhost/api/passe/compta?organizationId=autre");

  test("drapeau éteint : la route répond 404, sans rien lire", async () => {
    const reponse = await exigerAccesCompta(requete());
    assert.ok(reponse instanceof NextResponse);
    assert.equal(reponse.status, 404);
  });

  test("drapeau allumé, sans configuration serveur : refus, jamais un accès", async () => {
    process.env.NEXT_PUBLIC_NOVANTA_PNL_COMPTABLE = "1";
    try {
      const reponse = await exigerAccesCompta(requete());
      assert.ok(reponse instanceof NextResponse);
      assert.ok(reponse.status === 500 || reponse.status === 401);
    } finally {
      delete process.env.NEXT_PUBLIC_NOVANTA_PNL_COMPTABLE;
    }
  });
});

describe("Objectifs : source", () => {
  const part = { transactionId: "t", transactionDate: "2026-03-10", mois: "2026-03", label: "x", montant: 1000, montantTtc: 1200, montantSource: 1200, weight: 1, sourceCategoryId: "ventes", sourceCategoryName: "Ventes", etage: "revenue" as const };
  const cible = (id: string, valeur: number, source?: Cible["source"]): Cible => ({ id, type: "gross_margin_pct", dimension: "ventes", validFrom: "2026-01-01", valeur, source });

  test("anciens objectifs (source absente ou NULL) : cash estimé, lecture inchangée", () => {
    assert.equal(ciblesCashEstime([cible("a", 40), cible("b", 50, null)]).length, 2);
    const sansSource = ecartsVsCibles([cible("a", 40)], [part], [], { debut: "2026-03-01", fin: "2026-03-31" });
    const avecNull = ecartsVsCibles([cible("a", 40, null)], [part], [], { debut: "2026-03-01", fin: "2026-03-31" });
    assert.deepEqual(avecNull.margeBrute, sansSource.margeBrute);
  });

  test("une cible comptable n'est jamais comparée à un réalisé HT estimé", () => {
    const seule = ecartsVsCibles([cible("c", 40, "comptable")], [part], [], { debut: "2026-03-01", fin: "2026-03-31" });
    const aucune = ecartsVsCibles([], [part], [], { debut: "2026-03-01", fin: "2026-03-31" });
    assert.deepEqual(seule.margeBrute, aucune.margeBrute);
  });
});

describe("Module Action", () => {
  test("éteint par défaut : ni bouton de navigation, ni page", () => {
    assert.equal(moduleActionActif(), false);
    assert.match(readFileSync(join(process.cwd(), "components/NavigationModules.tsx"), "utf8"), /module\.cle !== "action" \|\| moduleActionActif\(\)/);
    assert.match(readFileSync(join(process.cwd(), "app/action/page.tsx"), "utf8"), /!supabaseConfigured \|\| !moduleActionActif\(\)/);
  });
});

describe("Page de démonstration", () => {
  test("FEC : le fichier n'est jamais envoyé, seule la préparation part", () => {
    const client = readFileSync(join(process.cwd(), "lib/comptaClient.ts"), "utf8");
    const ecran = readFileSync(join(process.cwd(), "components/PasseImportFec.tsx"), "utf8");
    assert.doesNotMatch(client + ecran, /FormData|\.arrayBuffer\(/);
    assert.match(client, /import: preparation/);
    assert.doesNotMatch(ecran, /localStorage|console\./);
  });

  test("Prévision et Essentiel : refusés côté offre, sans fonctionnalité FEC propre", () => {
    assert.equal(capacitesDeLOffre("forecast").canViewAccountingPnl, false);
    const module = readFileSync(join(process.cwd(), "components/PasseTransactions.tsx"), "utf8");
    assert.match(module, /!droits\.capacites\.canViewAccountingPnl \?/);
  });

  test("inaccessible sans son drapeau, et sans aucun accès base", () => {
    const source = readFileSync(join(process.cwd(), "app/demo/pnl/page.tsx"), "utf8");
    assert.match(source, /NEXT_PUBLIC_NOVANTA_DEMO_PNL !== "1"\) notFound\(\)/);
    assert.doesNotMatch(source, /supabase/i);
  });

  test("les écrans comptables ne lisent jamais les tables depuis le navigateur", () => {
    for (const fichier of ["components/PasseCompta.tsx", "components/PasseCorrespondanceComptable.tsx", "lib/comptaClient.ts"]) {
      const source = readFileSync(join(process.cwd(), fichier), "utf8");
      assert.doesNotMatch(source, /accounting_|supabase/i, fichier);
    }
  });
});

describe("Lecture seule côté Pennylane", () => {
  test("les routes comptables n'appellent que des lectures", () => {
    const client = readFileSync(join(process.cwd(), "lib/pennylaneClient.ts"), "utf8");
    assert.doesNotMatch(client, /method:\s*"(POST|PUT|PATCH|DELETE)"/);
    assert.doesNotMatch(readFileSync(join(process.cwd(), "lib/comptaPennylaneAdapter.ts"), "utf8"), /fetch\(/);
  });

  test("aucun jeton dans les fichiers du chantier", () => {
    for (const fichier of ["lib/comptaFixtures.ts", "lib/comptaDemo.ts", "docs/pnl-comptable-pennylane.md"]) {
      assert.doesNotMatch(readFileSync(join(process.cwd(), fichier), "utf8"), /(sb_secret_|sb_publishable_|Bearer [A-Za-z0-9_-]{16,})/, fichier);
    }
  });
});
