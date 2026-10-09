import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dissocierFlux, fusionnerFlux, GroupeManuel, indexerGroupesManuels, MembreGroupe, nomDeGroupePropose } from "./flowGroups";

const membre = (cle: string, nomDetecte = cle): MembreGroupe => ({ cle, nomDetecte, exemple: `LIBELLE ${cle}` });
const cles = (groupe: GroupeManuel) => groupe.membres.map((m) => m.cle).sort();

describe("fusionnerFlux", () => {
  test("deux flux libres : un nouveau groupe", () => {
    const { groupes, groupe, supprimes } = fusionnerFlux([], [membre("tiers:pisp bridg karmen"), membre("tiers:fct karmen factor")], "Karmen", "g1");
    assert.deepEqual(groupe, groupes[0]);
    assert.equal(groupe.id, "g1");
    assert.equal(groupe.nom, "Karmen");
    assert.deepEqual(cles(groupe), ["tiers:fct karmen factor", "tiers:pisp bridg karmen"]);
    assert.deepEqual(supprimes, []);
  });

  test("un troisième flux rejoint un groupe existant, qui garde son identifiant", () => {
    const depart = fusionnerFlux([], [membre("a"), membre("b")], "Karmen", "g1").groupes;
    const { groupes, groupe, supprimes } = fusionnerFlux(depart, [membre("a"), membre("c")], "Karmen", "g2");
    assert.equal(groupes.length, 1);
    assert.equal(groupe.id, "g1");
    assert.deepEqual(cles(groupe), ["a", "b", "c"]);
    assert.deepEqual(supprimes, []);
  });

  test("deux groupes réunis : un flux n'appartient qu'à un groupe, l'autre groupe est absorbé", () => {
    let groupes = fusionnerFlux([], [membre("a"), membre("b")], "Un", "g1").groupes;
    groupes = fusionnerFlux(groupes, [membre("c"), membre("d")], "Deux", "g2").groupes;
    const resultat = fusionnerFlux(groupes, [membre("a"), membre("c")], "Ensemble", "g3");
    assert.deepEqual(resultat.groupes.map((g) => g.id), ["g1"]);
    assert.deepEqual(cles(resultat.groupe), ["a", "b", "c", "d"]);
    assert.equal(resultat.groupe.nom, "Ensemble");
    assert.deepEqual(resultat.supprimes, ["g2"]);
    const index = indexerGroupesManuels(resultat.groupes);
    assert.deepEqual([...index.values()].map((g) => g.id), ["g1", "g1", "g1", "g1"]);
  });

  test("les groupes non concernés ne bougent pas", () => {
    const autre = fusionnerFlux([], [membre("x"), membre("y")], "Autre", "g0").groupes;
    const { groupes } = fusionnerFlux(autre, [membre("a"), membre("b")], "Karmen", "g1");
    assert.deepEqual(groupes[0], autre[0]);
  });
});

describe("dissocierFlux", () => {
  const trois = fusionnerFlux([], [membre("a"), membre("b"), membre("c")], "Karmen", "g1").groupes;

  test("retirer un membre d'un groupe de trois : le groupe reste avec les deux autres", () => {
    const { groupes, groupeSupprime } = dissocierFlux(trois, "c");
    assert.deepEqual(cles(groupes[0]), ["a", "b"]);
    assert.equal(groupeSupprime, null);
  });

  test("groupe réduit à un seul membre : il est supprimé, le flux restant redevient individuel", () => {
    const deux = dissocierFlux(trois, "c").groupes;
    const { groupes, groupeSupprime } = dissocierFlux(deux, "b");
    assert.deepEqual(groupes, []);
    assert.equal(groupeSupprime, "g1");
  });

  test("flux hors de tout groupe : rien ne change", () => {
    assert.deepEqual(dissocierFlux(trois, "z"), { groupes: trois, groupeSupprime: null });
  });
});

describe("nomDeGroupePropose", () => {
  test("mots communs aux flux réunis", () => {
    assert.equal(nomDeGroupePropose(["Pisp Bridg Karmen", "Fct Karmen Factor"]), "Karmen");
    assert.equal(nomDeGroupePropose(["Karmen Factor", "FCT KARMEN FACTOR", "Karmen Factor Sas"]), "Karmen Factor");
  });

  test("aucun mot commun, ou un seul flux : le premier nom", () => {
    assert.equal(nomDeGroupePropose(["Creance", "Remboursement Dailly"]), "Creance");
    assert.equal(nomDeGroupePropose(["Europcam"]), "Europcam");
    assert.equal(nomDeGroupePropose([]), "");
  });
});
