import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseDateISO } from "./dates";
import {
  detailChargeFixeSurPeriode,
  frequenceCompatible,
  montantOccurrenceChargeFixe,
  montantApercuChargeFixe,
  optionsSourceDisponibles,
} from "./montantCalcule";
import { ChargeFixe, RentreeReguliere } from "./types";

function chargeFixe(overrides: Partial<ChargeFixe> = {}): ChargeFixe {
  return {
    id: "charge-1",
    libelle: "Charge",
    montant: 0,
    datePrevue: "2026-01-01",
    recurrence: "mensuel",
    dateFin: null,
    modeMontant: "fixe",
    tauxCalcul: null,
    sourceCalculId: null,
    sourceCalculType: null,
    aCouper: false,
    ...overrides,
  };
}

function rentree(overrides: Partial<RentreeReguliere> = {}): RentreeReguliere {
  return {
    id: "rentree-1",
    libelle: "Rentree",
    montant: 0,
    dateDebut: "2026-01-01",
    frequence: "quotidien",
    dateFin: null,
    modeMontant: "fixe",
    profilSaisonnalite: null,
    ...overrides,
  };
}

const FIN_LOINTAINE = parseDateISO("2030-01-01");

describe("frequenceCompatible — matrice de compatibilité des fréquences", () => {
  test("combinaisons autorisées", () => {
    assert.equal(frequenceCompatible("quotidien", "quotidien"), true);
    assert.equal(frequenceCompatible("quotidien", "hebdomadaire"), true);
    assert.equal(frequenceCompatible("quotidien", "mensuel"), true);
    assert.equal(frequenceCompatible("hebdomadaire", "hebdomadaire"), true);
    assert.equal(frequenceCompatible("hebdomadaire", "mensuel"), true);
    assert.equal(frequenceCompatible("mensuel", "mensuel"), true);
  });

  test("combinaisons interdites", () => {
    assert.equal(frequenceCompatible("mensuel", "hebdomadaire"), false);
    assert.equal(frequenceCompatible("mensuel", "quotidien"), false);
    assert.equal(frequenceCompatible("hebdomadaire", "quotidien"), false);
  });

  test("ponctuel n'est contraint dans aucun sens", () => {
    assert.equal(frequenceCompatible("ponctuel", "mensuel"), true);
    assert.equal(frequenceCompatible("mensuel", "ponctuel"), true);
    assert.equal(frequenceCompatible("ponctuel", "ponctuel"), true);
  });
});

describe("montantOccurrenceChargeFixe — cas de référence obligatoire (quotidien -> hebdomadaire)", () => {
  const ca = rentree({ id: "ca", libelle: "CA", montant: 1000, dateDebut: "2026-01-01", frequence: "quotidien" });
  const ads = chargeFixe({
    id: "ads",
    libelle: "Ads",
    datePrevue: "2026-01-01",
    recurrence: "hebdomadaire",
    modeMontant: "calcule",
    tauxCalcul: 40,
    sourceCalculId: "ca",
    sourceCalculType: "rentree_reguliere",
  });

  test("une semaine complète (2e occurrence) : 40% x (7 x 1000) = 2800", () => {
    const montant = montantOccurrenceChargeFixe(
      ads,
      parseDateISO("2026-01-08"),
      parseDateISO("2026-01-01"),
      [],
      [ca],
      FIN_LOINTAINE
    );
    assert.equal(montant, 2800);
  });

  test("la toute première occurrence est une période partielle (1 seul jour de CA) : 40% x 1000 = 400", () => {
    const montant = montantOccurrenceChargeFixe(ads, parseDateISO("2026-01-01"), null, [], [ca], FIN_LOINTAINE);
    assert.equal(montant, 400);
  });

  test("l'aperçu (prévisualisation) utilise la première période COMPLÈTE, pas la partielle : 2800, pas 400", () => {
    const apercu = montantApercuChargeFixe(ads, [], [ca]);
    assert.equal(apercu, 2800);
  });
});

describe("Première période partielle : ne pas inventer d'occurrences avant le début réel de la charge", () => {
  test("Ads commence un mercredi, CA existe depuis longtemps avant : la 1re occurrence ne prend que le mercredi", () => {
    const ca = rentree({ id: "ca", montant: 1000, dateDebut: "2025-12-01", frequence: "quotidien" });
    const ads = chargeFixe({
      datePrevue: "2026-01-07", // mercredi
      recurrence: "hebdomadaire",
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });
    const montant = montantOccurrenceChargeFixe(ads, parseDateISO("2026-01-07"), null, [], [ca], FIN_LOINTAINE);
    // Un seul jour de CA (mercredi 7 janvier), jamais le lundi/mardi précédents ni décembre.
    assert.equal(montant, 400);
  });
});

describe("quotidien -> mensuel : mois de longueurs différentes, jamais 30 jours par défaut", () => {
  const ca = rentree({ id: "ca", montant: 1000, dateDebut: "2025-01-01", frequence: "quotidien" });

  function ads(datePrevue: string): ChargeFixe {
    return chargeFixe({
      datePrevue,
      recurrence: "mensuel",
      modeMontant: "calcule",
      tauxCalcul: 10,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });
  }

  test("janvier (31 jours) : 10% x 31000 = 3100", () => {
    const charge = ads("2026-01-01");
    const montant = montantOccurrenceChargeFixe(
      charge,
      parseDateISO("2026-02-01"),
      parseDateISO("2026-01-01"),
      [],
      [ca],
      FIN_LOINTAINE
    );
    assert.equal(montant, 3100);
  });

  test("février 2026, année non bissextile (28 jours) : 10% x 28000 = 2800", () => {
    const charge = ads("2026-01-01");
    const montant = montantOccurrenceChargeFixe(
      charge,
      parseDateISO("2026-03-01"),
      parseDateISO("2026-02-01"),
      [],
      [ca],
      FIN_LOINTAINE
    );
    assert.equal(montant, 2800);
  });

  test("février 2028, année bissextile (29 jours) : 10% x 29000 = 2900", () => {
    const charge = ads("2028-01-01");
    const montant = montantOccurrenceChargeFixe(
      charge,
      parseDateISO("2028-03-01"),
      parseDateISO("2028-02-01"),
      [],
      [ca],
      FIN_LOINTAINE
    );
    assert.equal(montant, 2900);
  });

  test("avril (30 jours) : 10% x 30000 = 3000", () => {
    const charge = ads("2026-01-01");
    const montant = montantOccurrenceChargeFixe(
      charge,
      parseDateISO("2026-05-01"),
      parseDateISO("2026-04-01"),
      [],
      [ca],
      FIN_LOINTAINE
    );
    assert.equal(montant, 3000);
  });

  test("pas de double comptage ni d'oubli à la frontière janvier/février : 31 + 28 = 59 jours réels", () => {
    const charge = ads("2026-01-01");
    const montantJanvier = montantOccurrenceChargeFixe(
      charge,
      parseDateISO("2026-02-01"),
      parseDateISO("2026-01-01"),
      [],
      [ca],
      FIN_LOINTAINE
    )!;
    const montantFevrier = montantOccurrenceChargeFixe(
      charge,
      parseDateISO("2026-03-01"),
      parseDateISO("2026-02-01"),
      [],
      [ca],
      FIN_LOINTAINE
    )!;
    const joursTotal = (montantJanvier + montantFevrier) / (10 / 100) / 1000;
    const joursReels =
      (parseDateISO("2026-03-01").getTime() - parseDateISO("2026-01-01").getTime()) / (1000 * 60 * 60 * 24);
    assert.equal(joursTotal, joursReels);
  });
});

describe("hebdomadaire -> mensuel : jamais 4,33 semaines, occurrences réelles uniquement", () => {
  // RentreeReguliere ne supporte pas "hebdomadaire" (seulement ponctuel/quotidien/mensuel) :
  // une source hebdomadaire ne peut être qu'une Charge fixe non calculée.
  const source = chargeFixe({
    id: "src",
    libelle: "Source hebdo",
    montant: 2000,
    datePrevue: "2026-01-05", // lundis
    recurrence: "hebdomadaire",
    modeMontant: "fixe",
  });
  const charge = chargeFixe({
    datePrevue: "2026-01-01",
    recurrence: "mensuel",
    modeMontant: "calcule",
    tauxCalcul: 10,
    sourceCalculId: "src",
    sourceCalculType: "charge_fixe",
  });

  test("période contenant 4 lundis (janvier) : 10% x (4 x 2000) = 800", () => {
    const montant = montantOccurrenceChargeFixe(
      charge,
      parseDateISO("2026-02-01"),
      parseDateISO("2026-01-01"),
      [source],
      [],
      FIN_LOINTAINE
    );
    assert.equal(montant, 800);
  });

  test("période contenant 5 lundis (mars) : 10% x (5 x 2000) = 1000", () => {
    const montant = montantOccurrenceChargeFixe(
      charge,
      parseDateISO("2026-04-01"),
      parseDateISO("2026-03-01"),
      [source],
      [],
      FIN_LOINTAINE
    );
    assert.equal(montant, 1000);
  });
});

describe("hebdomadaire -> hebdomadaire et mensuel -> mensuel : montant constant, alignement 1:1", () => {
  test("hebdomadaire -> hebdomadaire : toujours exactement 1 occurrence par période", () => {
    const source = chargeFixe({
      id: "src",
      libelle: "Source hebdo",
      montant: 500,
      datePrevue: "2026-01-01",
      recurrence: "hebdomadaire",
      modeMontant: "fixe",
    });
    const charge = chargeFixe({
      datePrevue: "2026-01-01",
      recurrence: "hebdomadaire",
      modeMontant: "calcule",
      tauxCalcul: 50,
      sourceCalculId: "src",
      sourceCalculType: "charge_fixe",
    });
    const montant = montantOccurrenceChargeFixe(
      charge,
      parseDateISO("2026-01-15"),
      parseDateISO("2026-01-08"),
      [source],
      [],
      FIN_LOINTAINE
    );
    assert.equal(montant, 250); // 50% x 500
  });

  test("mensuel -> mensuel : toujours exactement 1 occurrence par période", () => {
    const source = chargeFixe({
      id: "src",
      libelle: "Source",
      montant: 10000,
      datePrevue: "2026-01-01",
      recurrence: "mensuel",
      modeMontant: "fixe",
    });
    const charge = chargeFixe({
      id: "dep",
      datePrevue: "2026-01-01",
      recurrence: "mensuel",
      modeMontant: "calcule",
      tauxCalcul: 45,
      sourceCalculId: "src",
      sourceCalculType: "charge_fixe",
    });
    const montant = montantOccurrenceChargeFixe(
      charge,
      parseDateISO("2026-03-01"),
      parseDateISO("2026-02-01"),
      [source],
      [],
      FIN_LOINTAINE
    );
    assert.equal(montant, 4500); // 45% x 10000, quel que soit le nombre de jours du mois
  });
});

describe("modification du montant de la source", () => {
  test("le montant recalculé suit immédiatement le nouveau montant de la source", () => {
    const charge = chargeFixe({
      datePrevue: "2026-01-01",
      recurrence: "mensuel",
      modeMontant: "calcule",
      tauxCalcul: 10,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });
    const caAvant = rentree({ id: "ca", montant: 1000, dateDebut: "2025-01-01", frequence: "quotidien" });
    const caApres = rentree({ id: "ca", montant: 2000, dateDebut: "2025-01-01", frequence: "quotidien" });

    const montantAvant = montantOccurrenceChargeFixe(
      charge,
      parseDateISO("2026-02-01"),
      parseDateISO("2026-01-01"),
      [],
      [caAvant],
      FIN_LOINTAINE
    );
    const montantApres = montantOccurrenceChargeFixe(
      charge,
      parseDateISO("2026-02-01"),
      parseDateISO("2026-01-01"),
      [],
      [caApres],
      FIN_LOINTAINE
    );
    assert.equal(montantAvant, 3100);
    assert.equal(montantApres, 6200);
  });
});

describe("modification de la fréquence de la source ou de la charge", () => {
  test("changer la fréquence de la source en une fréquence incompatible rend le montant indisponible", () => {
    const charge = chargeFixe({
      datePrevue: "2026-01-01",
      recurrence: "hebdomadaire",
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });
    const caMensuel = rentree({ id: "ca", montant: 1000, dateDebut: "2026-01-01", frequence: "mensuel" });
    const montant = montantOccurrenceChargeFixe(
      charge,
      parseDateISO("2026-01-08"),
      parseDateISO("2026-01-01"),
      [],
      [caMensuel],
      FIN_LOINTAINE
    );
    assert.equal(montant, null); // mensuel -> hebdomadaire interdit, même si la source existait déjà
  });

  test("changer la fréquence de la charge en une fréquence trop fréquente pour sa source la rend indisponible", () => {
    const source = chargeFixe({
      id: "src",
      libelle: "Source hebdo",
      montant: 1000,
      datePrevue: "2026-01-01",
      recurrence: "hebdomadaire",
      modeMontant: "fixe",
    });
    const chargeDevenueQuotidienne = chargeFixe({
      id: "dep",
      datePrevue: "2026-01-01",
      recurrence: "quotidien", // était hebdomadaire, source hebdomadaire -> incompatible maintenant
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "src",
      sourceCalculType: "charge_fixe",
    });
    const montant = montantOccurrenceChargeFixe(
      chargeDevenueQuotidienne,
      parseDateISO("2026-01-02"),
      parseDateISO("2026-01-01"),
      [source],
      [],
      FIN_LOINTAINE
    );
    assert.equal(montant, null); // hebdomadaire -> quotidien interdit
  });
});

describe("optionsSourceDisponibles filtre par compatibilité de fréquence", () => {
  test("une charge mensuelle propose les sources quotidiennes et hebdomadaires (plus fréquentes = ok)", () => {
    const chargeMensuelle = chargeFixe({ id: "cible", recurrence: "mensuel" });
    const sourceQuotidienne = chargeFixe({ id: "src-q", recurrence: "quotidien", modeMontant: "fixe" });
    // RentreeReguliere ne supporte pas "hebdomadaire" : une source hebdo est une Charge fixe.
    const sourceHebdo = chargeFixe({ id: "src-h", recurrence: "hebdomadaire", modeMontant: "fixe" });
    const options = optionsSourceDisponibles(chargeMensuelle, [sourceQuotidienne, sourceHebdo], []);
    assert.equal(options.chargesFixes.length, 2);
  });

  test("une charge hebdomadaire exclut une source mensuelle (moins fréquente)", () => {
    const chargeHebdo = chargeFixe({ id: "cible", recurrence: "hebdomadaire" });
    const sourceMensuelle = rentree({ id: "src-m", frequence: "mensuel" });
    const options = optionsSourceDisponibles(chargeHebdo, [], [sourceMensuelle]);
    assert.equal(options.rentreesRegulieres.length, 0);
  });

  test("une charge quotidienne exclut les sources hebdomadaires et mensuelles", () => {
    const chargeQuotidienne = chargeFixe({ id: "cible", recurrence: "quotidien" });
    const sourceHebdo = chargeFixe({ id: "src-h", recurrence: "hebdomadaire", modeMontant: "fixe" });
    const sourceMensuelle = rentree({ id: "src-m", frequence: "mensuel" });
    const options = optionsSourceDisponibles(chargeQuotidienne, [sourceHebdo], [sourceMensuelle]);
    assert.equal(options.chargesFixes.length, 0);
    assert.equal(options.rentreesRegulieres.length, 0);
  });

  test("exclut toujours la ligne elle-même et les charges déjà calculées", () => {
    const cible = chargeFixe({ id: "cible", recurrence: "mensuel" });
    const uneAutreCalculee = chargeFixe({ id: "autre-calculee", recurrence: "mensuel", modeMontant: "calcule" });
    const options = optionsSourceDisponibles(cible, [cible, uneAutreCalculee], []);
    assert.equal(options.chargesFixes.length, 0);
  });
});

describe("mode fixe : comportement strictement inchangé, indépendant des dates/périodes", () => {
  test("retourne toujours charge.montant, quelle que soit l'occurrence", () => {
    const charge = chargeFixe({ montant: 2500, modeMontant: "fixe" });
    const montant1 = montantOccurrenceChargeFixe(charge, parseDateISO("2026-01-01"), null, [], [], FIN_LOINTAINE);
    const montant2 = montantOccurrenceChargeFixe(
      charge,
      parseDateISO("2026-06-15"),
      parseDateISO("2026-05-15"),
      [],
      [],
      FIN_LOINTAINE
    );
    assert.equal(montant1, 2500);
    assert.equal(montant2, 2500);
  });
});

describe("Rentrée saisonnalisée comme source d'une Charge calculée (cas de référence obligatoire)", () => {
  // CA annuel = 1 200 000 € : juillet 10 %, août 15 %, décembre 3 %, reste réparti à 8 % x 9 = 72 %. Total = 100 %.
  const ca = rentree({
    id: "ca",
    libelle: "CA",
    dateDebut: "2026-01-01",
    frequence: "mensuel",
    modeMontant: "saisonnalise",
    profilSaisonnalite: {
      montantAnnuel: 1200000,
      ponderationsMensuelles: [8, 8, 8, 8, 8, 8, 10, 15, 8, 8, 8, 3],
    },
  });
  const ads = chargeFixe({
    id: "ads",
    libelle: "Ads",
    datePrevue: "2026-01-01",
    recurrence: "mensuel",
    modeMontant: "calcule",
    tauxCalcul: 40,
    sourceCalculId: "ca",
    sourceCalculType: "rentree_reguliere",
  });

  test("juillet : CA = 120 000 €, Ads = 40% x 120 000 = 48 000 €", () => {
    const montant = montantOccurrenceChargeFixe(
      ads,
      parseDateISO("2026-07-01"),
      parseDateISO("2026-06-01"),
      [],
      [ca],
      FIN_LOINTAINE
    );
    assert.equal(montant, 48000);
  });

  test("août : CA = 180 000 €, Ads = 40% x 180 000 = 72 000 €", () => {
    const montant = montantOccurrenceChargeFixe(
      ads,
      parseDateISO("2026-08-01"),
      parseDateISO("2026-07-01"),
      [],
      [ca],
      FIN_LOINTAINE
    );
    assert.equal(montant, 72000);
  });

  test("décembre : CA = 36 000 €, Ads = 40% x 36 000 = 14 400 €", () => {
    const montant = montantOccurrenceChargeFixe(
      ads,
      parseDateISO("2026-12-01"),
      parseDateISO("2026-11-01"),
      [],
      [ca],
      FIN_LOINTAINE
    );
    assert.equal(montant, 14400);
  });

  test("optionsSourceDisponibles PROPOSE la rentrée saisonnalisée (jamais exclue)", () => {
    const cible = chargeFixe({ id: "cible", recurrence: "mensuel" });
    const options = optionsSourceDisponibles(cible, [], [ca]);
    assert.equal(options.rentreesRegulieres.length, 1);
    assert.equal(options.rentreesRegulieres[0].id, "ca");
  });

  // La fréquence PROPRE de la source saisonnalisée (ici "mensuel") n'a plus aucune incidence :
  // seule la récurrence de la CHARGE détermine le découpage du montant mensuel de CA. Une
  // charge calculée peut donc être hebdomadaire ou quotidienne même si sa source saisonnalisée
  // est déclarée "mensuel" — la restriction de compatibilité de fréquence (frequenceCompatible)
  // ne s'applique plus à ce cas, volontairement (voir montantOccurrenceChargeFixe).
  test("source saisonnalisée + charge hebdomadaire : découpe le montant mensuel sur les semaines du mois", () => {
    const chargeHebdo = chargeFixe({
      datePrevue: "2026-01-01",
      recurrence: "hebdomadaire",
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });
    // Janvier (8 % de CA) = 96 000 € -> charge mensuelle = 38 400 €. Janvier 2026 contient 5
    // lundis(ish) hebdomadaires à partir du 1er (1, 8, 15, 22, 29) -> 38 400 / 5 = 7 680 €.
    const montant = montantOccurrenceChargeFixe(
      chargeHebdo,
      parseDateISO("2026-01-08"),
      parseDateISO("2026-01-01"),
      [],
      [ca],
      FIN_LOINTAINE
    );
    assert.equal(montant, 7680);
  });

  test("source saisonnalisée + charge quotidienne : découpe le montant mensuel sur les jours du mois", () => {
    const chargeQuotidienne = chargeFixe({
      datePrevue: "2026-01-01",
      recurrence: "quotidien",
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });
    // Janvier (8 % de CA) = 96 000 € -> charge mensuelle = 38 400 €, répartie sur 31 jours.
    const montant = montantOccurrenceChargeFixe(
      chargeQuotidienne,
      parseDateISO("2026-01-02"),
      parseDateISO("2026-01-01"),
      [],
      [ca],
      FIN_LOINTAINE
    );
    assert.equal(montant, Math.round((38400 / 31) * 100) / 100);
  });

  test("modification du montant annuel de la source : recalcul immédiat de la charge dépendante", () => {
    const caAugmente = { ...ca, profilSaisonnalite: { ...ca.profilSaisonnalite!, montantAnnuel: 2000000 } };
    const montant = montantOccurrenceChargeFixe(
      ads,
      parseDateISO("2026-08-01"),
      parseDateISO("2026-07-01"),
      [],
      [caAugmente],
      FIN_LOINTAINE
    );
    assert.equal(montant, 120000); // 40% x (2 000 000 x 15%)
  });

  test("modification d'une pondération de la source : recalcul immédiat de la charge dépendante", () => {
    const ponderationsModifiees = ca.profilSaisonnalite!.ponderationsMensuelles.map((p, i) => (i === 7 ? 20 : i === 6 ? 5 : p));
    const caModifie = { ...ca, profilSaisonnalite: { ...ca.profilSaisonnalite!, ponderationsMensuelles: ponderationsModifiees } };
    const montant = montantOccurrenceChargeFixe(
      ads,
      parseDateISO("2026-08-01"),
      parseDateISO("2026-07-01"),
      [],
      [caModifie],
      FIN_LOINTAINE
    );
    assert.equal(montant, 96000); // 40% x (1 200 000 x 20%)
  });

  test("total des pondérations de la source hors tolérance : la charge dépendante devient indisponible, jamais 0 ni une valeur inventée", () => {
    const caInvalide = {
      ...ca,
      profilSaisonnalite: { montantAnnuel: 1200000, ponderationsMensuelles: [8, 8, 8, 8, 8, 8, 10, 15, 8, 8, 8, 0] }, // total 97
    };
    const montant = montantOccurrenceChargeFixe(
      ads,
      parseDateISO("2026-08-01"),
      parseDateISO("2026-07-01"),
      [],
      [caInvalide],
      FIN_LOINTAINE
    );
    assert.equal(montant, null);
  });
});

describe("Régression : charge calculée % de CA saisonnalisé — le mois ne doit jamais être mélangé avec le découpage", () => {
  // Cas de régression rapporté : CA annuel 1 000 000 €, septembre = 30 % (300 000 €),
  // Charge = 40 % du CA -> 120 000 € pour septembre, quelle que soit sa propre récurrence.
  // Avant correction, le mécanisme générique de "période glissante entre occurrences de la
  // charge" mélangeait la fréquence de la SOURCE (quotidienne) avec le mois de la charge,
  // donnant 28 633 € (mensuel) ou 4 000 € affiché à la place de 120 000 € en mode mensuel.
  const ponderations = Array(12).fill(70 / 11);
  ponderations[8] = 30; // septembre
  const ca = rentree({
    id: "ca",
    libelle: "CA",
    dateDebut: "2026-01-01",
    frequence: "quotidien", // la fréquence de la SOURCE ne doit plus influencer le résultat
    modeMontant: "saisonnalise",
    profilSaisonnalite: { montantAnnuel: 1000000, ponderationsMensuelles: ponderations },
  });

  test("charge mensuelle : 120 000 € pour septembre, pas la valeur journalière", () => {
    const charge = chargeFixe({
      datePrevue: "2026-01-01",
      recurrence: "mensuel",
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });
    const montant = montantOccurrenceChargeFixe(
      charge,
      parseDateISO("2026-09-01"),
      parseDateISO("2026-08-01"),
      [],
      [ca],
      FIN_LOINTAINE
    );
    assert.equal(montant, 120000);
  });

  test("charge quotidienne : 120 000 / 30 jours = 4 000 € par jour de septembre", () => {
    const charge = chargeFixe({
      datePrevue: "2026-01-01",
      recurrence: "quotidien",
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });
    const montant = montantOccurrenceChargeFixe(
      charge,
      parseDateISO("2026-09-15"),
      parseDateISO("2026-09-14"),
      [],
      [ca],
      FIN_LOINTAINE
    );
    assert.equal(montant, 4000);
  });

  test("charge hebdomadaire : les semaines de septembre totalisent 120 000 €", () => {
    const charge = chargeFixe({
      datePrevue: "2026-01-05", // lundi
      recurrence: "hebdomadaire",
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });
    // Septembre 2026 : lundis 7, 14, 21, 28 (4 semaines).
    let total = 0;
    for (const jour of [7, 14, 21, 28]) {
      const montant = montantOccurrenceChargeFixe(
        charge,
        new Date(2026, 8, jour),
        new Date(2026, 8, jour - 7),
        [],
        [ca],
        FIN_LOINTAINE
      );
      assert.ok(montant !== null);
      total += montant!;
    }
    assert.equal(total, 120000);
  });
});

describe("detailChargeFixeSurPeriode — aperçu contextuel à une plage sélectionnée (N et N')", () => {
  test("source non saisonnalisée, une semaine complète : N' = 7000 (7 x 1000), N = 40% x 7000 = 2800", () => {
    const ca = rentree({ id: "ca", montant: 1000, dateDebut: "2026-01-01", frequence: "quotidien" });
    const ads = chargeFixe({
      id: "ads",
      datePrevue: "2026-01-01",
      recurrence: "hebdomadaire",
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });
    // Semaine complète du 8 janvier (2e occurrence, période complète).
    const detail = detailChargeFixeSurPeriode(ads, ["2026-01-08"], [], [ca], FIN_LOINTAINE);
    assert.deepEqual(detail, { montantSource: 7000, montantCharge: 2800 });
  });

  test("source saisonnalisée, sélection d'un seul mois : N' = montant du mois, N = taux x N'", () => {
    const ca = rentree({
      id: "ca",
      dateDebut: "2026-01-01",
      frequence: "mensuel",
      modeMontant: "saisonnalise",
      profilSaisonnalite: { montantAnnuel: 1000000, ponderationsMensuelles: Array(12).fill(70 / 11).map((p, i) => (i === 8 ? 30 : p)) },
    });
    const charge = chargeFixe({
      datePrevue: "2026-01-01",
      recurrence: "mensuel",
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });
    const detail = detailChargeFixeSurPeriode(charge, ["2026-09-01"], [], [ca], FIN_LOINTAINE);
    assert.deepEqual(detail, { montantSource: 300000, montantCharge: 120000 });
  });

  test("source saisonnalisée, charge quotidienne, sélection de plusieurs jours du même mois : les N/N' se somment", () => {
    const ca = rentree({
      id: "ca",
      dateDebut: "2026-01-01",
      frequence: "quotidien",
      modeMontant: "saisonnalise",
      profilSaisonnalite: { montantAnnuel: 1000000, ponderationsMensuelles: Array(12).fill(70 / 11).map((p, i) => (i === 8 ? 30 : p)) },
    });
    const charge = chargeFixe({
      datePrevue: "2026-01-01",
      recurrence: "quotidien",
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });
    // Septembre = 120 000 € pour la charge, 30 jours -> 4000 €/jour. 3 jours sélectionnés = 12 000 €.
    const detail = detailChargeFixeSurPeriode(charge, ["2026-09-14", "2026-09-15", "2026-09-16"], [], [ca], FIN_LOINTAINE);
    assert.equal(detail!.montantCharge, 12000);
    assert.equal(detail!.montantSource, 30000); // 40% x 30000 = 12000
  });

  test("aucune date sélectionnée : 0/0, jamais null (résultat valide, pas indisponible)", () => {
    const ca = rentree({ id: "ca", montant: 1000, dateDebut: "2026-01-01", frequence: "quotidien" });
    const ads = chargeFixe({
      datePrevue: "2026-01-01",
      recurrence: "hebdomadaire",
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });
    const detail = detailChargeFixeSurPeriode(ads, [], [], [ca], FIN_LOINTAINE);
    assert.deepEqual(detail, { montantSource: 0, montantCharge: 0 });
  });

  test("charge en mode fixe : pas de notion de source sur une plage, retourne null", () => {
    const charge = chargeFixe({ montant: 500, modeMontant: "fixe" });
    const detail = detailChargeFixeSurPeriode(charge, ["2026-01-01"], [], [], FIN_LOINTAINE);
    assert.equal(detail, null);
  });

  test("une occurrence de la plage est indisponible (source invalide) : le résultat entier est null", () => {
    const caInvalide = rentree({
      id: "ca",
      dateDebut: "2026-01-01",
      frequence: "mensuel",
      modeMontant: "saisonnalise",
      profilSaisonnalite: { montantAnnuel: 1000000, ponderationsMensuelles: Array(12).fill(5) }, // total 60, hors tolérance
    });
    const charge = chargeFixe({
      datePrevue: "2026-01-01",
      recurrence: "mensuel",
      modeMontant: "calcule",
      tauxCalcul: 40,
      sourceCalculId: "ca",
      sourceCalculType: "rentree_reguliere",
    });
    const detail = detailChargeFixeSurPeriode(charge, ["2026-09-01"], [], [caInvalide], FIN_LOINTAINE);
    assert.equal(detail, null);
  });
});
