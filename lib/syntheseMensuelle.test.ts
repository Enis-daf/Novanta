import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calculerSyntheseMensuelle } from "./syntheseMensuelle";
import { AutreDepense } from "./types";

function autreDepense(overrides: Partial<AutreDepense> = {}): AutreDepense {
  return {
    id: "ad-1",
    libelle: "Dépense",
    montant: 0,
    datePrevue: "2026-01-01",
    type: "certaine",
    facturee: false,
    payee: false,
    ...overrides,
  };
}

const PARAMS_VIDES = {
  dateReleve: "2026-01-01",
  horizonJours: 60,
  facturesClients: [],
  facturesFournisseurs: [],
  chargesFixes: [],
  financements: [],
  rentreesRegulieres: [],
};

function ligneAutresDepenses(lignes: ReturnType<typeof calculerSyntheseMensuelle>["lignes"]) {
  return lignes.find((l) => l.libelle === "Autres dépenses")!;
}

describe("calculerSyntheseMensuelle — Autres dépenses respecte Facturée et Payée (F)", () => {
  test("ni Facturée ni Payée : la dépense apparaît dans le total du mois", () => {
    const depense = autreDepense({ montant: 300, datePrevue: "2026-01-15" });
    const resultat = calculerSyntheseMensuelle({ ...PARAMS_VIDES, autresDepenses: [depense] });
    assert.equal(ligneAutresDepenses(resultat.lignes).total, -300);
  });

  test("Payée = true : la dépense est exclue de la synthèse mensuelle, comme Facturée", () => {
    const depense = autreDepense({ montant: 300, datePrevue: "2026-01-15", payee: true });
    const resultat = calculerSyntheseMensuelle({ ...PARAMS_VIDES, autresDepenses: [depense] });
    assert.equal(ligneAutresDepenses(resultat.lignes).total, 0);
  });

  test("Facturée = true : toujours exclue (comportement inchangé)", () => {
    const depense = autreDepense({ montant: 300, datePrevue: "2026-01-15", facturee: true });
    const resultat = calculerSyntheseMensuelle({ ...PARAMS_VIDES, autresDepenses: [depense] });
    assert.equal(ligneAutresDepenses(resultat.lignes).total, 0);
  });

  test("Facturée ET Payée : toujours exclue, jamais bloquant", () => {
    const depense = autreDepense({ montant: 300, datePrevue: "2026-01-15", facturee: true, payee: true });
    const resultat = calculerSyntheseMensuelle({ ...PARAMS_VIDES, autresDepenses: [depense] });
    assert.equal(ligneAutresDepenses(resultat.lignes).total, 0);
  });
});
