import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CleGroupe,
  CLES_GROUPES,
  comparer,
  construireRealise,
  construireReference,
  dateDansFuseau,
  debutJourDansFuseau,
  deciderCapture,
  empreinteResultat,
  estTerminee,
  instantCloture,
  nombreDeJoursPeriode,
  PeriodeFiabilite,
  periodeContenant,
  periodesTerminees,
  phraseEcart,
  precision,
  statutRealise,
  TotauxFlux,
  dateArrete,
  intervalleDates,
  libellePeriode,
} from "./fiabiliteProjection";
import { calculerProjectionCash, listerFluxProjetes } from "./cash-engine";
import { CorrespondanceFutur } from "./futurPnl";
import { indexerMappings } from "./pastCategoryMapping";
import { PastTransactionStockee } from "./pastTransactions";
import { cleOccurrence } from "./remplacementsOccurrences";
import { ChargeFixe, FactureFournisseur } from "./types";

const EXERCICE_CIVIL = { mois: 1, jour: 1 };
const SEPTEMBRE: PeriodeFiabilite = { type: "month", debut: "2026-09-01", fin: "2026-09-30" };
const T4: PeriodeFiabilite = { type: "quarter", debut: "2026-10-01", fin: "2026-12-31" };
const SANS_CORRESPONDANCE: CorrespondanceFutur = { axe: null, etages: new Map() };

const totaux = (encaissements: number, parGroupe: Partial<Record<CleGroupe, number>>): TotauxFlux => {
  const decaissementsParGroupe = Object.fromEntries(CLES_GROUPES.map((c) => [c, parGroupe[c] ?? 0])) as Record<CleGroupe, number>;
  const decaissements = CLES_GROUPES.reduce((s, c) => s + decaissementsParGroupe[c], 0);
  return { encaissements, decaissements, net: encaissements - decaissements, decaissementsParGroupe };
};
const score = (p: ReturnType<typeof precision>) => (p.statut === "score" ? Math.round(p.valeur * 100) / 100 : p.statut);

describe("fuseau de référence : Europe/Paris, changements d'heure compris", () => {
  test("clôture du 31 août 2026 (heure d'été) : minuit à Paris = 22:00 UTC", () => {
    assert.equal(instantCloture(SEPTEMBRE).toISOString(), "2026-08-31T22:00:00.000Z");
  });
  test("clôture du 31 décembre (heure d'hiver) : 23:00 UTC", () => {
    assert.equal(debutJourDansFuseau("2027-01-01").toISOString(), "2026-12-31T23:00:00.000Z");
  });
  test("jours de changement d'heure : minuit correct, journées de 23 h et 25 h", () => {
    assert.equal(debutJourDansFuseau("2026-03-29").toISOString(), "2026-03-28T23:00:00.000Z");
    assert.equal(debutJourDansFuseau("2026-03-30").toISOString(), "2026-03-29T22:00:00.000Z");
    assert.equal(debutJourDansFuseau("2026-10-25").toISOString(), "2026-10-24T22:00:00.000Z");
    assert.equal(debutJourDansFuseau("2026-10-26").toISOString(), "2026-10-25T23:00:00.000Z");
  });
  test("date de Paris d'un instant UTC proche de minuit", () => {
    assert.equal(dateDansFuseau(new Date("2026-08-31T21:59:00Z")), "2026-08-31");
    assert.equal(dateDansFuseau(new Date("2026-08-31T22:00:00Z")), "2026-09-01");
  });
});

describe("périodes : mois et trimestres complets", () => {
  test("mois civil ; trimestre de l'exercice", () => {
    assert.deepEqual(periodeContenant("month", "2026-09-17", EXERCICE_CIVIL), SEPTEMBRE);
    assert.deepEqual(periodeContenant("quarter", "2026-11-03", EXERCICE_CIVIL), T4);
    // Exercice d'avril à mars : le trimestre suit l'exercice, pas l'année civile.
    assert.deepEqual(periodeContenant("quarter", "2026-11-03", { mois: 4, jour: 1 }), { type: "quarter", debut: "2026-10-01", fin: "2026-12-31" });
    assert.deepEqual(periodeContenant("quarter", "2026-05-03", { mois: 2, jour: 1 }), { type: "quarter", debut: "2026-05-01", fin: "2026-07-31" });
  });
  test("par défaut : dernier mois entièrement terminé ; jamais le mois en cours", () => {
    const [dernier] = periodesTerminees("month", "2026-10-23", EXERCICE_CIVIL, 3);
    assert.deepEqual(dernier, SEPTEMBRE);
    assert.equal(estTerminee(periodeContenant("month", "2026-10-23", EXERCICE_CIVIL), "2026-10-23"), false);
    assert.equal(estTerminee(SEPTEMBRE, "2026-10-01"), true);
    assert.equal(estTerminee(SEPTEMBRE, "2026-09-30"), false);
  });
  test("trimestre de 92 jours entièrement couvert", () => {
    assert.equal(nombreDeJoursPeriode(T4), 92);
  });
});

describe("capture : figée à la clôture, jamais antidatée", () => {
  const etatVide = { officielle: false, provisoire: null };
  const cloture = instantCloture(SEPTEMBRE); // 2026-08-31T22:00Z

  test("veille au soir : capture provisoire ; trop tôt avant", () => {
    assert.equal(deciderCapture(SEPTEMBRE, new Date("2026-08-31T21:50:00Z"), etatVide, []).action, "capturer_provisoire");
    assert.equal(deciderCapture(SEPTEMBRE, new Date("2026-08-30T21:50:00Z"), etatVide, []).action, "rien");
  });

  test("provisoire confirmée si rien n'a changé entre la capture et la clôture", () => {
    const etat = { officielle: false, provisoire: { captureLe: new Date("2026-08-31T21:50:00Z") } };
    // Une modification en septembre ne touche pas la référence du 31 août.
    assert.equal(deciderCapture(SEPTEMBRE, new Date("2026-09-01T21:50:00Z"), etat, [new Date("2026-09-01T08:00:00Z")]).action, "confirmer_provisoire");
  });

  test("modification entre la capture et minuit : pas la clôture ; état actuel retenu seulement si rien n'a changé depuis", () => {
    const etat = { officielle: false, provisoire: { captureLe: new Date("2026-08-31T21:50:00Z") } };
    const avantMinuit = new Date("2026-08-31T21:55:00Z");
    assert.equal(deciderCapture(SEPTEMBRE, new Date("2026-09-01T21:50:00Z"), etat, [avantMinuit]).action, "capturer_officielle");
    assert.equal(
      deciderCapture(SEPTEMBRE, new Date("2026-09-01T21:50:00Z"), etat, [avantMinuit, new Date("2026-09-01T09:00:00Z")]).action,
      "indisponible"
    );
  });

  test("capture tardive (veille manquée) : retenue si aucune modification depuis la clôture, sinon indisponible", () => {
    assert.equal(deciderCapture(SEPTEMBRE, new Date("2026-09-03T21:50:00Z"), etatVide, [new Date("2026-08-20T10:00:00Z")]).action, "capturer_officielle");
    assert.equal(deciderCapture(SEPTEMBRE, new Date("2026-09-03T21:50:00Z"), etatVide, [new Date("2026-09-02T10:00:00Z")]).action, "indisponible");
    // Pile à la clôture : la modification appartient à la période close.
    assert.equal(deciderCapture(SEPTEMBRE, new Date("2026-09-03T21:50:00Z"), etatVide, [cloture]).action, "capturer_officielle");
  });

  test("relance idempotente : une référence officielle n'est jamais refaite", () => {
    assert.equal(deciderCapture(SEPTEMBRE, new Date("2026-09-01T21:50:00Z"), { officielle: true, provisoire: null }, []).action, "rien");
  });

  test("période terminée : pas de capture rétroactive", () => {
    assert.equal(deciderCapture(SEPTEMBRE, new Date("2026-10-02T10:00:00Z"), etatVide, []).action, "rien");
  });

  test("trimestre : sa propre référence, arrêtée au 30 septembre", () => {
    assert.equal(instantCloture(T4).toISOString(), "2026-09-30T22:00:00.000Z");
    assert.equal(deciderCapture(T4, new Date("2026-09-30T21:50:00Z"), etatVide, []).action, "capturer_provisoire");
  });
});

describe("prévision de référence : le vrai moteur, toute la période", () => {
  const charge = (patch: Partial<ChargeFixe> = {}): ChargeFixe => ({
    id: "loyer",
    libelle: "Loyer",
    montant: 1000,
    datePrevue: "2026-10-05",
    recurrence: "mensuel",
    dateFin: null,
    modeMontant: "fixe",
    tauxCalcul: null,
    sourceCalculId: null,
    sourceCalculType: null,
    aCouper: false,
    etagePnlManuel: "ebitda",
    ...patch,
  });
  const facture = (patch: Partial<FactureFournisseur> = {}): FactureFournisseur => ({
    id: "f1",
    facture: "F-1",
    fournisseur: "Bailleur",
    montant: 1050,
    dateEcheance: "2026-11-06",
    datePaiementPrevue: "2026-11-06",
    litigieuse: false,
    payee: false,
    paidAt: null,
    ...patch,
  });
  const donnees = {
    facturesClients: [],
    facturesFournisseurs: [facture()],
    chargesFixes: [charge()],
    autresDepenses: [],
    financements: [{ id: "fin", libelle: "Prêt", montant: 20000, dateEncaissementPrevue: "2026-12-15", verse: false }],
    rentreesRegulieres: [],
  };

  test("trimestre de 92 jours : les trois occurrences mensuelles, sans troncature à 90 jours", () => {
    const ref = construireReference(donnees, T4, SANS_CORRESPONDANCE);
    assert.deepEqual(ref.lignes.filter((l) => l.source === "charge_fixe").map((l) => l.date), ["2026-10-05", "2026-11-05", "2026-12-05"]);
    assert.equal(ref.couverture.jours, 92);
    assert.equal(ref.totaux.encaissements, 20000);
  });

  test("charge fixe remplacée par une facture : comptée une seule fois", () => {
    const remplacements = { montantsReels: new Map([[cleOccurrence("loyer", "2026-11-05"), 1050]]) };
    const ref = construireReference({ ...donnees, remplacements }, T4, SANS_CORRESPONDANCE);
    assert.deepEqual(
      ref.lignes.filter((l) => l.montant < 0).map((l) => [l.source, l.date, l.montant]),
      [
        ["charge_fixe", "2026-10-05", -1000],
        ["facture_fournisseur", "2026-11-06", -1050],
        ["charge_fixe", "2026-12-05", -1000],
      ]
    );
    assert.equal(ref.totaux.decaissements, 3050);
  });

  test("mêmes flux que la courbe du cockpit sur la période", () => {
    const flux = listerFluxProjetes({ ...donnees, dateDepart: T4.debut, horizonJours: 91 });
    const courbe = calculerProjectionCash({ ...donnees, soldeInitial: 0, dateDepart: T4.debut, horizonJours: 91 });
    assert.equal(courbe.serie.at(-1)!.solde, flux.reduce((s, f) => s + f.montant, 0));
  });

  test("étage enregistré à la capture ; non classé conservé dans « À classer »", () => {
    const ref = construireReference({ ...donnees, facturesFournisseurs: [facture({ etagePnlManuel: "vat" })] }, T4, SANS_CORRESPONDANCE);
    const parSource = Object.fromEntries(ref.lignes.filter((l) => l.montant < 0).map((l) => [`${l.source}:${l.date}`, [l.groupe, l.etage]]));
    assert.deepEqual(parSource["facture_fournisseur:2026-11-06"], ["extra_pnl", "vat"]);
    const sansEtage = construireReference({ ...donnees, chargesFixes: [charge({ etagePnlManuel: null })] }, T4, SANS_CORRESPONDANCE);
    assert.equal(sansEtage.totaux.decaissementsParGroupe.a_classer, 4050);
  });

  test("occurrence sans montant calculable : signalée, jamais comptée pour zéro en silence", () => {
    const calculee = charge({ id: "com", modeMontant: "calcule", tauxCalcul: 10, sourceCalculId: "absente", sourceCalculType: "rentree_reguliere", etagePnlManuel: null });
    const ref = construireReference({ ...donnees, chargesFixes: [charge(), calculee] }, T4, SANS_CORRESPONDANCE);
    assert.equal(ref.couverture.occurrencesIndisponibles.length, 3);
  });
});

describe("réalisé : flux bancaires TTC de la période", () => {
  const tx = (id: string, date: string, amount: number, categories: [string, number][] = []): PastTransactionStockee => ({
    id,
    sourceType: "pennylane",
    transactionDate: date,
    label: id,
    amount,
    currency: "EUR",
    affectations: categories.map(([nom, weight]) => ({ groupId: "axe", categoryId: nom, categoryName: nom, weight })),
  });
  const mappings = indexerMappings([
    { sourceCategoryId: "achats", sourceCategoryName: "achats", sourceGroupId: "axe", pnlStage: "gross_margin" },
    { sourceCategoryId: "tva", sourceCategoryName: "tva", sourceGroupId: "axe", pnlStage: "vat" },
    { sourceCategoryId: "virements", sourceCategoryName: "virements", sourceGroupId: "axe", pnlStage: "financing" },
    { sourceCategoryId: "ventes", sourceCategoryName: "ventes", sourceGroupId: "axe", pnlStage: "revenue" },
  ]);

  test("entrées et sorties sur les mêmes dates ; TVA sous Extra P&L, virements sous Financement", () => {
    const r = construireRealise(
      [
        tx("in", "2026-09-10", 1500, [["ventes", 1]]),
        tx("achat", "2026-09-11", -600, [["achats", 1]]),
        tx("tva", "2026-09-20", -200, [["tva", 1]]),
        tx("vir", "2026-09-21", -300, [["virements", 1]]),
        tx("hors", "2026-10-01", -999, [["achats", 1]]),
      ],
      SEPTEMBRE,
      mappings,
      "axe"
    );
    assert.equal(r.nombreTransactions, 4);
    assert.equal(r.totaux.encaissements, 1500);
    assert.equal(r.totaux.decaissements, 1100);
    assert.equal(r.totaux.decaissementsParGroupe.gross_margin, 600);
    assert.equal(r.totaux.decaissementsParGroupe.extra_pnl, 200);
    assert.equal(r.totaux.decaissementsParGroupe.financing, 300);
  });

  test("sortie non catégorisée, non mappée, partiellement ventilée ou rattachée aux encaissements : « À classer », jamais perdue", () => {
    const r = construireRealise(
      [
        tx("nue", "2026-09-02", -100),
        tx("inconnue", "2026-09-03", -50, [["mystere", 1]]),
        tx("partielle", "2026-09-04", -100, [["achats", 0.6]]),
        tx("remboursement", "2026-09-05", -30, [["ventes", 1]]),
      ],
      SEPTEMBRE,
      mappings,
      "axe"
    );
    assert.equal(r.totaux.decaissements, 280);
    assert.equal(r.totaux.decaissementsParGroupe.gross_margin, 60);
    assert.equal(r.totaux.decaissementsParGroupe.a_classer, 220);
  });
});

describe("complétude du réalisé", () => {
  const sync = (debut: string, fin: string, le: string, complete = true) => ({ debut, fin, synchroniseLe: le, complete });
  test("synchronisation complète couvrant la période, après sa fin : complet", () => {
    assert.equal(statutRealise(SEPTEMBRE, [sync("2026-01-01", "2026-10-22", "2026-10-22T08:00:00Z")], new Set(["pennylane"])).statut, "complet");
  });
  test("synchronisation pendant le mois, ou tronquée, ou absente : incomplet", () => {
    assert.equal(statutRealise(SEPTEMBRE, [sync("2026-01-01", "2026-09-30", "2026-09-29T08:00:00Z")], new Set(["pennylane"])).statut, "incomplet");
    assert.equal(statutRealise(SEPTEMBRE, [sync("2026-01-01", "2026-10-22", "2026-10-22T08:00:00Z", false)], new Set(["pennylane"])).statut, "incomplet");
    assert.equal(statutRealise(SEPTEMBRE, [], new Set()).statut, "incomplet");
  });
  test("import Excel seul : couverture non vérifiable", () => {
    assert.equal(statutRealise(SEPTEMBRE, [], new Set(["excel"])).statut, "non_verifiable");
  });
});

describe("précision : formules et exemples du ticket", () => {
  test("150 prévus, 138 réalisés : 92 % ; 100/108 : 92 % ; 100/92 : 92 %", () => {
    assert.equal(score(precision(150, 138)), 92);
    assert.equal(score(precision(100, 108)), 92);
    assert.equal(score(precision(100, 92)), 92);
  });
  test("cash net prévu 50, réel 30 : écart −20 ; écarts de 12 et 8", () => {
    const c = comparer(totaux(150, { ebitda: 100 }), totaux(138, { ebitda: 108 }));
    assert.equal(c.encaissements.ecart, -12);
    assert.equal(c.decaissements.ecart, 8);
    assert.deepEqual([c.cashNet.prevu, c.cashNet.realise, c.cashNet.ecart], [50, 30, -20]);
    assert.equal(phraseEcart(c.encaissements.ecart, String), "12 de moins que prévu");
    assert.equal(phraseEcart(c.decaissements.ecart, String), "8 de plus que prévu");
  });
  test("erreurs opposées entre étages : total juste (100 %), global 92 %", () => {
    const c = comparer(totaux(150, { gross_margin: 40, ebitda: 60 }), totaux(150, { gross_margin: 50, ebitda: 50 }));
    assert.equal(score(c.decaissements.precision), 100);
    assert.equal(c.globale.erreur, 20);
    assert.equal(c.globale.base, 250);
    assert.equal(score(c.globale), 92);
  });
  test("prévu nul : « Flux non prévu » ou « Aucun flux », jamais 100 % ni division par zéro", () => {
    assert.equal(score(precision(0, 25)), "flux_non_prevu");
    assert.equal(score(precision(0, 0)), "aucun_flux");
    assert.equal(comparer(totaux(0, {}), totaux(0, {})).globale.statut, "aucun_flux");
    assert.equal(comparer(totaux(0, {}), totaux(10, {})).globale.statut, "flux_non_prevu");
  });
  test("erreur supérieure à la base : plafonnée à 0 %, erreurs additionnées sans plafond", () => {
    assert.equal(score(precision(100, 350)), 0);
    const c = comparer(totaux(10, { ebitda: 10 }), totaux(60, { gross_margin: 40, ebitda: 0 }));
    assert.equal(c.globale.erreur, 100);
    assert.equal(score(c.globale), 0);
  });
});

describe("waterfall des décaissements : réconciliation exacte", () => {
  test("décaissements prévus + contributions = décaissements réalisés ; hausse = contribution positive", () => {
    const prevu = totaux(0, { gross_margin: 40.1, contribution_margin: 10, ebitda: 50.33, a_classer: 0 });
    const realise = totaux(0, { gross_margin: 46.1, contribution_margin: 6, ebitda: 50.33, financing: 3.7, a_classer: 12.05 });
    const c = comparer(prevu, realise);
    const somme = c.groupes.reduce((s, g) => s + g.ecart, 0);
    assert.equal(Math.round((c.decaissements.prevu + somme) * 100) / 100, c.decaissements.realise);
    assert.deepEqual(
      c.groupes.map((g) => [g.cle, g.ecart]),
      [
        ["gross_margin", 6],
        ["contribution_margin", -4],
        ["ebitda", 0],
        ["financing", 3.7],
        ["a_classer", 12.05],
      ]
    );
  });
});

describe("révisions : une correction tardive change le résultat, jamais la référence", () => {
  test("empreinte identique sans changement ; différente après une transaction tardive", () => {
    const base = construireRealise([], SEPTEMBRE, new Map(), null);
    const tardive = construireRealise(
      [{ id: "t", sourceType: "pennylane", transactionDate: "2026-09-30", label: "t", amount: -10, currency: "EUR", affectations: [] }],
      SEPTEMBRE,
      new Map(),
      null
    );
    assert.equal(empreinteResultat("ref", base, "complet"), empreinteResultat("ref", base, "complet"));
    assert.notEqual(empreinteResultat("ref", base, "complet"), empreinteResultat("ref", tardive, "complet"));
  });
});

describe("libellés : dates exactes", () => {
  test("mois, trimestre, arrêté, réalisé", () => {
    assert.equal(libellePeriode(SEPTEMBRE), "Septembre 2026");
    assert.equal(libellePeriode(T4), "Trimestre du 1er octobre au 31 décembre 2026");
    assert.equal(dateArrete(SEPTEMBRE), "31 août 2026");
    assert.equal(dateArrete(T4), "30 septembre 2026");
    assert.equal(intervalleDates(SEPTEMBRE.debut, SEPTEMBRE.fin), "du 1er au 30 septembre 2026");
    assert.equal(intervalleDates("2026-12-01", "2027-02-28"), "du 1er décembre 2026 au 28 février 2027");
  });
});
