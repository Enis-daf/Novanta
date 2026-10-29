import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FactureBfr } from "./pastBfr";
import { delaisDeLaCohorte, joursEntre, libelleEcartEcheance, libelleRetardOuverte, libelleTrancheDansPhrase, libelleVariationJours, niveauDeDispersion } from "./pastBfrDelais";

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
