import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FactureBfr } from "./pastBfr";
import { comparerAvecPrecedente, dansLaCategorie, delaisDeLaCohorte, FiltreCategorie, libelleSeuil, seuilValide, delaisDuMois, nombreDelaisIncertains, periodeDuMois, joursEntre, libelleEcartEcheance, libelleRetardOuverte, libelleTrancheDansPhrase, libelleVariationJours, niveauDeDispersion } from "./pastBfrDelais";

const SEPTEMBRE = { debut: "2026-09-01", fin: "2026-09-30" };
const AUJOURDHUI = "2026-10-28";

let n = 0;
// Facture client fictive, émise le 01/09, 1 000 € HT, échéance au 01/10, réglée le 16/10 (45 j).
function facture(champs: Partial<FactureBfr> & { regleeLe?: string | null } = {}): FactureBfr {
  const { regleeLe = "2026-10-16", ...reste } = champs;
  n++;
  return {
    pennylaneId: `f${n}`,
    type: "client",
    numero: `FA-${n}`,
    tiers: "Client Alpha",
    dateEmission: "2026-09-01",
    echeance: "2026-10-01",
    devise: "EUR",
    montantTtc: 1_200,
    montantHt: 1_000,
    resteTtc: regleeLe === null ? 1_200 : 0,
    resteHt: regleeLe === null ? 1_000 : 0,
    exclusion: null,
    factureAvoireeId: null,
    reglements: regleeLe === null ? null : [{ date: regleeLe, montant: 1_200 }],
    ...reste,
  };
}
const cohorte = (factures: FactureBfr[], cote: "client" | "fournisseur" = "client") => delaisDeLaCohorte(factures, cote, SEPTEMBRE, AUJOURDHUI);
const proche = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

describe("délai réel de paiement", () => {
  test("émise le 01/09, payée le 16/10 : 45 jours", () => {
    assert.equal(joursEntre("2026-09-01", "2026-10-16"), 45);
    const c = cohorte([facture()]);
    assert.equal(c.reglees[0].delai, 45);
    proche(c.delaiMoyen, 45);
  });

  test("écart à l'échéance : payée avant ou après", () => {
    const apres = cohorte([facture({ regleeLe: "2026-10-13" })]);
    assert.equal(apres.reglees[0].ecartEcheance, 12);
    assert.equal(libelleEcartEcheance(12), "+12 j après échéance");
    const avant = cohorte([facture({ regleeLe: "2026-09-25" })]);
    assert.equal(avant.reglees[0].ecartEcheance, -6);
    assert.equal(libelleEcartEcheance(-6), "6 j avant échéance");
  });

  test("moyenne pondérée par le montant HT : une grosse facture pèse en proportion", () => {
    const c = cohorte([facture({ montantHt: 1_000, regleeLe: "2026-09-11" }), facture({ montantHt: 9_000, regleeLe: "2026-10-31" })]);
    // 1 000 × 10 j + 9 000 × 60 j, sur 10 000 € : 55 j (la moyenne simple serait 35 j).
    proche(c.delaiMoyen, 55);
  });

  test("payée en plusieurs fois : délai jusqu'au règlement final", () => {
    const c = cohorte([facture({ reglements: [{ date: "2026-09-20", montant: 600 }, { date: "2026-10-31", montant: 600 }] })]);
    assert.equal(c.reglees[0].dateReglement, "2026-10-31");
    assert.equal(c.reglees[0].delai, 60);
  });

  test("partiellement payée, pas encore soldée : ouverte, jamais dans la moyenne", () => {
    const partielle = facture({ resteTtc: 600, resteHt: 500, reglements: [{ date: "2026-09-20", montant: 600 }] });
    const c = cohorte([facture(), partielle]);
    assert.equal(c.reglees.length, 1);
    assert.equal(c.ouvertes.length, 1);
    proche(c.delaiMoyen, 45);
    assert.equal(c.statut, "provisoire");
  });

  test("facture ouverte : ancienneté actuelle = date de référence − émission, à part", () => {
    const c = cohorte([facture({ regleeLe: null, dateEmission: "2026-09-20" })]);
    assert.equal(c.ouvertes[0].anciennete, 38);
    proche(c.ancienneteMoyenneOuvertes, 38);
    assert.equal(c.delaiMoyen, null);
  });

  test("fournisseur couvert à 98 % (écart de change) : soldé, comme pour la synchronisation", () => {
    const c = cohorte([facture({ type: "fournisseur", resteTtc: 20, resteHt: 16 })], "fournisseur");
    assert.equal(c.reglees.length, 1);
    const client = cohorte([facture({ resteTtc: 20, resteHt: 16 })]);
    assert.equal(client.reglees.length, 0, "côté clients, un reste dû non nul laisse la facture ouverte");
  });
});

describe("exclusions : signalées, jamais intégrées en silence", () => {
  test("règlement avant émission, sans date réelle, règlements non récupérés, montant HT absent", () => {
    const c = cohorte([
      facture({ regleeLe: "2026-08-20" }),
      facture({ reglements: [] }),
      facture({ reglements: null, resteTtc: 0 }),
      facture({ montantHt: null }),
      facture(),
    ]);
    assert.deepEqual(c.exclues.map((f) => f.raison).sort(), ["montant_ht_absent", "reglement_avant_emission", "reglements_non_recuperes", "sans_date_reglement"]);
    assert.equal(c.reglees.length, 1);
    proche(c.delaiMoyen, 45);
  });

  test("facture annulée, version remplacée, entièrement annulée par avoir : exclues ; avoir et brouillon hors cohorte", () => {
    const annuleeParAvoir = facture({ resteTtc: 0, reglements: [] });
    const avoir = facture({ exclusion: "avoir", factureAvoireeId: annuleeParAvoir.pennylaneId });
    const c = cohorte([facture({ exclusion: "annulee" }), facture({ exclusion: "archivee" }), annuleeParAvoir, avoir, facture({ exclusion: "brouillon" })]);
    assert.deepEqual(c.exclues.map((f) => f.raison).sort(), ["annulee", "annulee", "remplacee"]);
    assert.equal(c.reglees.length + c.ouvertes.length, 0);
  });

  test("échéance absente : délai compté, écart à l'échéance non calculé pour elle", () => {
    const c = cohorte([facture({ echeance: null }), facture({ regleeLe: "2026-10-11" })]);
    assert.equal(c.sansEcheance, 1);
    proche(c.ecartEcheanceMoyen, 10);
    proche(c.delaiMoyen, 42.5);
  });
});

describe("cohorte par date d'émission", () => {
  test("émise en septembre, payée en novembre : dans septembre, jamais dans novembre", () => {
    const f = facture({ dateEmission: "2026-09-25", regleeLe: "2026-11-20" });
    assert.equal(cohorte([f]).reglees.length, 1);
    assert.equal(delaisDeLaCohorte([f], "client", { debut: "2026-11-01", fin: "2026-11-30" }, "2026-12-15").reglees.length, 0);
  });

  test("une facture réglée tardivement enrichit sa cohorte historique ; provisoire tant qu'une reste ouverte", () => {
    const ouverte = facture({ regleeLe: null });
    assert.equal(cohorte([facture(), ouverte]).statut, "provisoire");
    const soldee = { ...ouverte, resteTtc: 0, resteHt: 0, reglements: [{ date: "2026-11-30", montant: 1_200 }] };
    const apres = delaisDeLaCohorte([facture(), soldee], "client", SEPTEMBRE, "2026-12-01");
    assert.equal(apres.statut, "stabilise");
    proche(apres.delaiMoyen, (45 + 90) / 2);
  });

  test("trimestre : même calcul sur une période plus longue", () => {
    const t3 = delaisDeLaCohorte([facture({ dateEmission: "2026-07-15", regleeLe: "2026-08-14" }), facture()], "client", { debut: "2026-07-01", fin: "2026-09-30" }, AUJOURDHUI);
    assert.equal(t3.reglees.length, 2);
  });
});

describe("distribution", () => {
  const regleesA = (delais: number[], montant = 1_000) =>
    delais.map((d) => facture({ montantHt: montant, regleeLe: new Date(Date.UTC(2026, 8, 1 + d)).toISOString().slice(0, 10) }));

  test("100 % à 45 jours", () => {
    const c = cohorte(regleesA([45, 45, 45, 45]));
    const t = c.tranches.find((x) => x.cle === "31-45")!;
    assert.deepEqual([t.partNombre, t.partMontant], [1, 1]);
  });

  test("même moyenne (45 j), distributions différentes : 30/60 contre 5/85", () => {
    const a = cohorte(regleesA([30, 60]));
    const b = cohorte(regleesA([5, 85]));
    proche(a.delaiMoyen, 45);
    proche(b.delaiMoyen, 45);
    assert.deepEqual(a.tranches.filter((t) => t.partNombre > 0).map((t) => t.cle), ["16-30", "46-60"]);
    assert.deepEqual(b.tranches.filter((t) => t.partNombre > 0).map((t) => t.cle), ["0-15", "61-90"]);
  });

  test("parts en nombre et en montant : chacune somme à 100 %, et elles diffèrent", () => {
    const c = cohorte([...regleesA([10, 10, 10], 1_000), ...regleesA([70], 7_000)]);
    proche(c.tranches.reduce((s, t) => s + t.partNombre, 0), 1);
    proche(c.tranches.reduce((s, t) => s + t.partMontant, 0), 1);
    const courte = c.tranches.find((t) => t.cle === "0-15")!;
    assert.deepEqual([courte.partNombre, courte.partMontant], [0.75, 0.3]);
  });

  test("seuils : 90 j dans 61–90, 91 j au-delà ; tri par délai décroissant dans une tranche", () => {
    const c = cohorte(regleesA([90, 91, 62, 75]));
    assert.deepEqual(c.tranches.find((t) => t.cle === "61-90")!.factures.map((f) => f.delai), [90, 75, 62]);
    assert.deepEqual(c.tranches.find((t) => t.cle === "91+")!.factures.map((f) => f.delai), [91]);
    assert.equal(c.tranches.find((t) => t.cle === "91+")!.libelle, "+90 j");
  });

  test("dispersion P10–P90 seulement à partir de 10 factures réglées", () => {
    assert.equal(cohorte(regleesA([10, 20, 30])).dispersion, null);
    const c = cohorte(regleesA([5, 28, 30, 35, 40, 45, 50, 55, 63, 120]));
    assert.deepEqual(c.dispersion, { part: 0.8, min: 5, max: 63 });
  });

  test("volume faible : moins de 3 factures réglées, moyenne non représentative", () => {
    assert.equal(cohorte(regleesA([10, 20])).representatif, false);
    assert.equal(cohorte(regleesA([10, 20, 30])).representatif, true);
    assert.equal(cohorte([]).delaiMoyen, null);
  });
});

describe("libellés", () => {
  test("variation et écart, signes explicites", () => {
    assert.equal(libelleVariationJours(4.2), "+4 j");
    assert.equal(libelleVariationJours(-2), "−2 j");
    assert.equal(libelleEcartEcheance(0.2), "à l'échéance");
  });
});

describe("dispersion : écart-type pondéré HT et niveau relatif à la moyenne", () => {
  const regleesA = (delais: number[], montants?: number[]) =>
    delais.map((d, i) => facture({ montantHt: montants?.[i] ?? 1_000, regleeLe: new Date(Date.UTC(2026, 8, 1 + d)).toISOString().slice(0, 10) }));

  test("même moyenne de 45 j : 100 % à 45 j faible, 30/60 modérée, 5/85 forte", () => {
    const homogene = cohorte(regleesA([45, 45, 45]));
    assert.deepEqual([homogene.ecartType, homogene.niveauDispersion], [0, "faible"]);
    const moyenne = cohorte(regleesA([30, 60, 30, 60]));
    proche(moyenne.ecartType, 15);
    assert.equal(moyenne.niveauDispersion, "moderee");
    const dispersee = cohorte(regleesA([5, 85, 5, 85]));
    proche(dispersee.ecartType, 40);
    assert.equal(dispersee.niveauDispersion, "forte");
  });

  test("écart-type pondéré par les montants HT, pas par le nombre", () => {
    // 10 j sur 1 000 €, 60 j sur 9 000 € : μ = 55, σ = √((1 000·45² + 9 000·5²) / 10 000) = 15.
    const c = cohorte(regleesA([10, 60, 60], [1_000, 4_500, 4_500]));
    proche(c.delaiMoyen, 55);
    proche(c.ecartType, 15);
  });

  test("relatif à la moyenne : σ 20 j est faible autour de 90 j, fort autour de 15 j", () => {
    assert.equal(niveauDeDispersion(90, 20), "faible");
    assert.equal(niveauDeDispersion(15, 20), "forte");
    assert.equal(niveauDeDispersion(0, 0), "faible", "moyenne nulle sans division invalide");
  });

  test("moins de 3 factures réglées : pas de niveau de dispersion", () => {
    assert.equal(cohorte(regleesA([10, 80])).niveauDispersion, null);
  });

  test("les factures ouvertes n'entrent ni dans la moyenne ni dans l'écart-type", () => {
    const avecOuvertes = cohorte([...regleesA([45, 45, 45]), facture({ regleeLe: null, dateEmission: "2026-09-01" })]);
    assert.deepEqual([avecOuvertes.delaiMoyen, avecOuvertes.ecartType, avecOuvertes.niveauDispersion], [45, 0, "faible"]);
  });

  test("tranche dominante : « 67 % des factures réglées en ≤ 15 j »", () => {
    const c = cohorte(regleesA([5, 10, 40]));
    assert.equal(c.trancheDominante!.tranche.cle, "0-15");
    proche(c.trancheDominante!.part, 2 / 3);
    assert.equal(libelleTrancheDansPhrase(c.trancheDominante!.tranche), "en ≤ 15 j");
    assert.equal(libelleTrancheDansPhrase({ min: 31, max: 45 }), "entre 31 et 45 j");
    assert.equal(libelleTrancheDansPhrase({ min: 91, max: null }), "en plus de 90 j");
  });
});

describe("factures encore ouvertes", () => {
  test("nombre, montant HT, ancienneté pondérée ; retard à date par rapport à l'échéance", () => {
    const c = cohorte([
      facture({ regleeLe: null, dateEmission: "2026-09-01", echeance: "2026-09-16", montantHt: 3_000 }),
      facture({ regleeLe: null, dateEmission: "2026-09-30", echeance: "2026-11-09", montantHt: 1_000 }),
      facture(),
    ]);
    assert.equal(c.ouvertes.length, 2);
    assert.equal(c.montantOuvertes, 4_000);
    // 57 j sur 3 000 €, 28 j sur 1 000 € : 49,75 j.
    proche(c.ancienneteMoyenneOuvertes, 49.75);
    assert.deepEqual(c.ouvertes.map((f) => f.retardEcheance), [42, -12]);
    assert.equal(libelleRetardOuverte(42), "+42 j de retard");
    assert.equal(libelleRetardOuverte(-12), "échéance dans 12 j");
    proche(c.delaiMoyen, 45);
  });
});

describe("évolution vs période précédente : chaque indicateur contre lui-même", () => {
  const AOUT = { debut: "2026-08-01", fin: "2026-08-31" };
  // Factures réglées d'une cohorte : [émission, échéance, règlement, montant HT].
  const lot = (lignes: [string, string | null, string, number][]) =>
    lignes.map(([emission, echeance, regleeLe, montantHt]) => facture({ dateEmission: emission, echeance, regleeLe, montantHt }));
  const deuxPeriodes = (aout: FactureBfr[], septembre: FactureBfr[]) => {
    const tout = [...aout, ...septembre];
    const a = delaisDeLaCohorte(tout, "client", AOUT, AUJOURDHUI);
    const s = delaisDeLaCohorte(tout, "client", SEPTEMBRE, AUJOURDHUI);
    return { a, s, comparaison: comparerAvecPrecedente(s, a) };
  };

  test("CAS 1 : écart août +2 j, septembre −8 j -> delta d'écart −10 j", () => {
    const { a, s, comparaison } = deuxPeriodes(
      lot([["2026-08-01", "2026-08-31", "2026-09-02", 1_000], ["2026-08-05", "2026-09-04", "2026-09-06", 1_000], ["2026-08-10", "2026-09-09", "2026-09-11", 1_000]]),
      lot([["2026-09-01", "2026-10-01", "2026-09-23", 1_000], ["2026-09-05", "2026-10-05", "2026-09-27", 1_000], ["2026-09-10", "2026-10-10", "2026-10-02", 1_000]])
    );
    proche(a.ecartEcheanceMoyen, 2);
    proche(s.ecartEcheanceMoyen, -8);
    proche(comparaison.ecartEcheance, -10);
  });

  test("CAS 2 (cas observé) : écart +14 j puis −8 j -> −22 j, alors que le délai baisse de 10 j seulement", () => {
    // Août : termes à 30 j, payées 44 j après émission (délai 44, écart +14).
    // Septembre : termes à 42 j, payées 34 j après émission (délai 34, écart −8).
    const { a, s, comparaison } = deuxPeriodes(
      lot([["2026-08-01", "2026-08-31", "2026-09-14", 2_000], ["2026-08-10", "2026-09-09", "2026-09-23", 3_000], ["2026-08-20", "2026-09-19", "2026-10-03", 5_000]]),
      lot([["2026-09-01", "2026-10-13", "2026-10-05", 2_000], ["2026-09-10", "2026-10-22", "2026-10-14", 3_000], ["2026-09-20", "2026-11-01", "2026-10-24", 5_000]])
    );
    proche(a.delaiMoyen, 44);
    proche(a.ecartEcheanceMoyen, 14);
    proche(s.delaiMoyen, 34);
    proche(s.ecartEcheanceMoyen, -8);
    // Deux métriques, deux deltas : le −10 j est celui du délai, pas de l'écart.
    proche(comparaison.delai, -10);
    proche(comparaison.ecartEcheance, -22);
  });

  test("CAS 3 : facture sans échéance comptée dans le délai, exclue de l'écart", () => {
    const { s } = deuxPeriodes([], lot([["2026-09-01", null, "2026-10-01", 1_000], ["2026-09-01", "2026-10-01", "2026-10-11", 1_000]]));
    proche(s.delaiMoyen, 35);
    proche(s.ecartEcheanceMoyen, 10);
    assert.equal(s.sansEcheance, 1);
  });

  test("CAS 4 : facture ouverte exclue des deux moyennes réalisées, et du delta", () => {
    const base = lot([["2026-09-01", "2026-10-01", "2026-10-11", 1_000]]);
    const sans = delaisDeLaCohorte(base, "client", SEPTEMBRE, AUJOURDHUI);
    const avec = delaisDeLaCohorte([...base, facture({ regleeLe: null, montantHt: 50_000 })], "client", SEPTEMBRE, AUJOURDHUI);
    assert.deepEqual([avec.delaiMoyen, avec.ecartEcheanceMoyen], [sans.delaiMoyen, sans.ecartEcheanceMoyen]);
  });

  test("CAS 5 : pondération HT identique pour le délai et l'écart, des deux côtés", () => {
    const { s } = deuxPeriodes([], lot([["2026-09-01", "2026-10-01", "2026-09-21", 1_000], ["2026-09-01", "2026-10-01", "2026-10-31", 9_000]]));
    proche(s.delaiMoyen, (1_000 * 20 + 9_000 * 60) / 10_000);
    proche(s.ecartEcheanceMoyen, (1_000 * -10 + 9_000 * 30) / 10_000);
  });

  test("CAS 6 : mois précédent sans données fiables -> aucun delta", () => {
    const { comparaison } = deuxPeriodes(lot([["2026-08-01", "2026-08-31", "2026-09-02", 1_000]]), lot([["2026-09-01", "2026-10-01", "2026-10-11", 1_000]]));
    assert.deepEqual(comparaison, { delai: null, ecartEcheance: null });
    const vide = deuxPeriodes([], lot([["2026-09-01", "2026-10-01", "2026-10-11", 1_000]]));
    assert.deepEqual(vide.comparaison, { delai: null, ecartEcheance: null });
  });

  test("fournisseurs : même règle", () => {
    const f = (emission: string, echeance: string, regleeLe: string) => facture({ type: "fournisseur", dateEmission: emission, echeance, regleeLe });
    const tout = [
      f("2026-08-01", "2026-08-31", "2026-09-10"), f("2026-08-02", "2026-09-01", "2026-09-11"), f("2026-08-03", "2026-09-02", "2026-09-12"),
      f("2026-09-01", "2026-10-01", "2026-10-01"), f("2026-09-02", "2026-10-02", "2026-10-02"), f("2026-09-03", "2026-10-03", "2026-10-03"),
    ];
    const c = comparerAvecPrecedente(delaisDeLaCohorte(tout, "fournisseur", SEPTEMBRE, AUJOURDHUI), delaisDeLaCohorte(tout, "fournisseur", AOUT, AUJOURDHUI));
    proche(c.delai, -10);
    proche(c.ecartEcheance, -10);
  });
});

describe("Délais — cohorte mensuelle partagée par le KPI et le graphique", () => {
  test("période du mois : du 1er au dernier jour calendaire, février bissextile compris", () => {
    assert.deepEqual(periodeDuMois("2026-09"), { debut: "2026-09-01", fin: "2026-09-30" });
    assert.deepEqual(periodeDuMois("2026-02"), { debut: "2026-02-01", fin: "2026-02-28" });
    assert.deepEqual(periodeDuMois("2028-02"), { debut: "2028-02-01", fin: "2028-02-29" });
    assert.deepEqual(periodeDuMois("2026-10"), { debut: "2026-10-01", fin: "2026-10-31" });
  });

  test("le point de septembre est exactement la moyenne du KPI de septembre", () => {
    const factures = [
      facture({ dateEmission: "2026-09-02", regleeLe: "2026-10-12" }),
      facture({ dateEmission: "2026-09-30", regleeLe: "2026-10-05", montantHt: 3_000 }),
      facture({ dateEmission: "2026-10-01", regleeLe: "2026-10-02" }),
      facture({ dateEmission: "2026-08-31", regleeLe: "2026-09-01" }),
    ];
    const graphique = delaisDuMois(factures, "client", "2026-09", AUJOURDHUI);
    assert.equal(graphique.delaiMoyen, cohorte(factures).delaiMoyen);
    assert.equal(graphique.reglees.length, 2);
  });

  test("un mois sans facture réglée n'a pas de délai : jamais 0", () => {
    assert.equal(delaisDuMois([facture({ regleeLe: null })], "client", "2026-09", AUJOURDHUI).delaiMoyen, null);
    assert.equal(delaisDuMois([], "fournisseur", "2026-03", AUJOURDHUI).delaiMoyen, null);
  });
});

describe("Délais — factures au paiement incertain : réserve, jamais un blocage", () => {
  test("hors des moyennes et comptées ; une facture annulée n'est pas une incertitude", () => {
    const c = cohorte([
      facture(),
      facture({ regleeLe: null, resteTtc: 0, resteHt: 0, reglements: [] }),
      facture({ regleeLe: null, resteTtc: 0, resteHt: 0, reglements: null }),
      facture({ exclusion: "annulee" }),
    ]);
    assert.equal(c.reglees.length, 1);
    assert.equal(c.delaiMoyen, 45);
    assert.equal(nombreDelaisIncertains(c), 2);
  });
});

describe("seuil de montant des délais", () => {
  // Petites factures payées vite (2 j), grosses payées lentement (45 j) : la moyenne « toutes » est tirée vers le bas.
  const petite = (regleeLe = "2026-09-03") => facture({ montantHt: 200, montantTtc: 240, regleeLe });
  const grosse = (montantHt: number, regleeLe = "2026-10-16") => facture({ montantHt, montantTtc: montantHt * 1.2, regleeLe });
  const parSeuil = (factures: FactureBfr[], seuil: number | null) => delaisDeLaCohorte(factures, "client", SEPTEMBRE, AUJOURDHUI, { seuilHt: seuil });

  test("Toutes : résultat identique à l'appel sans seuil", () => {
    const factures = [petite(), petite(), grosse(6_000), grosse(12_000), facture({ regleeLe: null, montantHt: 300, montantTtc: 360 })];
    const sans = delaisDeLaCohorte(factures, "client", SEPTEMBRE, AUJOURDHUI);
    const toutes = parSeuil(factures, null);
    assert.deepEqual(toutes, sans);
    assert.equal(toutes.filtre.seuilHt, null);
    proche(toutes.filtre.couverture, 1);
    assert.equal(toutes.filtre.regleesSousSeuil.nombre, 0);
  });

  test("> 1 000, > 5 000, > 10 000 : population, moyenne, dispersion et couverture recalculées", () => {
    const factures = [petite(), petite(), petite(), grosse(1_500, "2026-09-11"), grosse(6_000), grosse(12_000, "2026-10-31")];
    const total = 600 + 1_500 + 6_000 + 12_000;
    const t = parSeuil(factures, null);
    assert.equal(t.reglees.length, 6);

    const m1 = parSeuil(factures, 1_000);
    assert.equal(m1.reglees.length, 3);
    proche(m1.delaiMoyen, (1_500 * 10 + 6_000 * 45 + 12_000 * 60) / 19_500);
    proche(m1.filtre.couverture, 19_500 / total);
    assert.deepEqual(m1.filtre.regleesSousSeuil, { nombre: 3, montant: 600 });

    const m5 = parSeuil(factures, 5_000);
    assert.equal(m5.reglees.length, 2);
    proche(m5.delaiMoyen, (6_000 * 45 + 12_000 * 60) / 18_000);
    assert.equal(m5.niveauDispersion, null); // 2 factures : pas de niveau de dispersion
    assert.equal(m5.representatif, false);
    assert.equal(m5.tranches.reduce((s, tr) => s + tr.factures.length, 0), 2);
    proche(m5.tranches.reduce((s, tr) => s + tr.partMontant, 0), 1);

    const m10 = parSeuil(factures, 10_000);
    assert.equal(m10.reglees.length, 1);
    proche(m10.delaiMoyen, 60);
    proche(m10.ecartType, 0);
    assert.ok(m10.delaiMoyen! > t.delaiMoyen!);
  });

  test("strictement au-dessus : une facture égale au seuil est écartée", () => {
    const c = parSeuil([grosse(5_000), grosse(5_000.01)], 5_000);
    assert.equal(c.reglees.length, 1);
    assert.equal(c.filtre.regleesSousSeuil.nombre, 1);
  });

  test("seuil personnalisé 7 500", () => {
    const c = parSeuil([grosse(6_000), grosse(8_000), petite()], 7_500);
    assert.deepEqual(c.reglees.map((f) => f.montantHt), [8_000]);
  });

  test("écart à l'échéance recalculé sur la population filtrée", () => {
    const factures = [
      facture({ montantHt: 200, montantTtc: 240, echeance: "2026-09-30", regleeLe: "2026-09-03" }), // −27 j
      facture({ montantHt: 9_000, montantTtc: 10_800, echeance: "2026-10-01", regleeLe: "2026-10-11" }), // +10 j
    ];
    proche(parSeuil(factures, 5_000).ecartEcheanceMoyen, 10);
    assert.ok(parSeuil(factures, null).ecartEcheanceMoyen! < 10);
  });

  test("factures ouvertes : seuil appliqué au compteur, au montant et à l'ancienneté", () => {
    const factures = [
      facture({ regleeLe: null, montantHt: 300, montantTtc: 360, dateEmission: "2026-09-01" }),
      facture({ regleeLe: null, montantHt: 8_000, montantTtc: 9_600, dateEmission: "2026-09-18" }),
      grosse(6_000),
    ];
    const c = parSeuil(factures, 5_000);
    assert.equal(c.ouvertes.length, 1);
    assert.equal(c.montantOuvertes, 8_000);
    proche(c.ancienneteMoyenneOuvertes, joursEntre("2026-09-18", AUJOURDHUI));
    assert.deepEqual(c.filtre.ouvertesSousSeuil, { nombre: 1, montant: 300 });
    // Les ouvertes restent hors de la moyenne réalisée.
    proche(c.delaiMoyen, 45);
  });

  test("exclusions : seules celles au-dessus du seuil restent ; sans montant HT, hors population", () => {
    const factures = [
      facture({ montantHt: 300, montantTtc: 360, reglements: [] }),
      facture({ montantHt: 9_000, montantTtc: 10_800, reglements: [] }),
      facture({ montantHt: null }),
    ];
    assert.equal(parSeuil(factures, null).exclues.length, 3);
    const c = parSeuil(factures, 5_000);
    assert.equal(c.exclues.length, 1);
    assert.equal(nombreDelaisIncertains(c), 1);
  });

  test("zéro facture au-dessus du seuil : aucune moyenne, aucune division invalide", () => {
    const c = parSeuil([petite(), petite()], 10_000);
    assert.equal(c.reglees.length, 0);
    assert.equal(c.delaiMoyen, null);
    assert.equal(c.ecartType, null);
    assert.equal(c.dispersion, null);
    assert.ok(c.tranches.every((t) => t.partNombre === 0 && t.partMontant === 0));
    proche(c.filtre.couverture, 0);
    assert.equal(parSeuil([], 10_000).filtre.couverture, null);
  });

  test("comparaison : période précédente au même seuil ; sans facture au-dessus du seuil, indisponible", () => {
    const sept = [grosse(6_000), grosse(7_000), grosse(8_000)];
    const aout = (montant: number) => [1, 2, 3].map(() => facture({ montantHt: montant, montantTtc: montant * 1.2, dateEmission: "2026-08-01", regleeLe: "2026-08-11" }));
    const AOUT = { debut: "2026-08-01", fin: "2026-08-31" };
    const prec = (factures: FactureBfr[], seuil: number | null) => delaisDeLaCohorte(factures, "client", AOUT, AUJOURDHUI, { seuilHt: seuil });
    proche(comparerAvecPrecedente(parSeuil(sept, 5_000), prec(aout(9_000), 5_000)).delai, 45 - 10);
    assert.equal(comparerAvecPrecedente(parSeuil(sept, 5_000), prec(aout(300), 5_000)).delai, null);
  });

  test("saisie et libellés du seuil", () => {
    assert.equal(seuilValide("7 500"), 7_500);
    assert.equal(seuilValide("7500,5"), 7_500.5);
    assert.equal(seuilValide(""), null);
    assert.equal(seuilValide("0"), null);
    assert.equal(libelleSeuil(null), "Toutes");
    assert.equal(libelleSeuil(5_000).replace(/\s/g, " "), "> 5 000 €");
  });
});

describe("classement des délais (étage P&L des transactions, mécanisme générique)", () => {
  const cat = (id: string, label = id, weight = 1) => ({ id, label, groupId: "axe", weight });
  const avec = (montantHt: number, categories: ReturnType<typeof cat>[] | null, regleeLe = "2026-10-16") =>
    facture({ montantHt, montantTtc: montantHt * 1.2, regleeLe, categories });
  const filtrer = (factures: FactureBfr[], categorie: FiltreCategorie, seuilHt: number | null = null) =>
    delaisDeLaCohorte(factures, "client", SEPTEMBRE, AUJOURDHUI, { categorie, seuilHt });

  test("Toutes : identique à l'appel sans filtre, catégories lues ou non", () => {
    const factures = [avec(1_000, [cat("A")]), avec(2_000, null), avec(3_000, [])];
    assert.deepEqual(filtrer(factures, { type: "toutes" }), delaisDeLaCohorte(factures, "client", SEPTEMBRE, AUJOURDHUI));
  });

  test("une catégorie : seules ses factures ; facture multi-catégories comptée une seule fois, montant entier", () => {
    const multi = avec(100_000, [cat("A", "Projet A", 0.5), cat("M", "Maintenance", 0.5)], "2026-10-22"); // 51 j
    const factures = [multi, avec(2_000, [cat("M")], "2026-09-11"), avec(3_000, [cat("B")])];
    const a = filtrer(factures, { type: "categorie", id: "A" });
    assert.equal(a.reglees.length, 1);
    assert.equal(a.reglees[0].montantHt, 100_000); // jamais pondéré par weight
    proche(a.delaiMoyen, 51); // délai de la facture entière, jamais ventilé
    const m = filtrer(factures, { type: "categorie", id: "M" });
    assert.equal(m.reglees.length, 2);
    proche(m.filtre.regleesTotal.montant, 102_000);
    assert.equal(m.tranches.reduce((s, t) => s + t.factures.length, 0), 2);
  });

  test("Non catégorisé : catégories lues et vides ; non lues : hors population et comptées", () => {
    const factures = [avec(1_000, []), avec(2_000, [cat("A")]), avec(3_000, null), avec(4_000, undefined as never)];
    const n = filtrer(factures, { type: "non_categorise" });
    assert.deepEqual(n.reglees.map((f) => f.montantHt), [1_000]);
    assert.equal(n.filtre.categoriesInconnues, 2);
    assert.equal(filtrer(factures, { type: "toutes" }).filtre.categoriesInconnues, 0);
  });

  test("catégorie + seuil : couverture rapportée à la catégorie, avant le seuil", () => {
    const factures = [avec(8_000, [cat("S")]), avec(2_000, [cat("S")]), avec(90_000, [cat("X")])];
    const c = filtrer(factures, { type: "categorie", id: "S" }, 5_000);
    assert.equal(c.reglees.length, 1);
    proche(c.filtre.couverture, 8_000 / 10_000); // jamais sur le total de toutes les catégories
    assert.deepEqual(c.filtre.regleesSousSeuil, { nombre: 1, montant: 2_000 });
  });

  test("factures ouvertes : catégorie appliquée, toujours hors moyenne", () => {
    const factures = [avec(5_000, [cat("A")], null as never), avec(6_000, [cat("B")], null as never), avec(1_000, [cat("A")])];
    const c = filtrer(factures, { type: "categorie", id: "A" });
    assert.equal(c.ouvertes.length, 1);
    assert.equal(c.montantOuvertes, 5_000);
    proche(c.delaiMoyen, 45);
    assert.equal(c.statut, "provisoire");
  });

  test("dansLaCategorie", () => {
    assert.equal(dansLaCategorie(avec(1, null), { type: "categorie", id: "A" }), null);
    assert.equal(dansLaCategorie(avec(1, null), { type: "toutes" }), true);
    assert.equal(dansLaCategorie(avec(1, [cat("A"), cat("B")]), { type: "categorie", id: "B" }), true);
  });
});
