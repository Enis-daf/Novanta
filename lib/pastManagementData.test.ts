import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { donneesDeGestionACompleter, etatDesStocks } from "./pastManagementData";

const stock = (mois: string, valeur = 100_000) => ({ mois, valeur });
const periode = (debut: string, fin: string) => ({ debut, fin });
const AUJOURDHUI = "2026-10-13";
const signaux = (stocks: { mois: string; valeur: number }[], p: { debut: string; fin: string }, aujourdhui = AUJOURDHUI) =>
  donneesDeGestionACompleter({ stocks, periode: p, aujourdhui });

// Stocks renseignés de janvier à août 2026, sans trou.
const JANVIER_A_AOUT = ["01", "02", "03", "04", "05", "06", "07", "08"].map((m) => stock(`2026-${m}`));

describe("données de gestion à compléter — stocks", () => {
  test("stocks complets sur la période : aucun signal", () => {
    assert.deepEqual(signaux(JANVIER_A_AOUT, periode("2026-01-01", "2026-08-31")), []);
    assert.deepEqual(signaux(JANVIER_A_AOUT, periode("2026-03-01", "2026-05-31")), []);
  });

  test("aucun stock jamais renseigné : aucun signal (organisation peut-être sans stock)", () => {
    assert.deepEqual(signaux([], periode("2026-01-01", "2026-08-31")), []);
  });

  test("stock renseigné jusqu'en août, période = septembre : stock non renseigné pour ce mois", () => {
    const [signal] = signaux(JANVIER_A_AOUT, periode("2026-09-01", "2026-09-30"));
    assert.equal(signal.type, "inventory");
    assert.equal(signal.libelle, "Stock non renseigné pour septembre 2026");
    assert.equal(signal.onglet, "stocks");
    assert.match(signal.detail, /La marge brute peut être incomplète/);
    assert.match(signal.detail, /Stock manquant : septembre 2026\./);
  });

  test("plusieurs mois de la période, tous sans stock : stocks non renseignés", () => {
    const [signal] = signaux([stock("2026-01"), stock("2026-02")], periode("2026-04-01", "2026-06-30"));
    assert.equal(signal.libelle, "Stocks non renseignés");
  });

  test("période en partie renseignée : stocks incomplets", () => {
    const [signal] = signaux(JANVIER_A_AOUT, periode("2026-01-01", "2026-09-30"));
    assert.equal(signal.libelle, "Stocks incomplets");
    assert.match(signal.detail, /Stock manquant : septembre 2026\./);
  });

  test("calcul possible mais par-dessus un mois manquant : stocks incomplets, périodisation incertaine", () => {
    const stocks = [stock("2026-05"), stock("2026-06"), stock("2026-08")];
    // Août seul : son stock est renseigné, mais sa variation enjambe juillet.
    const [aout] = signaux(stocks, periode("2026-08-01", "2026-08-31"));
    assert.equal(aout.libelle, "Stocks incomplets");
    assert.match(aout.detail, /Périodisation incertaine : août 2026\./);
    assert.doesNotMatch(aout.detail, /Stock manquant/);
    // Juillet seul : c'est le mois manquant.
    assert.equal(signaux(stocks, periode("2026-07-01", "2026-07-31"))[0].libelle, "Stock non renseigné pour juillet 2026");
  });

  test("données complétées : le signal disparaît", () => {
    const septembre = periode("2026-09-01", "2026-09-30");
    assert.equal(signaux(JANVIER_A_AOUT, septembre).length, 1);
    assert.deepEqual(signaux([...JANVIER_A_AOUT, stock("2026-09")], septembre), []);
  });

  test("une absence de stock n'est jamais un stock à 0 : un stock saisi à 0 est une donnée renseignée", () => {
    assert.deepEqual(signaux([...JANVIER_A_AOUT, stock("2026-09", 0)], periode("2026-09-01", "2026-09-30")), []);
  });

  test("le premier mois renseigné est le point de départ : ni lui ni ce qui le précède ne sont signalés", () => {
    const stocks = [stock("2026-06"), stock("2026-07"), stock("2026-08")];
    assert.deepEqual(signaux(stocks, periode("2026-01-01", "2026-08-31")), []);
    assert.deepEqual(signaux(stocks, periode("2025-01-01", "2025-12-31")), []);
    assert.deepEqual(
      etatDesStocks(stocks, periode("2026-01-01", "2026-08-31"), AUJOURDHUI).mois.map((m) => m.mois),
      ["2026-06", "2026-07", "2026-08"]
    );
  });

  test("un mois qui n'est pas terminé n'est pas attendu", () => {
    const stocks = [...JANVIER_A_AOUT, stock("2026-09")];
    // Octobre est en cours le 13 : son stock de fin de mois ne peut pas être connu.
    assert.deepEqual(signaux(stocks, periode("2026-10-01", "2026-10-31")), []);
    assert.deepEqual(signaux(stocks, periode("2026-10-01", "2026-10-31"), "2026-10-31"), []);
    assert.equal(signaux(stocks, periode("2026-10-01", "2026-10-31"), "2026-11-01").length, 1);
  });

  test("un mois dont la fin est hors période n'est pas attendu : sa variation n'entre pas dans la période", () => {
    assert.deepEqual(signaux(JANVIER_A_AOUT, periode("2026-09-01", "2026-09-15")), []);
    assert.deepEqual(signaux(JANVIER_A_AOUT, periode("2026-08-15", "2026-09-15")), []);
  });

  test("au-delà de trois mois, le détail résume les suivants", () => {
    const [signal] = signaux([stock("2026-01")], periode("2026-01-01", "2026-06-30"));
    assert.equal(signal.libelle, "Stocks incomplets");
    assert.match(signal.detail, /Stock manquant : février 2026, mars 2026, avril 2026 et 2 autres\./);
  });

  test("période invalide : aucun signal", () => {
    assert.deepEqual(signaux(JANVIER_A_AOUT, periode("2026-09-30", "2026-09-01")), []);
  });
});
