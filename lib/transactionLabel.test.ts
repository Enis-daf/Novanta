import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeTransactionLabel as n } from "./transactionLabel";

const memeGroupe = (a: string, b: string, attendu: string) => {
  assert.equal(n(a), attendu, a);
  assert.equal(n(b), attendu, b);
};
const separes = (a: string, b: string) => assert.notEqual(n(a), n(b), `${a} / ${b}`);

describe("normalisation des libellés — exemples de référence", () => {
  test("rapprochements évidents", () => {
    memeGroupe("Amazon septembre 26", "Amazon août 26", "amazon");
    memeGroupe("Loyer septembre 2026", "Loyer août 2026", "loyer");
    memeGroupe("Assurance 09/2026", "Assurance 08/2026", "assurance");
    memeGroupe("LOYER - Sept. 2026", "loyer aug 2026", "loyer");
    memeGroupe("Société Générale", "SOCIETE GENERALE", "societe generale");
  });

  test("rapprochements ambigus : laissés séparés", () => {
    separes("Amazon Business", "Amazon Marketplace");
    separes("ABC 1234", "ABC 5678");
    separes("Facture 26", "Facture 27");
    separes("Facture 2026", "Facture 2025");
  });

  test("un mois en première position est un nom, pas une date", () => {
    memeGroupe("Mai Consulting", "Mai Consulting", "mai consulting");
    memeGroupe("Mars Wrigley", "MARS  Wrigley", "mars wrigley");
    assert.equal(n("May & Co"), "may co");
  });
});

describe("casse, accents, ponctuation, espaces", () => {
  test("minuscules et accents retirés", () => {
    assert.equal(n("Électricité De FRANCE"), "electricite de france");
    assert.equal(n("Crédit Agricole"), n("CREDIT AGRICOLE"));
  });

  test("ponctuation et tirets remplacés par des espaces, espaces réduits", () => {
    assert.equal(n("  Orange -- Pro  (mobile) "), "orange pro mobile");
    assert.equal(n("Saint-Gobain"), n("Saint Gobain"));
    assert.equal(n("L'Oréal"), "l oreal");
    assert.equal(n("Loyer\tBureau"), "loyer bureau");
  });
});

describe("dates évidentes", () => {
  test("formats retirés", () => {
    for (const date of ["08/2026", "09/26", "12/09/2026", "2026-09", "2026-09-12", "12.09.2026", "09-2026", "12/09/26", "1/9/2026"]) {
      assert.equal(n(`Assurance ${date}`), "assurance", date);
    }
  });

  test("ce qui ressemble à une référence n'est pas pris pour une date", () => {
    assert.equal(n("Commande 13/2026"), "commande 13 2026"); // pas de mois 13
    assert.equal(n("Ref 09-26"), "ref 09 26"); // année sur 2 chiffres sans barre oblique
    assert.equal(n("Dossier 12-09-26"), "dossier 12 09 26");
    assert.equal(n("Lot 2026-13"), "lot 2026 13");
    assert.equal(n("Contrat 1209/2026"), "contrat 1209 2026");
  });
});

describe("mois français et anglais", () => {
  test("entiers et abrégés, après le premier mot", () => {
    for (const mois of ["janvier", "jan", "février", "fev", "fév", "mars", "avril", "avr", "mai", "juin", "juillet", "juil", "août", "aout", "septembre", "sept", "sep", "octobre", "oct", "novembre", "nov", "décembre", "dec", "déc"]) {
      assert.equal(n(`Loyer ${mois}`), "loyer", mois);
    }
    for (const mois of ["January", "Feb", "March", "Mar", "April", "Apr", "May", "June", "Jun", "July", "Jul", "August", "Aug", "September", "October", "November", "December"]) {
      assert.equal(n(`Rent ${mois}`), "rent", mois);
    }
  });

  test("un mot qui contient un mois n'est pas touché", () => {
    assert.equal(n("Agence Marseille"), "agence marseille");
    assert.equal(n("Hotel Mayfair"), "hotel mayfair");
    assert.equal(n("Decathlon"), "decathlon");
  });
});

describe("années et quantièmes — seulement en contexte temporel", () => {
  test("année collée à un mois : retirée", () => {
    assert.equal(n("Loyer septembre 2026"), "loyer");
    assert.equal(n("Loyer septembre 26"), "loyer");
    assert.equal(n("Loyer 2026 septembre"), "loyer");
    assert.equal(n("Loyer du 12 septembre 2026"), "loyer du");
  });

  test("année hors contexte temporel : conservée", () => {
    assert.equal(n("Facture 2026"), "facture 2026");
    assert.equal(n("Facture 26"), "facture 26");
    assert.equal(n("Budget 2026 marketing"), "budget 2026 marketing");
    // Avant un mois, seul un quantième plausible (1 à 31) est retiré ; un autre nombre reste.
    assert.equal(n("Loyer 26 septembre"), "loyer");
    assert.equal(n("Bail 45 septembre"), "bail 45");
  });

  test("aucun nombre isolé n'est retiré", () => {
    assert.equal(n("ABC 1234"), "abc 1234");
    assert.equal(n("Prélèvement 000123 EDF"), "prelevement 000123 edf");
    assert.equal(n("Vol AF 1234 septembre"), "vol af 1234");
  });
});

describe("normalisation vide — jamais de groupe commun", () => {
  test("libellé purement temporel", () => {
    for (const libelle of ["Septembre 2026", "septembre", "Sept. 26", "09/2026", "12 septembre 2026", "Mai 2026", "Mars"]) {
      assert.equal(n(libelle), "", libelle);
    }
  });

  test("libellé vide ou sans caractère exploitable", () => {
    for (const libelle of ["", "   ", "---", "…"]) assert.equal(n(libelle), "", JSON.stringify(libelle));
  });

  test("un nombre seul n'est pas temporel : il reste", () => {
    assert.equal(n("2026"), "2026");
    assert.equal(n("12"), "12");
  });
});

describe("propriétés générales", () => {
  test("idempotente et déterministe", () => {
    for (const libelle of ["Amazon septembre 26", "LOYER - Sept. 2026", "Mai Consulting", "Facture 2026", "Assurance 09/2026"]) {
      assert.equal(n(n(libelle)), n(libelle), libelle);
      assert.equal(n(libelle), n(libelle));
    }
  });

  test("le libellé source n'est pas modifié", () => {
    const source = "LOYER - Sept. 2026";
    n(source);
    assert.equal(source, "LOYER - Sept. 2026");
  });
});
