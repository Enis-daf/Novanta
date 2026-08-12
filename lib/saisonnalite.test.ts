import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  etatTotalPonderations,
  montantMoisBrut,
  montantMoisSaisonnalise,
  montantOccurrenceRentreeReguliere,
  normaliserPonderations,
  NOMBRE_MOIS,
  profilDepuisMontants,
  repartitionUniforme,
  totalPonderations,
} from "./saisonnalite";
import { RentreeReguliere } from "./types";

function rentreeFixe(overrides: Partial<RentreeReguliere> = {}): RentreeReguliere {
  return {
    id: "rr-1",
    libelle: "Rentree",
    montant: 1000,
    dateDebut: "2026-01-01",
    frequence: "mensuel",
    dateFin: null,
    modeMontant: "fixe",
    profilSaisonnalite: null,
    ...overrides,
  };
}

function rentreeSaisonnalisee(
  montantAnnuel: number,
  ponderationsMensuelles: number[],
  overrides: Partial<RentreeReguliere> = {}
): RentreeReguliere {
  return {
    ...rentreeFixe(overrides),
    modeMontant: "saisonnalise",
    frequence: "mensuel",
    profilSaisonnalite: { montantAnnuel, ponderationsMensuelles },
    ...overrides,
  };
}

describe("Compatibilité : ancienne/nouvelle Rentrée fixe inchangée", () => {
  test("mode fixe : retourne toujours rentree.montant, quelle que soit la date", () => {
    const r = rentreeFixe({ montant: 1800 });
    assert.equal(montantOccurrenceRentreeReguliere(r, new Date(2026, 0, 1)), 1800);
    assert.equal(montantOccurrenceRentreeReguliere(r, new Date(2026, 7, 15)), 1800);
  });
});

describe("Répartition uniforme", () => {
  test("12 valeurs de 100/12, total interne exact à la précision flottante", () => {
    const ponderations = repartitionUniforme();
    assert.equal(ponderations.length, NOMBRE_MOIS);
    ponderations.forEach((p) => assert.equal(p, 100 / 12));
    const total = totalPonderations(ponderations);
    assert.ok(Math.abs(total - 100) < 1e-9, `total ${total} devrait être ~100`);
  });

  test("l'affichage à 2 décimales (8,33 %) ne rend pas la configuration invalide", () => {
    const ponderations = repartitionUniforme();
    const total = totalPonderations(ponderations);
    assert.equal(etatTotalPonderations(total), "exact");
  });
});

describe("Total exact = 100 %", () => {
  test("validation autorisée, aucune normalisation nécessaire", () => {
    const ponderations = [10, 10, 10, 10, 10, 10, 10, 10, 5, 5, 5, 5];
    assert.equal(totalPonderations(ponderations), 100);
    assert.equal(etatTotalPonderations(100), "exact");
  });
});

describe("Normalisation basse (99,96 %)", () => {
  test("validation autorisée, normalisation proportionnelle, total final = 100 %", () => {
    const ponderations = [8, 7, 6, 7, 8, 9, 10, 15, 10, 9, 8, 2.96];
    const total = totalPonderations(ponderations);
    assert.ok(Math.abs(total - 99.96) < 1e-9);
    assert.equal(etatTotalPonderations(total), "normalisable");
    const normalisees = normaliserPonderations(ponderations);
    const totalNormalise = totalPonderations(normalisees);
    assert.ok(Math.abs(totalNormalise - 100) < 1e-9, `total normalisé ${totalNormalise}`);
  });
});

describe("Normalisation haute (100,04 %)", () => {
  test("validation autorisée, normalisation proportionnelle, total final = 100 %", () => {
    const ponderations = [8, 7, 6, 7, 8, 9, 10, 15, 10, 9, 8, 3.04];
    const total = totalPonderations(ponderations);
    assert.ok(Math.abs(total - 100.04) < 1e-9);
    assert.equal(etatTotalPonderations(total), "normalisable");
    const normalisees = normaliserPonderations(ponderations);
    assert.ok(Math.abs(totalPonderations(normalisees) - 100) < 1e-9);
  });
});

describe("Limites de tolérance", () => {
  test("99,90 % : autorisé et normalisé", () => {
    assert.equal(etatTotalPonderations(99.9), "normalisable");
  });
  test("99,89 % : validation refusée", () => {
    assert.equal(etatTotalPonderations(99.89), "invalide");
  });
  test("100,10 % : autorisé et normalisé", () => {
    assert.equal(etatTotalPonderations(100.1), "normalisable");
  });
  test("100,11 % : validation refusée", () => {
    assert.equal(etatTotalPonderations(100.11), "invalide");
  });
});

describe("Mois à zéro", () => {
  test("normaliserPonderations préserve strictement 0 pour un poids nul, quel que soit le facteur", () => {
    const ponderations = [8, 7, 6, 7, 8, 9, 10, 15, 10, 9, 8, 0]; // total 97
    const normalisees = normaliserPonderations(ponderations);
    assert.equal(normalisees[11], 0);
  });

  test("total hors tolérance (97 %) : le mois entier devient indisponible, décembre y compris", () => {
    const profil = { montantAnnuel: 1200000, ponderationsMensuelles: [8, 7, 6, 7, 8, 9, 10, 15, 10, 9, 8, 0] };
    assert.equal(montantMoisSaisonnalise(profil, 11), null);
  });

  test("cas de référence final : juillet 10 %, août 15 %, décembre 0 %, total 99,96 % -> décembre reste 0 €", () => {
    // 10 mois à des valeurs quelconques + juillet 10 + août 15 + décembre 0, total = 99,96
    const ponderations = [8, 7, 6, 7, 8, 9, 10, 15, 10, 9, 10.96, 0];
    const total = totalPonderations(ponderations);
    assert.ok(Math.abs(total - 99.96) < 1e-9, `total ${total}`);
    assert.equal(etatTotalPonderations(total), "normalisable");

    const profil = { montantAnnuel: 1200000, ponderationsMensuelles: ponderations };
    const montantDecembre = montantMoisSaisonnalise(profil, 11);
    assert.equal(montantDecembre, 0); // jamais quelques euros sur un mois à 0 % à cause de l'arrondi

    // La normalisation proportionnelle ajuste légèrement les mois non nuls (facteur 100/99,96) :
    // juillet/août ne tombent pas exactement sur 120 000 €/180 000 €, mais très proches (l'écart
    // exact dépend de la répartition des autres mois — c'est le comportement demandé, pas une
    // approximation moyenne : voir "Juillet ≈ 10,004 %" dans la spécification).
    const montantJuillet = montantMoisSaisonnalise(profil, 6);
    const montantAout = montantMoisSaisonnalise(profil, 7);
    assert.ok(montantJuillet !== null && Math.abs(montantJuillet - 120000) < 100, `juillet ${montantJuillet}`);
    assert.ok(montantAout !== null && Math.abs(montantAout - 180000) < 100, `août ${montantAout}`);
  });
});

describe("Calcul du montant mensuel", () => {
  test("montant annuel 1 200 000 €, août 15 % -> 180 000 €", () => {
    const profil = { montantAnnuel: 1200000, ponderationsMensuelles: [0, 0, 0, 0, 0, 0, 0, 15, 0, 0, 0, 85] };
    assert.equal(montantMoisSaisonnalise(profil, 7), 180000);
  });
});

describe("Modification du montant annuel ou des pondérations : recalcul immédiat", () => {
  test("changer le montant annuel recalcule immédiatement le mois (fonctions pures, sans état)", () => {
    const ponderations = [8, 7, 6, 7, 8, 9, 10, 15, 10, 9, 8, 3];
    const profilAvant = { montantAnnuel: 1200000, ponderationsMensuelles: ponderations };
    const profilApres = { montantAnnuel: 2000000, ponderationsMensuelles: ponderations };
    assert.equal(montantMoisSaisonnalise(profilAvant, 7), 180000); // 15% x 1 200 000
    assert.equal(montantMoisSaisonnalise(profilApres, 7), 300000); // 15% x 2 000 000
  });

  test("changer une pondération recalcule immédiatement le mois concerné", () => {
    const base = [8, 7, 6, 7, 8, 9, 10, 15, 10, 9, 8, 3]; // total 100
    // +1 sur août, -1 sur janvier : le total reste 100, seul le mois modifié doit changer.
    const modifie = base.map((p, i) => (i === 7 ? 16 : i === 0 ? 7 : p));
    assert.equal(totalPonderations(modifie), 100);
    const profil = { montantAnnuel: 1000000, ponderationsMensuelles: modifie };
    assert.equal(montantMoisSaisonnalise(profil, 7), 160000);
  });

  test("Répartition uniforme remet 1/12 par mois et recalcule tous les montants", () => {
    const profil = { montantAnnuel: 1200000, ponderationsMensuelles: repartitionUniforme() };
    const attendu = 1200000 * (100 / 12 / 100);
    for (let i = 0; i < NOMBRE_MOIS; i++) {
      const montant = montantMoisSaisonnalise(profil, i);
      assert.ok(montant !== null && Math.abs(montant - attendu) < 0.01, `mois ${i} : ${montant}`);
    }
  });
});

describe("Dates : respect de la date de début/fin (délégué au moteur d'occurrences existant)", () => {
  test("une rentrée saisonnalisée mensuelle suit la même génération d'occurrences qu'une rentrée fixe mensuelle", () => {
    // montantOccurrenceRentreeReguliere ne fait aucune proratisation : il répond juste "quel
    // montant pour ce mois", à charge de l'appelant (genererOccurrencesRecurrentes, inchangé)
    // de ne jamais produire d'occurrence avant dateDebut ou après dateFin.
    const r = rentreeSaisonnalisee(1200000, [8, 7, 6, 7, 8, 9, 10, 15, 10, 9, 8, 3], {
      dateDebut: "2026-08-15",
    });
    const montantAout = montantOccurrenceRentreeReguliere(r, new Date(2026, 7, 15));
    assert.ok(montantAout !== null && Math.abs(montantAout - 180000) < 1);
  });
});

describe("Répartition mensuel/hebdomadaire/quotidien : la saisonnalité reste mensuelle, seul le découpage change", () => {
  const ponderations = [8, 8, 8, 8, 8, 8, 10, 15, 8, 8, 8, 3]; // total 100, août = 15%, septembre = 8%

  test("breakdown mensuel : le montant du mois est versé en une seule occurrence", () => {
    const r = rentreeSaisonnalisee(1200000, ponderations, { frequence: "mensuel", dateDebut: "2026-01-01" });
    const montant = montantOccurrenceRentreeReguliere(r, new Date(2026, 7, 1)); // 1er août
    assert.equal(montant, 180000); // 15% x 1 200 000, versé en une fois
  });

  test("breakdown quotidien : le montant du mois est réparti à parts égales sur ses jours", () => {
    const r = rentreeSaisonnalisee(1200000, ponderations, { frequence: "quotidien", dateDebut: "2026-01-01" });
    // Août 2026 compte 31 jours.
    const montantUnJour = montantOccurrenceRentreeReguliere(r, new Date(2026, 7, 15));
    assert.ok(montantUnJour !== null);
    assert.ok(Math.abs(montantUnJour - 180000 / 31) < 0.01, `montant/jour : ${montantUnJour}`);

    // La somme des 31 jours doit reconstituer le montant mensuel (aux centimes d'arrondi près).
    let sommeAout = 0;
    for (let jour = 1; jour <= 31; jour++) {
      const m = montantOccurrenceRentreeReguliere(r, new Date(2026, 7, jour));
      assert.ok(m !== null);
      sommeAout += m!;
    }
    assert.ok(Math.abs(sommeAout - 180000) < 0.5, `somme du mois : ${sommeAout}`);
  });

  test("breakdown hebdomadaire : le montant du mois est réparti sur les semaines qui y tombent (4 ou 5 selon le mois)", () => {
    // Aout 2026 : le 1er est un samedi -> 5 lundis dans le mois (3, 10, 17, 24, 31).
    // Septembre 2026 : 4 lundis (7, 14, 21, 28).
    const r = rentreeSaisonnalisee(1200000, ponderations, { frequence: "hebdomadaire", dateDebut: "2026-08-03" });

    const montantAout = montantOccurrenceRentreeReguliere(r, new Date(2026, 7, 3)); // lundi 3 août
    assert.ok(montantAout !== null && Math.abs(montantAout - 180000 / 5) < 0.01, `août : ${montantAout}`);

    const montantSeptembre = montantOccurrenceRentreeReguliere(r, new Date(2026, 8, 7)); // lundi 7 sept.
    assert.ok(montantSeptembre !== null && Math.abs(montantSeptembre - 96000 / 4) < 0.01, `septembre : ${montantSeptembre}`);
  });

  test("changer uniquement la fréquence (mensuel -> quotidien) change le découpage sans changer le montant mensuel total", () => {
    const rMensuel = rentreeSaisonnalisee(1200000, ponderations, { frequence: "mensuel", dateDebut: "2026-01-01" });
    const rQuotidien = { ...rMensuel, frequence: "quotidien" as const };

    const montantMensuel = montantOccurrenceRentreeReguliere(rMensuel, new Date(2026, 7, 1));
    let sommeQuotidienne = 0;
    for (let jour = 1; jour <= 31; jour++) {
      sommeQuotidienne += montantOccurrenceRentreeReguliere(rQuotidien, new Date(2026, 7, jour)) ?? 0;
    }
    assert.ok(montantMensuel !== null);
    assert.ok(Math.abs(sommeQuotidienne - montantMensuel!) < 0.5);
  });
});

describe("Édition d'un montant mensuel : recalcule le CA total et les 12 pourcentages, sans nouvel état", () => {
  test("éditer le montant d'un mois recalcule le montant annuel comme la somme des 12 montants", () => {
    const profilInitial = { montantAnnuel: 1200000, ponderationsMensuelles: [8, 8, 8, 8, 8, 8, 10, 15, 8, 8, 8, 3] };
    // Montants courants (bruts) des 12 mois, puis édition manuelle d'août (15% -> 200 000 €).
    const montantsCourants = profilInitial.ponderationsMensuelles.map((_, i) => montantMoisBrut(profilInitial, i));
    montantsCourants[7] = 200000;

    const nouveauProfil = profilDepuisMontants(montantsCourants);

    const sommeAttendue = montantsCourants.reduce((a, b) => a + b, 0);
    assert.equal(nouveauProfil.montantAnnuel, sommeAttendue);
    assert.equal(montantMoisBrut(nouveauProfil, 7), 200000); // le mois édité vaut exactement ce qui a été saisi
  });

  test("après édition d'un montant, les 12 pourcentages recalculés totalisent exactement 100 %", () => {
    const profilInitial = { montantAnnuel: 1200000, ponderationsMensuelles: [8, 8, 8, 8, 8, 8, 10, 15, 8, 8, 8, 3] };
    const montantsCourants = profilInitial.ponderationsMensuelles.map((_, i) => montantMoisBrut(profilInitial, i));
    montantsCourants[7] = 250000; // valeur arbitraire, sans rapport avec les autres mois

    const nouveauProfil = profilDepuisMontants(montantsCourants);
    const totalPourcentages = totalPonderations(nouveauProfil.ponderationsMensuelles);
    assert.ok(Math.abs(totalPourcentages - 100) < 1e-9, `total : ${totalPourcentages}`);
  });

  test("aucun champ 'modifié à la main' n'est ajouté au profil résultant", () => {
    const nouveauProfil = profilDepuisMontants([100000, 100000, 100000, 100000, 100000, 100000, 100000, 100000, 100000, 100000, 100000, 100000]);
    assert.deepEqual(Object.keys(nouveauProfil).sort(), ["montantAnnuel", "ponderationsMensuelles"]);
  });
});

describe("Édition du CA total : recalcule les montants mensuels depuis les pourcentages existants", () => {
  test("changer le montant annuel recalcule tous les montants mensuels sans toucher aux pourcentages", () => {
    const profilAvant = { montantAnnuel: 1200000, ponderationsMensuelles: [8, 8, 8, 8, 8, 8, 10, 15, 8, 8, 8, 3] };
    const profilApres = { ...profilAvant, montantAnnuel: 2000000 };

    assert.equal(montantMoisBrut(profilAvant, 7), 180000); // 15% x 1 200 000
    assert.equal(montantMoisBrut(profilApres, 7), 300000); // 15% x 2 000 000
    assert.deepEqual(profilApres.ponderationsMensuelles, profilAvant.ponderationsMensuelles); // pourcentages inchangés
  });
});

describe("Édition d'un pourcentage mensuel : recalcule le montant du mois correspondant", () => {
  test("changer une pondération recalcule immédiatement le montant du mois concerné", () => {
    const profil = { montantAnnuel: 1200000, ponderationsMensuelles: [8, 8, 8, 8, 8, 8, 10, 15, 8, 8, 8, 3] };
    assert.equal(montantMoisBrut(profil, 7), 180000);

    const profilModifie = {
      ...profil,
      ponderationsMensuelles: profil.ponderationsMensuelles.map((p, i) => (i === 7 ? 20 : p)),
    };
    assert.equal(montantMoisBrut(profilModifie, 7), 240000); // 20% x 1 200 000
  });
});
