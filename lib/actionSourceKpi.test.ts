import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CATALOGUE_KPI,
  Chantier,
  clesKpiProposees,
  definitionPersistee,
  DonneesPasse,
  erreurCompositionKpis,
  KpiChantier,
  kpiNonDisponibles,
  lirePhotographie,
  mentionDuKpi,
  mesurerSurPeriode,
  photographierChantier,
  carteDuSuivi,
  proposerReference,
  SANS_REFERENCE,
  sourceDuKpi,
  suivreKpi,
} from "./actionChantier";
import { MODELE_CORRESPONDANCE } from "./comptaCorrespondance";
import { LIGNES_FIXTURES } from "./comptaFixtures";
import { soldesDepuisLignes } from "./comptaPnl";
import { indexerMappings, MappingCategorie } from "./pastCategoryMapping";
import { EXERCICE_PAR_DEFAUT } from "./fiscalPeriods";
import { PastTransactionStockee } from "./pastTransactions";

const AXE = "axe";
const MAPPINGS: MappingCategorie[] = [{ sourceCategoryId: "ventes", sourceCategoryName: "Ventes", sourceGroupId: AXE, pnlStage: "revenue", vatRate: 20 }];
const transaction = (id: string, date: string, amount: number): PastTransactionStockee => ({
  id,
  sourceType: "pennylane",
  transactionDate: date,
  label: id,
  amount,
  currency: "EUR",
  affectations: [{ groupId: AXE, categoryId: "ventes", categoryName: "Ventes", weight: 1 }],
});

const COMPTABLE = {
  soldes: soldesDepuisLignes(LIGNES_FIXTURES, { debut: "2026-01-01", fin: "2026-12-31" }),
  regles: [...MODELE_CORRESPONDANCE],
  variationsStock: [],
  sourceStock: null,
  premiereEcriture: "2026-01-31",
};

const donnees = (comptable: DonneesPasse["comptable"] = COMPTABLE): DonneesPasse => ({
  transactions: [transaction("a", "2026-01-10", 1200), transaction("b", "2026-02-10", 2400)],
  axeId: AXE,
  mappings: indexerMappings(MAPPINGS),
  ajustements: [],
  premiereOperation: "2026-01-10",
  situationsBfr: [],
  comptable,
});

const kpi = (cle: KpiChantier["cle"], extra: Partial<KpiChantier> = {}): KpiChantier => ({
  id: cle,
  position: 1,
  cle,
  nomPersonnalise: null,
  unitePersonnalisee: null,
  sens: "up",
  reference: SANS_REFERENCE,
  cible: 100,
  ...extra,
});

const CHANTIER: Pick<Chantier, "periode"> = { periode: { debut: "2026-01-01", fin: "2026-03-31" } };
const AUJOURDHUI = "2026-04-15";

describe("Source d'un indicateur", () => {
  test("anciens chantiers (source NULL) : définition d'origine, résolue par la clé", () => {
    assert.equal(sourceDuKpi({ cle: "marge_brute", source: null }), "cash_estime");
    assert.equal(sourceDuKpi({ cle: "ebitda" }), "cash_estime");
    assert.equal(sourceDuKpi({ cle: "cash_flow_operationnel", source: null }), "tresorerie");
    assert.equal(sourceDuKpi({ cle: "bfr", source: null }), "bfr");
    assert.equal(sourceDuKpi({ cle: "custom", source: null }), "manuel");
  });

  test("source persistée prioritaire", () => {
    assert.equal(sourceDuKpi({ cle: "compta_resultat_net", source: "comptable" }), "comptable");
  });

  test("catalogue historique inchangé : mêmes bases, mêmes sens", () => {
    assert.equal(CATALOGUE_KPI.marge_brute.base, "ht");
    assert.equal(CATALOGUE_KPI.cash_flow_operationnel.base, "ttc");
    assert.equal(CATALOGUE_KPI.bfr.sens, "down");
    assert.equal(mentionDuKpi("marge_brute"), "HT estimé");
    assert.equal(mentionDuKpi("cash_flow_operationnel"), "TTC");
    assert.equal(mentionDuKpi("compta_ebitda"), "Comptable");
  });

  test("définition stable et explicite, persistée au lancement", () => {
    assert.deepEqual(definitionPersistee("compta_resultat_net"), { version: 1, libelle: "Résultat net", nature: "cumulatif", unite: "eur", base: "comptable", source: "comptable", sens: "up" });
    assert.equal(definitionPersistee("marge_brute")!.base, "ht");
    assert.equal(definitionPersistee("custom"), null);
  });

  test("indicateurs comptables proposés uniquement si le P&L comptable est accessible", () => {
    assert.ok(!clesKpiProposees(false).some((c) => c.startsWith("compta_")));
    assert.ok(clesKpiProposees(true).includes("compta_resultat_net"));
    assert.ok(kpiNonDisponibles(false).some((k) => k.libelle === "Résultat net"));
    assert.ok(!kpiNonDisponibles(true).some((k) => k.libelle === "Résultat net" || k.libelle === "Marge nette"));
    assert.ok(kpiNonDisponibles(false).some((k) => k.libelle === "Marge nette"));
  });

  test("règles d'Action inchangées : trois KPI, au plus un manuel, comptables compris", () => {
    assert.equal(erreurCompositionKpis([{ cle: "compta_ebitda" }, { cle: "ebitda" }, { cle: "custom" }]), null);
    assert.match(erreurCompositionKpis([{ cle: "compta_ebitda" }, { cle: "ebitda" }])!, /exactement 3/);
    assert.match(erreurCompositionKpis([{ cle: "custom" }, { cle: "custom" }, { cle: "ebitda" }])!, /Un seul/);
  });
});

describe("Mesures par source", () => {
  const janvier = { debut: "2026-01-01", fin: "2026-01-31" };

  test("KPI cash estimé : transactions en HT estimé", () => {
    assert.equal(mesurerSurPeriode("encaissements", donnees(), janvier).valeur, 1000);
  });

  test("KPI comptable : écritures seulement, jamais les transactions", () => {
    assert.equal(mesurerSurPeriode("compta_chiffre_affaires", donnees(), janvier).valeur, 100_000);
  });

  test("KPI de trésorerie : flux TTC", () => {
    assert.equal(mesurerSurPeriode("cash_flow_operationnel", donnees(), janvier).valeur, 1200);
  });

  test("sans écriture : aucune valeur, jamais un repli sur le cash estimé", () => {
    const m = mesurerSurPeriode("compta_chiffre_affaires", donnees(null), janvier);
    assert.equal(m.valeur, null);
    assert.match(m.raison!, /Aucune écriture/);
  });

  test("taux comptable en points de %, recalculé sur les montants agrégés", () => {
    const m = mesurerSurPeriode("compta_taux_marge_brute", donnees(), janvier);
    assert.equal(m.valeur, 70);
  });

  test("marge nette : résultat net rapporté au CA comptable, aucun recours au cash estimé", () => {
    const m = mesurerSurPeriode("compta_marge_nette", donnees(), janvier);
    assert.equal(m.valeur, ((100_000 - 30_000 - 5_000 - 4_000 - 20_000 - 2_000) / 100_000) * 100);
    assert.equal(mesurerSurPeriode("compta_marge_nette", donnees(null), janvier).valeur, null);
  });

  test("changement de période : la valeur suit les dates", () => {
    const fevrier = mesurerSurPeriode("compta_chiffre_affaires", donnees(), { debut: "2026-02-01", fin: "2026-02-28" }).valeur;
    assert.equal(fevrier, 97_500);
  });

  test("compte sans correspondance : valeur présentée avec son avertissement", () => {
    const mars = mesurerSurPeriode("compta_resultat_net", donnees(), { debut: "2026-03-01", fin: "2026-03-31" });
    assert.match(mars.avertissements[0], /sans correspondance comptable/);
  });
});

describe("Références et suivi", () => {
  const avril = { debut: "2026-04-01", fin: "2026-04-30" };
  const libelle = (p: { debut: string }) => p.debut;

  test("référence d'un KPI comptable lue dans les écritures", () => {
    const r = proposerReference("compta_chiffre_affaires", "month", avril, libelle, donnees(), AUJOURDHUI);
    assert.equal(r.origine, "previous");
    assert.equal(r.valeur, 115_000);
  });

  test("référence d'un KPI cash estimé : inchangée, sans lecture comptable", () => {
    const r = proposerReference("encaissements", "month", { debut: "2026-03-01", fin: "2026-03-31" }, libelle, donnees(), AUJOURDHUI);
    assert.equal(r.valeur, 2000);
  });

  test("sans écriture : pas de référence comptable, jamais un zéro", () => {
    const r = proposerReference("compta_chiffre_affaires", "month", avril, libelle, donnees(null), AUJOURDHUI);
    assert.equal(r.valeur, null);
    assert.equal(r.origine, "none");
  });

  test("suivi d'un KPI comptable : mois par mois, cumulé depuis le début", () => {
    const s = suivreKpi(kpi("compta_chiffre_affaires", { source: "comptable" }), CHANTIER, donnees(), [], AUJOURDHUI);
    assert.deepEqual(s.points.map((p) => p.valeur), [100_000, 197_500, 312_500]);
  });

  test("ancien KPI sans source : suivi identique à avant", () => {
    const s = suivreKpi(kpi("encaissements", { source: null }), CHANTIER, donnees(), [], AUJOURDHUI);
    assert.deepEqual(s.points.map((p) => p.valeur), [1000, 3000, 3000]);
  });

  test("source enregistrée incompatible : aucune valeur, aucune conversion silencieuse", () => {
    const s = suivreKpi(kpi("marge_brute", { source: "comptable", reference: { valeur: 50, libelle: "x", origine: "previous", periode: null } }), CHANTIER, donnees(), [], AUJOURDHUI);
    assert.ok(s.points.every((p) => p.valeur === null));
    assert.equal(s.actuelle, null);
    assert.match(s.messages[0], /Source de l'indicateur/);
  });

  test("KPI comptable sans écriture : message propre à la comptabilité", () => {
    const s = suivreKpi(kpi("compta_ebitda", { source: "comptable" }), CHANTIER, donnees(null), [], AUJOURDHUI);
    assert.equal(s.etat, "insuffisant");
    assert.match(s.messages[0], /écriture comptable/);
  });

  test("changer la correspondance recalcule un chantier actif, pas sa référence figée", () => {
    const reference = { valeur: 123, libelle: "T1", origine: "previous" as const, periode: null };
    const avant = suivreKpi(kpi("compta_ebitda", { source: "comptable", reference }), CHANTIER, donnees(), [], AUJOURDHUI);
    const autres = { ...COMPTABLE, regles: MODELE_CORRESPONDANCE.map((r) => (r.prefixe === "64" ? { ...r, destination: "depreciation" as const } : r)) };
    const apres = suivreKpi(kpi("compta_ebitda", { source: "comptable", reference }), CHANTIER, donnees(autres), [], AUJOURDHUI);
    assert.notEqual(avant.actuelle!.valeur, apres.actuelle!.valeur);
    assert.equal(apres.kpi.reference.valeur, 123);
  });

  test("chantier clôturé : la photographie ne dépend plus de la correspondance", () => {
    const suivi = suivreKpi(kpi("compta_ebitda", { source: "comptable" }), CHANTIER, donnees(), [], AUJOURDHUI);
    const carte = carteDuSuivi(suivi, "quarter", EXERCICE_PAR_DEFAUT);
    const photo = photographierChantier({ titre: "t", changement: "c", typePeriode: "quarter", periode: CHANTIER.periode }, [carte, carte, carte], EXERCICE_PAR_DEFAUT, AUJOURDHUI, "2026-04-15T10:00:00Z");
    const relue = lirePhotographie(JSON.parse(JSON.stringify(photo)))!;
    const valeur = relue.cartes[0].suivi.actuelle!.valeur;
    suivi.actuelle!.valeur = -1;
    assert.equal(relue.cartes[0].suivi.kpi.source, "comptable");
    assert.notEqual(valeur, -1);
    assert.equal(relue.cartes[0].mention, "Comptable");
  });

  test("une ancienne photographie sans source reste lisible", () => {
    const suivi = suivreKpi(kpi("ebitda"), CHANTIER, donnees(), [], AUJOURDHUI);
    const carte = carteDuSuivi(suivi, "quarter", EXERCICE_PAR_DEFAUT);
    const brut = JSON.parse(JSON.stringify(photographierChantier({ titre: "t", changement: "c", typePeriode: "quarter", periode: CHANTIER.periode }, [carte, carte, carte], EXERCICE_PAR_DEFAUT, AUJOURDHUI, "x")));
    delete brut.cartes[0].suivi.kpi.source;
    assert.ok(lirePhotographie(brut));
  });
});
