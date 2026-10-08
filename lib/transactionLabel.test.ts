import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { analyserPrelevementSepa, fluxComparable, libStablePrelevement, normalizeTransactionLabel as n } from "./transactionLabel";

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

describe("flux comparable — clés de regroupement, de la plus sûre à la plus faible", () => {
  const meta = (ech: string, ref: string) =>
    `PRLV SEPA META PLATFORMS IRELAND ECH/${ech} ID EMETTEUR/IE63ZZZ307358 MDT/FBEUX7L00D76 REF/${ref} LIB/FACEBOOK ADS ${ref}`;

  test("lecture des champs d'un prélèvement SEPA", () => {
    assert.deepEqual(analyserPrelevementSepa(meta("260826", "BW6UVZ4AOC")), {
      idEmetteur: "IE63ZZZ307358",
      mandat: "FBEUX7L00D76",
      creancier: "META PLATFORMS IRELAND",
      lib: "FACEBOOK ADS BW6UVZ4AOC",
    });
    // Séparateur « : », espaces, casse, ordre des champs différent.
    assert.deepEqual(analyserPrelevementSepa("prlv sepa bigblue  lib: BIGBLUE INV20260905  mdt: bb-2024-001  id emetteur : fr12zzz123456"), {
      idEmetteur: "FR12ZZZ123456",
      mandat: "BB-2024-001",
      creancier: "bigblue",
      lib: "BIGBLUE INV20260905",
    });
    assert.equal(analyserPrelevementSepa("VIR SEPA LOYER SEPTEMBRE"), null);
    assert.equal(analyserPrelevementSepa("Amazon septembre 26"), null);
  });

  test("niveau 1 — même émetteur et même mandat : ECH et REF ne créent jamais un nouveau flux", () => {
    const flux = ["BW6UVZ4AOC", "BW72V4VLS1", "BW74UAHZIE", "BW70UN8DE4", "BW6UW1KA7O"].map((ref, i) => fluxComparable(meta(`2${i}0826`, ref)));
    assert.equal(new Set(flux.map((f) => f.cle)).size, 1);
    assert.deepEqual(flux[0], { cle: "sepa:IE63ZZZ307358:FBEUX7L00D76", niveau: 1, titre: "Facebook Ads" });
  });

  test("mandats ou émetteurs différents : flux différents", () => {
    const autreMandat = meta("260826", "BW6UVZ4AOC").replace("FBEUX7L00D76", "FBEUX7L00D77");
    const autreEmetteur = meta("260826", "BW6UVZ4AOC").replace("IE63ZZZ307358", "IE63ZZZ307359");
    assert.notEqual(fluxComparable(autreMandat).cle, fluxComparable(meta("260826", "BW6UVZ4AOC")).cle);
    assert.notEqual(fluxComparable(autreEmetteur).cle, fluxComparable(meta("260826", "BW6UVZ4AOC")).cle);
  });

  test("niveau 2 — sans mandat : même émetteur et même LIB stable", () => {
    const urssaf = (ref: string) => `PRLV SEPA URSSAF ECH/150826 ID EMETTEUR/FR45ZZZ000111 REF/${ref} LIB/COTISATIONS ${ref}`;
    assert.deepEqual(fluxComparable(urssaf("A1B2C3D4")), { cle: "sepa:FR45ZZZ000111:lib:cotisations", niveau: 2, titre: "Cotisations" });
    assert.equal(fluxComparable(urssaf("A1B2C3D4")).cle, fluxComparable(urssaf("Z9Y8X7W6")).cle);
    // Même émetteur, LIB stable différent : on ne fusionne pas.
    const autre = "PRLV SEPA URSSAF ID EMETTEUR/FR45ZZZ000111 REF/Q1W2E3R4 LIB/REGULARISATION Q1W2E3R4";
    assert.notEqual(fluxComparable(autre).cle, fluxComparable(urssaf("A1B2C3D4")).cle);
  });

  test("partie stable du LIB : la référence répétée et les suffixes variables sont retirés", () => {
    assert.equal(libStablePrelevement(meta("260826", "BW6UVZ4AOC")), "facebook ads");
    assert.equal(libStablePrelevement("PRLV SEPA X ID EMETTEUR/FR1 MDT/M1 REF/FA2026 LIB/ABONNEMENT FA2026 PRO"), "abonnement pro");
    assert.equal(libStablePrelevement("PRLV SEPA X ID EMETTEUR/FR1 MDT/M1 LIB/FACTURE 20260901123"), "facture");
    assert.equal(libStablePrelevement("PRLV SEPA X ID EMETTEUR/FR1 MDT/M1 LIB/OFFRE 365"), "offre 365");
  });

  test("titre lisible : le LIB stable, sinon le créancier, jamais le libellé bancaire complet", () => {
    assert.equal(fluxComparable("PRLV SEPA BIGBLUE ECH/050926 ID EMETTEUR/FR12ZZZ123456 MDT/BB-2024-001 REF/INV20260905 LIB/BIGBLUE INV20260905").titre, "Bigblue");
    assert.equal(fluxComparable("PRLV SEPA ORANGE SA ID EMETTEUR/FR99ZZZ1 MDT/OR-77 REF/X1Y2Z3A4 LIB/X1Y2Z3A4").titre, "Orange Sa");
    assert.equal(fluxComparable("PRLV SEPA ID EMETTEUR/FR99ZZZ1 MDT/OR-77").titre, "FR99ZZZ1");
  });

  test("niveau 3 — texte normalisé ; un libellé vide n'a pas de clé", () => {
    assert.deepEqual(fluxComparable("Amazon septembre 26"), { cle: "texte:amazon", niveau: 3, titre: "Amazon" });
    assert.equal(fluxComparable("Amazon août 26").cle, "texte:amazon");
    assert.deepEqual(fluxComparable("Septembre 2026"), { cle: null, niveau: 3, titre: "Septembre 2026" });
    assert.equal(fluxComparable("   ").cle, null);
  });

  test("un prélèvement sans mandat ni LIB exploitable retombe sur le texte normalisé", () => {
    const flux = fluxComparable("PRLV SEPA EDF ID EMETTEUR/FR47ZZZ1 REF/123456789");
    assert.equal(flux.niveau, 3);
    assert.ok(flux.cle?.startsWith("texte:"));
  });
});
