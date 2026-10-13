import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calculerProjectionCash } from "./cash-engine";
import { calculerSyntheseMensuelle } from "./syntheseMensuelle";
import { calculerFluxPeriode } from "./periodeFiltre";
import { parseDateISO } from "./dates";
import {
  cleNomFournisseur,
  construireLien,
  construireMapping,
  dateCashFacture,
  detacherFactures,
  liensARattacher,
  occurrenceCorrespondante,
  occurrencesRapprochables,
  proposerRapprochements,
  resoudreRemplacements,
} from "./rapprochementChargesFixes";
import { ChargeFixe, FactureFournisseur, LienRapprochement, MappingFournisseurCharge } from "./types";

const DATE_RELEVE = "2026-10-01";
const HORIZON = 90;
const SOLDE = 100_000;

function charge(overrides: Partial<ChargeFixe> = {}): ChargeFixe {
  return {
    id: "daf",
    libelle: "DAF part-time",
    montant: 2000,
    datePrevue: "2026-10-05",
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

function facture(overrides: Partial<FactureFournisseur> = {}): FactureFournisseur {
  return {
    id: "f-oct",
    facture: "CRO-0001",
    fournisseur: "Crocatus",
    montant: 1990,
    dateEcheance: "2026-10-15",
    datePaiementPrevue: "2026-10-30",
    litigieuse: false,
    payee: false,
    paidAt: null,
    pennylaneId: "pl-1001",
    pennylaneSupplierId: "501",
    ...overrides,
  };
}

interface Etat {
  factures: FactureFournisseur[];
  charges: ChargeFixe[];
  liens: LienRapprochement[];
  mappings: MappingFournisseurCharge[];
}

function proposer(etat: Etat) {
  return proposerRapprochements({
    facturesFournisseurs: etat.factures,
    chargesFixes: etat.charges,
    rentreesRegulieres: [],
    liens: etat.liens,
    mappings: etat.mappings,
    dateReleve: DATE_RELEVE,
    horizonJours: HORIZON,
  });
}

/** Confirme le rapprochement comme le fait l'interface : lien + mémoire fournisseur. */
function confirmer(etat: Etat, f: FactureFournisseur, chargeId: string, dateOccurrence: string): Etat {
  const mapping = construireMapping(f, chargeId, etat.mappings, `m-${etat.mappings.length}`);
  return {
    ...etat,
    liens: [...etat.liens, construireLien(f, chargeId, dateOccurrence, "confirme", `l-${etat.liens.length}`)],
    mappings: mapping ? [...etat.mappings, mapping] : etat.mappings,
  };
}

function projection(etat: Etat) {
  const fin = new Date(parseDateISO(DATE_RELEVE));
  fin.setDate(fin.getDate() + HORIZON);
  const { remplacements } = resoudreRemplacements(etat.liens, etat.charges, etat.factures, fin);
  return calculerProjectionCash({
    soldeInitial: SOLDE,
    facturesClients: [],
    facturesFournisseurs: etat.factures,
    chargesFixes: etat.charges,
    autresDepenses: [],
    financements: [],
    rentreesRegulieres: [],
    dateDepart: DATE_RELEVE,
    horizonJours: HORIZON,
    remplacements,
  });
}

const soldeAu = (etat: Etat, date: string) => projection(etat).serie.find((p) => p.date === date)?.solde;

const ETAT_INITIAL: Etat = { factures: [facture()], charges: [charge()], liens: [], mappings: [] };

describe("briques", () => {
  test("nom de fournisseur normalisé", () => {
    assert.equal(cleNomFournisseur("CROCATUS SAS"), "crocatus");
    assert.equal(cleNomFournisseur("  Crocatus "), "crocatus");
    assert.equal(cleNomFournisseur("Société Générale S.A."), "societe generale s a");
    assert.equal(cleNomFournisseur("SAS"), "sas");
  });

  test("date cash : paiement prévu d'abord, échéance à défaut", () => {
    assert.equal(dateCashFacture({ datePaiementPrevue: "2026-10-30", dateEcheance: "2026-10-15" }), "2026-10-30");
    assert.equal(dateCashFacture({ datePaiementPrevue: "", dateEcheance: "2026-10-15" }), "2026-10-15");
    assert.equal(dateCashFacture({ datePaiementPrevue: "", dateEcheance: "" }), "");
  });

  test("occurrence mensuelle : même mois civil, sinon la plus proche à 10 jours", () => {
    const occurrences = ["2026-10-05", "2026-11-05", "2026-12-05"].map(parseDateISO);
    // 30/10 est plus près du 05/11 que du 05/10 : le mois civil l'emporte.
    assert.equal(occurrenceCorrespondante(occurrences, "mensuel", "2026-10-30")?.getDate(), 5);
    assert.equal(occurrenceCorrespondante(occurrences, "mensuel", "2026-10-30")?.getMonth(), 9);
    assert.equal(occurrenceCorrespondante(["2026-10-30"].map(parseDateISO), "mensuel", "2026-11-02")?.getMonth(), 9);
    assert.equal(occurrenceCorrespondante(["2026-10-05"].map(parseDateISO), "mensuel", "2026-11-20"), null);
  });

  test("occurrence hebdomadaire : 3 jours au plus", () => {
    const occurrences = ["2026-10-05", "2026-10-12"].map(parseDateISO);
    assert.equal(occurrenceCorrespondante(occurrences, "hebdomadaire", "2026-10-14")?.getDate(), 12);
    assert.equal(occurrenceCorrespondante(occurrences, "hebdomadaire", "2026-10-16"), null);
  });
});

describe("scénarios produit", () => {
  test("A. montant proche, date proche, aucun historique : proposition, jamais de neutralisation automatique", () => {
    const propositions = proposer(ETAT_INITIAL);
    assert.equal(propositions.length, 1);
    assert.equal(propositions[0].niveau, "probable");
    assert.deepEqual(propositions[0].candidats.map((c) => [c.chargeFixeId, c.dateOccurrence, c.montantPrevu]), [["daf", "2026-10-05", 2000]]);
    // Tant que rien n'est confirmé, la projection compte encore les deux : 2 000 le 05/10, 1 990 le 30/10.
    assert.equal(soldeAu(ETAT_INITIAL, "2026-10-05"), SOLDE - 2000);
    assert.equal(soldeAu(ETAT_INITIAL, "2026-10-30"), SOLDE - 2000 - 1990);
  });

  test("B + C + date réelle. confirmation : l'occurrence d'octobre disparaît, la facture seule est projetée, novembre revient", () => {
    const etat = confirmer(ETAT_INITIAL, facture(), "daf", "2026-10-05");
    assert.equal(soldeAu(etat, "2026-10-05"), SOLDE, "plus de sortie le 05/10");
    assert.equal(soldeAu(etat, "2026-10-30"), SOLDE - 1990, "sortie facture le 30/10");
    assert.equal(soldeAu(etat, "2026-11-05"), SOLDE - 1990 - 2000, "novembre : la Charge fixe revient");
    assert.deepEqual(proposer(etat), [], "plus rien à proposer");
  });

  test("D. la facture rapprochée devient Payée : elle sort de la projection, l'occurrence ne revient pas", () => {
    const payee = facture({ payee: true, paidAt: "2026-10-28T10:00:00Z" });
    const etat = { ...confirmer(ETAT_INITIAL, facture(), "daf", "2026-10-05"), factures: [payee] };
    assert.equal(soldeAu(etat, "2026-10-05"), SOLDE);
    assert.equal(soldeAu(etat, "2026-10-30"), SOLDE, "ni occurrence ni facture");
    assert.equal(soldeAu(etat, "2026-11-05"), SOLDE - 2000);
  });

  test("E. même fournisseur le mois suivant : proposition forte grâce au mapping mémorisé", () => {
    const novembre = facture({ id: "f-nov", facture: "CRO-0002", montant: 1995, dateEcheance: "2026-11-28", datePaiementPrevue: "2026-11-28", pennylaneId: "pl-1010" });
    const etat = { ...confirmer(ETAT_INITIAL, facture(), "daf", "2026-10-05"), factures: [facture(), novembre] };
    const propositions = proposer(etat);
    assert.equal(propositions.length, 1);
    assert.equal(propositions[0].factureId, "f-nov");
    assert.equal(propositions[0].niveau, "forte");
    assert.equal(propositions[0].candidats[0].dateOccurrence, "2026-11-05");
    // Forte ne veut pas dire automatique : novembre compte encore la charge ET la facture.
    assert.equal(soldeAu(etat, "2026-11-28"), SOLDE - 1990 - 2000 - 1995);
  });

  test("F. même montant, fournisseur différent : jamais prioritaire sur le fournisseur connu, jamais sur une occurrence déjà remplacée", () => {
    const crocatusNov = facture({ id: "f-nov", montant: 1995, dateEcheance: "2026-11-28", datePaiementPrevue: "2026-11-28", pennylaneId: "pl-1010" });
    const autre = facture({ id: "f-autre", fournisseur: "Autre Conseil", montant: 2000, dateEcheance: "2026-11-06", datePaiementPrevue: "2026-11-06", pennylaneId: "pl-1008", pennylaneSupplierId: "507" });
    const base = confirmer(ETAT_INITIAL, facture(), "daf", "2026-10-05");

    const avecLesDeux = proposer({ ...base, factures: [facture(), crocatusNov, autre] });
    assert.deepEqual(avecLesDeux.map((p) => [p.factureId, p.niveau]), [["f-nov", "forte"]]);

    // Sans facture du fournisseur connu : l'autre fournisseur n'est qu'une proposition « probable ».
    const sansCrocatus = proposer({ ...base, factures: [facture(), autre] });
    assert.deepEqual(sansCrocatus.map((p) => [p.factureId, p.niveau]), [["f-autre", "probable"]]);

    // Octobre est déjà remplacé : une autre facture d'octobre au même montant n'est pas proposée.
    const autreOctobre = { ...autre, id: "f-autre-oct", dateEcheance: "2026-10-06", datePaiementPrevue: "2026-10-06", pennylaneId: "pl-1009" };
    assert.deepEqual(proposer({ ...base, factures: [facture(), autreOctobre] }), []);
  });

  test("G. deux Charges fixes candidates : ambiguïté affichée, aucune neutralisation", () => {
    const etat: Etat = {
      factures: [facture({ id: "f-loyer", fournisseur: "Immo Gestion", montant: 1500, dateEcheance: "2026-10-11", datePaiementPrevue: "2026-10-11", pennylaneSupplierId: "502" })],
      charges: [
        charge({ id: "bureau", libelle: "Loyer bureau", montant: 1500, datePrevue: "2026-10-10" }),
        charge({ id: "entrepot", libelle: "Loyer entrepôt", montant: 1500, datePrevue: "2026-10-12" }),
      ],
      liens: [],
      mappings: [],
    };
    const propositions = proposer(etat);
    assert.equal(propositions.length, 1);
    assert.equal(propositions[0].niveau, "ambigue");
    assert.deepEqual(propositions[0].candidats.map((c) => c.chargeFixeId).sort(), ["bureau", "entrepot"]);
    assert.equal(soldeAu(etat, "2026-10-12"), SOLDE - 1500 - 1500 - 1500, "tout reste compté");
  });

  test("G bis. deux factures inconnues pour une même occurrence : ambiguïté", () => {
    const etat: Etat = {
      ...ETAT_INITIAL,
      factures: [facture(), facture({ id: "f-2", fournisseur: "Autre Conseil", montant: 2000, pennylaneId: "pl-2", pennylaneSupplierId: "507" })],
    };
    assert.deepEqual(proposer(etat).map((p) => p.niveau), ["ambigue", "ambigue"]);
  });

  test("G ter. un fournisseur déjà rapproché de deux charges : ambiguïté entre elles", () => {
    const f = facture({ id: "f-loyer", fournisseur: "Immo Gestion", montant: 1500, dateEcheance: "2026-10-11", datePaiementPrevue: "2026-10-11", pennylaneSupplierId: "502" });
    const mapping = (chargeFixeId: string): MappingFournisseurCharge => ({ id: `m-${chargeFixeId}`, chargeFixeId, pennylaneSupplierId: "502", cleNom: "immo gestion", libelle: "Immo Gestion" });
    const etat: Etat = {
      factures: [f],
      charges: [charge({ id: "bureau", montant: 1500, datePrevue: "2026-10-10" }), charge({ id: "entrepot", montant: 1500, datePrevue: "2026-10-12" }), charge({ id: "autre", montant: 1500, datePrevue: "2026-10-14" })],
      liens: [],
      mappings: [mapping("bureau"), mapping("entrepot")],
    };
    const propositions = proposer(etat);
    assert.equal(propositions[0].niveau, "ambigue");
    assert.deepEqual(propositions[0].candidats.map((c) => c.chargeFixeId).sort(), ["bureau", "entrepot"]);
  });

  test("H. facture supérieure au prévu : hors seuil sans historique, proposée à 15 % si fournisseur connu, et elle remplace bien", () => {
    const f2300 = facture({ montant: 2300 });
    assert.deepEqual(proposer({ ...ETAT_INITIAL, factures: [f2300] }), [], "15 % d'écart, fournisseur inconnu : pas de proposition");

    const connu: MappingFournisseurCharge = { id: "m", chargeFixeId: "daf", pennylaneSupplierId: "501", cleNom: "crocatus", libelle: "Crocatus" };
    assert.equal(proposer({ ...ETAT_INITIAL, factures: [f2300], mappings: [connu] })[0].niveau, "forte");
    assert.deepEqual(proposer({ ...ETAT_INITIAL, factures: [facture({ montant: 2301 })], mappings: [connu] }), [], "au-delà de 15 % : rien");
    assert.deepEqual(proposer({ ...ETAT_INITIAL, factures: [facture({ montant: 1400 })], mappings: [connu] }), [], "2 000 contre 1 400 : jamais proche");

    const etat = confirmer({ ...ETAT_INITIAL, factures: [f2300] }, f2300, "daf", "2026-10-05");
    assert.equal(soldeAu(etat, "2026-10-30"), SOLDE - 2300, "2 300, ni 2 000 ni 4 300");
  });

  test("I. facture inférieure au prévu : même logique", () => {
    const f1800 = facture({ montant: 1800 });
    assert.equal(proposer({ ...ETAT_INITIAL, factures: [f1800] })[0].niveau, "probable", "10 % pile : proposée");
    assert.deepEqual(proposer({ ...ETAT_INITIAL, factures: [facture({ montant: 1799 })] }), []);
    const etat = confirmer({ ...ETAT_INITIAL, factures: [f1800] }, f1800, "daf", "2026-10-05");
    assert.equal(soldeAu(etat, "2026-10-30"), SOLDE - 1800);
  });

  test("J. resynchronisation identique : mêmes propositions, aucun doublon après décision", () => {
    assert.deepEqual(proposer(ETAT_INITIAL), proposer(ETAT_INITIAL));
    const etat = confirmer(ETAT_INITIAL, facture(), "daf", "2026-10-05");
    assert.deepEqual(proposer(etat), []);
    assert.deepEqual(proposer(etat), []);
    assert.equal(construireMapping(facture(), "daf", etat.mappings), null, "mapping déjà mémorisé : pas de second");
  });
});

describe("refus, date cash, garde-fous", () => {
  test("refus : aucun effet sur la projection, couple jamais reproposé", () => {
    const etat: Etat = { ...ETAT_INITIAL, liens: [construireLien(facture(), "daf", "2026-10-05", "refuse", "l-0")] };
    assert.deepEqual(proposer(etat), []);
    assert.equal(soldeAu(etat, "2026-10-30"), SOLDE - 2000 - 1990);
    assert.deepEqual(etat.mappings, []);
  });

  test("le matching suit la date de paiement prévue, pas l'échéance administrative", () => {
    // Échéance en octobre, paiement prévu décalé en novembre : c'est l'occurrence de novembre.
    const decalee = facture({ dateEcheance: "2026-10-15", datePaiementPrevue: "2026-11-20" });
    assert.equal(proposer({ ...ETAT_INITIAL, factures: [decalee] })[0].candidats[0].dateOccurrence, "2026-11-05");
  });

  test("facture sans aucune date : jamais proposée", () => {
    assert.deepEqual(proposer({ ...ETAT_INITIAL, factures: [facture({ dateEcheance: "", datePaiementPrevue: "" })] }), []);
  });

  test("facture litigieuse, charge « À couper », charge quotidienne : jamais proposées", () => {
    assert.deepEqual(proposer({ ...ETAT_INITIAL, factures: [facture({ litigieuse: true })] }), []);
    assert.deepEqual(proposer({ ...ETAT_INITIAL, charges: [charge({ aCouper: true })] }), []);
    assert.deepEqual(proposer({ ...ETAT_INITIAL, charges: [charge({ recurrence: "quotidien", montant: 1990 })] }), []);
  });

  test("vieille facture et occurrence toutes deux hors projection : rien à dédoublonner", () => {
    const ancienne = facture({ dateEcheance: "2026-08-10", datePaiementPrevue: "2026-08-10" });
    assert.deepEqual(proposer({ ...ETAT_INITIAL, factures: [ancienne], charges: [charge({ datePrevue: "2026-06-05" })] }), []);
  });

  test("identité fournisseur : l'identifiant Pennylane prime sur le nom", () => {
    const mappingCrocatus: MappingFournisseurCharge = { id: "m", chargeFixeId: "daf", pennylaneSupplierId: "501", cleNom: "crocatus", libelle: "Crocatus" };
    // Même nom, autre identifiant Pennylane : ce n'est pas le fournisseur connu.
    const homonyme = facture({ pennylaneSupplierId: "999" });
    assert.equal(proposer({ ...ETAT_INITIAL, factures: [homonyme], mappings: [mappingCrocatus] })[0].niveau, "probable");
    // Nom différent, même identifiant (changement de raison sociale) : toujours connu.
    const renomme = facture({ fournisseur: "Crocatus Conseil SAS" });
    assert.equal(proposer({ ...ETAT_INITIAL, factures: [renomme], mappings: [mappingCrocatus] })[0].niveau, "forte");
    // Mapping sans identifiant (facture saisie à la main) : repli sur le nom normalisé.
    const mappingParNom: MappingFournisseurCharge = { ...mappingCrocatus, pennylaneSupplierId: null };
    const manuelle = facture({ fournisseur: "CROCATUS SAS", pennylaneId: null, pennylaneSupplierId: null });
    assert.equal(proposer({ ...ETAT_INITIAL, factures: [manuelle], mappings: [mappingParNom] })[0].niveau, "forte");
  });
});

describe("durabilité du remplacement", () => {
  const confirme = confirmer(ETAT_INITIAL, facture(), "daf", "2026-10-05");
  const fin = parseDateISO("2026-12-30");

  test("facture supprimée : l'occurrence reste remplacée, le lien est « à revoir »", () => {
    const etat: Etat = { ...confirme, factures: [], liens: confirme.liens.map((l) => ({ ...l, factureFournisseurId: null })) };
    assert.equal(soldeAu(etat, "2026-10-05"), SOLDE, "l'occurrence ne réapparaît pas");
    const { aRevoir } = resoudreRemplacements(etat.liens, etat.charges, etat.factures, fin);
    assert.deepEqual(aRevoir.map((a) => a.motif), ["facture_absente"]);
    // « Laisser remplacée » : l'avertissement disparaît, l'occurrence reste remplacée.
    const ecarte = etat.liens.map((l) => ({ ...l, revueEcarteeLe: "2026-10-20T00:00:00Z" }));
    assert.deepEqual(resoudreRemplacements(ecarte, etat.charges, etat.factures, fin).aRevoir, []);
    assert.equal(soldeAu({ ...etat, liens: ecarte }, "2026-10-05"), SOLDE);
  });

  test("suppression de facture : décisions détachées et conservées, sauf un refus sans identité Pennylane", () => {
    const manuelle = facture({ id: "f-man", pennylaneId: null, pennylaneSupplierId: null });
    const liens = [
      construireLien(facture(), "daf", "2026-10-05", "confirme", "confirme-pl"),
      construireLien(facture(), "autre", "2026-10-05", "refuse", "refus-pl"),
      construireLien(manuelle, "daf", "2026-11-05", "confirme", "confirme-man"),
      construireLien(manuelle, "autre", "2026-11-05", "refuse", "refus-man"),
    ];
    const apres = detacherFactures(liens, ["f-oct", "f-man"]);
    assert.deepEqual(apres.map((l) => [l.id, l.factureFournisseurId]), [["confirme-pl", null], ["refus-pl", null], ["confirme-man", null]]);
    assert.deepEqual(detacherFactures(liens, ["autre-facture"]), liens);
  });

  test("même facture Pennylane réimportée sous un nouvel identifiant : décision reconnue, rattachée, pas de doublon", () => {
    const orphelins = confirme.liens.map((l) => ({ ...l, factureFournisseurId: null }));
    const reimportee = facture({ id: "f-nouvel-uuid" });
    assert.deepEqual(proposer({ ...confirme, factures: [reimportee], liens: orphelins }), [], "confirmé : pas reproposé");
    assert.deepEqual(liensARattacher(orphelins, [reimportee]), [{ lienId: "l-0", factureFournisseurId: "f-nouvel-uuid" }]);
    assert.deepEqual(liensARattacher(confirme.liens, [facture()]), [], "facture toujours là : rien à rattacher");

    const refus = [{ ...construireLien(facture(), "daf", "2026-10-05", "refuse", "l-r"), factureFournisseurId: null }];
    assert.deepEqual(proposer({ ...ETAT_INITIAL, factures: [reimportee], liens: refus }), [], "refusé : pas reproposé");
  });

  test("nouvelle version d'une facture archivée : proposée sur l'occurrence tenue par le lien orphelin", () => {
    const orphelins = confirme.liens.map((l) => ({ ...l, factureFournisseurId: null }));
    const nouvelleVersion = facture({ id: "f-v2", facture: "CRO-0001-B", pennylaneId: "pl-1011" });
    const propositions = proposer({ ...confirme, factures: [nouvelleVersion], liens: orphelins });
    assert.equal(propositions[0].niveau, "forte");
    assert.equal(propositions[0].candidats[0].lienARemplacerId, "l-0");
    // En attendant la confirmation : pas de double compte, pas de résurrection.
    assert.equal(soldeAu({ ...confirme, factures: [nouvelleVersion], liens: orphelins }, "2026-10-30"), SOLDE - 1990);
  });

  test("jour de la charge décalé dans le mois : l'occurrence reste remplacée", () => {
    const etat = { ...confirme, charges: [charge({ datePrevue: "2026-10-10" })] };
    assert.equal(soldeAu(etat, "2026-10-10"), SOLDE);
    assert.deepEqual(resoudreRemplacements(etat.liens, etat.charges, etat.factures, fin).aRevoir, []);
  });

  test("calendrier changé au point de ne plus correspondre : lien conservé et signalé « à revoir »", () => {
    const etat = { ...confirme, charges: [charge({ datePrevue: "2026-12-01" })] };
    const { aRevoir, remplacements } = resoudreRemplacements(etat.liens, etat.charges, etat.factures, fin);
    assert.deepEqual(aRevoir.map((a) => a.motif), ["occurrence_introuvable"]);
    assert.equal(remplacements.montantsReels.size, 0);
  });

  test("rapprochement manuel : toutes les occurrences libres, sans seuil de montant", () => {
    const f2300 = facture({ montant: 2300 });
    const occurrences = occurrencesRapprochables(f2300, charge(), {
      facturesFournisseurs: [f2300],
      chargesFixes: [charge()],
      rentreesRegulieres: [],
      liens: [],
      dateReleve: DATE_RELEVE,
      horizonJours: HORIZON,
    });
    assert.deepEqual(occurrences.map((o) => [o.dateOccurrence, o.suggeree]), [["2026-10-05", true], ["2026-11-05", false], ["2026-12-05", false]]);
    const apres = confirmer({ ...ETAT_INITIAL, factures: [f2300] }, f2300, "daf", "2026-10-05");
    const restantes = occurrencesRapprochables(facture({ id: "f-x", pennylaneId: "pl-x" }), charge(), {
      facturesFournisseurs: apres.factures,
      chargesFixes: apres.charges,
      rentreesRegulieres: [],
      liens: apres.liens,
      dateReleve: DATE_RELEVE,
      horizonJours: HORIZON,
    });
    assert.deepEqual(restantes.map((o) => o.dateOccurrence), ["2026-11-05", "2026-12-05"], "octobre n'est plus libre");
    assert.equal(apres.mappings.length, 1, "le rapprochement manuel mémorise aussi le fournisseur");
  });
});

describe("charges calculées et autres moteurs", () => {
  const commission = charge({ id: "commission", libelle: "Commission 10 %", montant: 200, datePrevue: "2026-10-25", modeMontant: "calcule", tauxCalcul: 10, sourceCalculId: "daf", sourceCalculType: "charge_fixe" });
  const base: Etat = { factures: [facture()], charges: [charge(), commission], liens: [], mappings: [] };

  test("base théorique tant que rien n'est confirmé : 10 % de 2 000 = 200", () => {
    assert.equal(soldeAu(base, "2026-10-25"), SOLDE - 2000 - 200);
  });

  test("source remplacée : 10 % du montant réel (199), à la date propre de la charge calculée", () => {
    const etat = confirmer(base, facture(), "daf", "2026-10-05");
    assert.equal(soldeAu(etat, "2026-10-24"), SOLDE, "rien avant le 25");
    assert.equal(soldeAu(etat, "2026-10-25"), SOLDE - 199, "199 le 25/10, date inchangée");
    assert.equal(soldeAu(etat, "2026-10-30"), SOLDE - 199 - 1990);
    assert.equal(soldeAu(etat, "2026-11-25"), SOLDE - 199 - 1990 - 2000 - 200, "novembre : base théorique");
  });

  test("facture payée : la base reste le montant réel", () => {
    const etat = { ...confirmer(base, facture(), "daf", "2026-10-05"), factures: [facture({ payee: true })] };
    assert.equal(soldeAu(etat, "2026-10-30"), SOLDE - 199);
  });

  test("synthèse mensuelle et filtre de période excluent aussi l'occurrence remplacée", () => {
    const etat = confirmer(ETAT_INITIAL, facture(), "daf", "2026-10-05");
    const { remplacements } = resoudreRemplacements(etat.liens, etat.charges, etat.factures, parseDateISO("2026-12-30"));
    const commun = { facturesClients: [], facturesFournisseurs: etat.factures, chargesFixes: etat.charges, autresDepenses: [], financements: [], rentreesRegulieres: [] };

    const synthese = calculerSyntheseMensuelle({ ...commun, dateReleve: DATE_RELEVE, horizonJours: HORIZON, remplacements });
    const ligne = (libelle: string) => synthese.lignes.find((l) => l.libelle === libelle)?.montantsParMois ?? [];
    assert.deepEqual(ligne("Charges fixes").slice(0, 3), [0, -2000, -2000]);
    assert.deepEqual(ligne("Factures fournisseurs").slice(0, 2), [-1990, 0]);

    const sans = calculerFluxPeriode({ ...commun, debut: "2026-10-01", fin: "2026-10-31" });
    const avec = calculerFluxPeriode({ ...commun, debut: "2026-10-01", fin: "2026-10-31", remplacements });
    assert.equal(sans.resume.sorties, -3990);
    assert.equal(avec.resume.sorties, -1990);
    assert.equal(avec.occurrencesChargesFixes.has("daf"), false);
  });
});
