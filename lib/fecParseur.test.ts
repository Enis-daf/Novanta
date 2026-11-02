import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MODELE_CORRESPONDANCE } from "./comptaCorrespondance";
import { calculerPnlComptable } from "./comptaPnl";
import { analyserFec, AnalyseFec, contenuCanonique, dateDeClotureDuNom, erreurImportFec, lireDate, lireMontant, preparerImportFec, soldesDepuisImportFec } from "./fecParseur";
import { ENTETE_FEC, exerciceSynthetique, fecDepuisLignes, LigneSynthetique, ligneFec } from "./fecFixtures";

async function* parMorceaux(octets: Uint8Array, taille = 64 * 1024): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < octets.length; i += taille) yield octets.subarray(i, i + taille);
}
const analyserOctets = (octets: Uint8Array, nom = "123456789FEC20241231.txt", taille?: number) => analyserFec(() => parMorceaux(octets, taille), nom);
const analyser = (texte: string, nom?: string, taille?: number) => analyserOctets(new TextEncoder().encode(texte), nom, taille);
const code = (a: AnalyseFec, c: string) => a.anomalies.find((x) => x.code === c);
const latin1 = (texte: string) => Uint8Array.from([...texte].map((c) => c.charCodeAt(0)));
const L = (numero: string, compte: string, debit: string, credit: string, date = "20240315", journal = "OD"): LigneSynthetique => ({ numero, compte, debit, credit, date, journal });
const SIMPLE = [L("1", "706000", "0,00", "100,00"), L("1", "411000", "100,00", "0,00")];

describe("Montants", () => {
  const c = (s: string) => lireMontant(s)?.centimes ?? null;

  test("format officiel : virgule décimale, signe devant ou derrière", () => {
    assert.equal(c("1234,56"), 123456);
    assert.equal(c("-1234,56"), -123456);
    assert.equal(c("1234,56-"), -123456);
    assert.equal(c("+12,00"), 1200);
    assert.equal(c("0,00"), 0);
  });

  test("formats rencontrés : point décimal, espaces, milliers", () => {
    assert.equal(c("1234.56"), 123456);
    assert.equal(c("1 234,56"), 123456);
    assert.equal(c("1 234,56"), 123456);
    assert.equal(c("1.234,56"), 123456);
    assert.equal(c("1,234.56"), 123456);
    assert.equal(c("1.234.567"), 123456700);
  });

  test("zone vide : zéro", () => {
    assert.equal(c(""), 0);
    assert.equal(c("   "), 0);
  });

  test("illisible : jamais deviné", () => {
    for (const s of ["abc", "12a", "1,2,3", "1.2.3", "1,234,56.7.8", "--5", "1.23,45,6"]) assert.equal(c(s), null, s);
  });

  test("au-delà du centime : arrondi et signalé", () => {
    assert.deepEqual(lireMontant("1,005"), { centimes: Math.round(1.005 * 100), sousLeCentime: true });
    assert.equal(lireMontant("1,500")?.sousLeCentime, false);
  });
});

describe("Dates", () => {
  test("AAAAMMJJ : format officiel", () => {
    assert.deepEqual(lireDate("20240229"), { date: "2024-02-29", officiel: true });
  });

  test("autres formats lisibles : acceptés, marqués", () => {
    assert.deepEqual(lireDate("2024-03-15"), { date: "2024-03-15", officiel: false });
    assert.deepEqual(lireDate("2024-03-15T00:00:00"), { date: "2024-03-15", officiel: false });
    assert.deepEqual(lireDate("15/03/2024"), { date: "2024-03-15", officiel: false });
  });

  test("impossible ou illisible : jamais corrigé", () => {
    for (const s of ["20230229", "20241301", "", "abc", "31/02/2024", "2024315"]) assert.equal(lireDate(s), null, s);
  });

  test("date de clôture dans le nom du fichier, suffixe compris", () => {
    assert.equal(dateDeClotureDuNom("123456789FEC20241231.txt"), "2024-12-31");
    assert.equal(dateDeClotureDuNom("123456789FEC20131231_01"), "2013-12-31");
    assert.equal(dateDeClotureDuNom("export.txt"), null);
    assert.equal(dateDeClotureDuNom("123456789FEC20241332.txt"), null);
  });
});

describe("Fichier conforme", () => {
  test("lecture, totaux, compteurs", async () => {
    const a = await analyser(fecDepuisLignes(SIMPLE));
    assert.equal(a.bloquant, false);
    assert.equal(a.separateur, "tabulation");
    assert.equal(a.encodage, "UTF-8");
    assert.equal(a.nombreLignes, 2);
    assert.equal(a.nombreEcritures, 1);
    assert.equal(a.totalDebit, 100);
    assert.equal(a.totalCredit, 100);
    assert.deepEqual(a.balances.map((b) => [b.mois, b.compte, b.debit, b.credit]), [["2024-03", "411000", 100, 0], ["2024-03", "706000", 0, 100]]);
    assert.equal(a.libelles["706000"], "Compte 706000");
  });

  test("fin de ligne sans CRLF, ligne vide finale, marque UTF-8", async () => {
    const texte = "﻿" + fecDepuisLignes(SIMPLE).replace(/\r\n/g, "\n") + "\n\n";
    const a = await analyser(texte);
    assert.equal(a.bloquant, false);
    assert.equal(a.nombreLignes, 2);
  });

  test("une ligne coupée entre deux morceaux de lecture reste entière", async () => {
    const a = await analyser(fecDepuisLignes(SIMPLE), undefined, 7);
    assert.equal(a.nombreLignes, 2);
    assert.equal(a.bloquant, false);
  });
});

describe("Séparateurs", () => {
  test("barre verticale : officielle, sans remarque", async () => {
    const a = await analyser(fecDepuisLignes(SIMPLE, "|"));
    assert.equal(a.separateur, "barre verticale");
    assert.equal(a.bloquant, false);
    assert.equal(code(a, "separateur_non_officiel"), undefined);
  });

  test("point-virgule : lu, et signalé comme hors format", async () => {
    const a = await analyser(fecDepuisLignes(SIMPLE, ";"));
    assert.equal(a.bloquant, false);
    assert.equal(code(a, "separateur_non_officiel")?.gravite, "non_bloquante");
  });

  test("champ entre guillemets contenant le séparateur", async () => {
    const entete = ENTETE_FEC.split("\t").join(";");
    const ligne = (compte: string, d: string, c: string) => `OD;Lib;1;20240315;${compte};"Nom; avec point-virgule";;;P;20240315;Lib;${d};${c};;;20240315;;`;
    const a = await analyser([entete, ligne("706000", "0,00", "1,00"), ligne("411000", "1,00", "0,00")].join("\n"));
    assert.equal(a.bloquant, false);
    assert.equal(a.libelles["706000"], "Nom; avec point-virgule");
  });

  test("aucun séparateur : bloquant", async () => {
    const a = await analyser("ceci n'est pas un FEC\nniune ligne");
    assert.equal(code(a, "separateur")?.gravite, "bloquante");
    assert.equal(a.bloquant, true);
  });
});

describe("Encodages", () => {
  const avecAccent = (encode: (s: string) => Uint8Array) => encode(fecDepuisLignes([{ ...SIMPLE[0], libelle: "Prestations facturées" }, SIMPLE[1]]));

  test("UTF-8", async () => {
    const a = await analyserOctets(avecAccent((s) => new TextEncoder().encode(s)));
    assert.equal(a.encodage, "UTF-8");
    assert.equal(a.libelles["706000"], "Prestations facturées");
  });

  test("ISO 8859-15 : relu sans erreur, accents justes", async () => {
    const a = await analyserOctets(avecAccent(latin1));
    assert.equal(a.encodage, "ISO 8859-15");
    assert.equal(a.libelles["706000"], "Prestations facturées");
    assert.equal(a.bloquant, false);
  });

  test("le symbole euro en ISO 8859-15", async () => {
    const octets = latin1(fecDepuisLignes([{ ...SIMPLE[0], libelle: "Ventes X" }, SIMPLE[1]]));
    octets[octets.indexOf("X".charCodeAt(0))] = 0xa4;
    assert.equal((await analyserOctets(octets)).libelles["706000"], "Ventes €");
  });

  test("UTF-16 avec marque", async () => {
    const texte = fecDepuisLignes(SIMPLE);
    const octets = new Uint8Array(2 + texte.length * 2);
    octets.set([0xff, 0xfe]);
    for (let i = 0; i < texte.length; i++) octets[2 + i * 2] = texte.charCodeAt(i);
    const a = await analyserOctets(octets);
    assert.equal(a.encodage, "UTF-16 LE");
    assert.equal(a.nombreLignes, 2);
  });
});

describe("Structure", () => {
  test("variante Montant et Sens, D/C", async () => {
    const entete = "JournalCode\tEcritureNum\tEcritureDate\tCompteNum\tMontant\tSens";
    const a = await analyser([entete, "OD\t1\t20240315\t706000\t100,00\tC", "OD\t1\t20240315\t411000\t100,00\tD"].join("\n"));
    assert.equal(a.formatMontants, "montant_sens");
    assert.equal(a.bloquant, false);
    assert.deepEqual(a.balances.map((b) => [b.compte, b.debit, b.credit]), [["411000", 100, 0], ["706000", 0, 100]]);
  });

  test("variante Montant et Sens, +1/-1", async () => {
    const entete = "JournalCode\tEcritureNum\tEcritureDate\tCompteNum\tMontant\tSens";
    const a = await analyser([entete, "OD\t1\t20240315\t706000\t100,00\t-1", "OD\t1\t20240315\t411000\t100,00\t+1"].join("\n"));
    assert.equal(a.totalCredit, 100);
    assert.equal(a.totalDebit, 100);
  });

  test("sens inconnu : bloquant", async () => {
    const entete = "JournalCode\tEcritureNum\tEcritureDate\tCompteNum\tMontant\tSens";
    assert.equal(code(await analyser([entete, "OD\t1\t20240315\t706000\t1,00\tX"].join("\n")), "montant_illisible")?.nombre, 1);
  });

  test("colonnes dans un autre ordre, casse différente : lues par leur nom", async () => {
    const entete = "CREDIT\tdebit\tcomptenum\tEcritureDate\tEcritureNum\tJournalCode";
    const a = await analyser([entete, "100,00\t0,00\t706000\t20240315\t1\tOD", "0,00\t100,00\t411000\t20240315\t1\tOD"].join("\n"));
    assert.equal(a.bloquant, false);
    assert.equal(a.balances.find((b) => b.compte === "706000")?.credit, 100);
  });

  test("champs officiels absents sans effet sur le calcul : signalés, non bloquants", async () => {
    const entete = "JournalCode\tEcritureNum\tEcritureDate\tCompteNum\tDebit\tCredit";
    const a = await analyser([entete, "OD\t1\t20240315\t706000\t0,00\t1,00", "OD\t1\t20240315\t411000\t1,00\t0,00"].join("\n"));
    assert.equal(a.bloquant, false);
    assert.equal(code(a, "champs_officiels_absents")?.gravite, "non_bloquante");
  });

  test("colonne de champ supplémentaire : tolérée et signalée", async () => {
    const a = await analyser([`${ENTETE_FEC}\tCodeInterne`, `${ligneFec(SIMPLE[0])}\tx`, `${ligneFec(SIMPLE[1])}\ty`].join("\n"));
    assert.equal(a.bloquant, false);
    assert.equal(code(a, "colonnes_supplementaires")?.gravite, "information");
  });

  test("les 18 champs officiels seuls : aucune colonne supplémentaire signalée", async () => {
    const a = await analyser([ENTETE_FEC, ligneFec(SIMPLE[0]), ligneFec(SIMPLE[1])].join("\n"));
    assert.equal(code(a, "colonnes_supplementaires"), undefined);
  });

  test("fichier incomplet : colonne indispensable absente, bloquant, et nommée", async () => {
    const a = await analyser("JournalCode\tEcritureNum\tDebit\tCredit\nOD\t1\t1,00\t0,00");
    assert.equal(a.bloquant, true);
    assert.match(code(a, "colonnes_manquantes")!.message, /ecrituredate.*comptenum/);
  });

  test("fichier vide, ou sans écriture", async () => {
    assert.equal(code(await analyser(""), "fichier_vide")?.gravite, "bloquante");
    assert.equal(code(await analyser(ENTETE_FEC), "aucune_ligne")?.gravite, "bloquante");
  });
});

describe("Lignes illisibles : bloquantes, jamais corrigées", () => {
  const avec = (ligne: string) => analyser([ENTETE_FEC, ligneFec(SIMPLE[0]), ligneFec(SIMPLE[1]), ligne].join("\n"));

  test("nombre de colonnes différent, avec le numéro de ligne", async () => {
    const a = await avec("OD\tcourte");
    assert.equal(a.bloquant, true);
    assert.deepEqual(code(a, "ligne_mal_formee")?.lignes, [4]);
  });

  test("date impossible", async () => {
    const a = await avec(ligneFec(L("2", "706000", "0,00", "1,00", "20241340")));
    assert.equal(code(a, "date_illisible")?.nombre, 1);
    assert.equal(a.bloquant, true);
  });

  test("montant illisible", async () => {
    assert.equal(code(await avec(ligneFec(L("2", "706000", "abc", "0,00"))), "montant_illisible")?.nombre, 1);
  });

  test("compte illisible", async () => {
    assert.equal(code(await avec(ligneFec(L("2", "", "1,00", "0,00"))), "compte_illisible")?.nombre, 1);
    assert.equal(code(await avec(ligneFec(L("2", "ABC", "1,00", "0,00"))), "compte_illisible")?.nombre, 1);
  });

  test("le message ne contient aucune valeur de la ligne", async () => {
    const a = await avec(ligneFec({ ...L("2", "706000", "SECRET", "0,00"), libelle: "Client confidentiel" }));
    assert.doesNotMatch(JSON.stringify(a.anomalies), /SECRET|confidentiel/);
  });
});

describe("Contrôles comptables", () => {
  test("fichier déséquilibré : bloquant", async () => {
    const a = await analyser(fecDepuisLignes([L("1", "706000", "0,00", "100,00"), L("1", "411000", "90,00", "0,00")]));
    assert.equal(code(a, "fichier_desequilibre")?.gravite, "bloquante");
    assert.equal(a.controles.ecrituresDesequilibrees, 1);
  });

  test("écritures déséquilibrées qui se compensent : signalé sans bloquer", async () => {
    const a = await analyser(fecDepuisLignes([L("1", "706000", "0,00", "100,00"), L("1", "411000", "90,00", "0,00"), L("2", "706000", "0,00", "90,00"), L("2", "411000", "100,00", "0,00")]));
    assert.equal(a.bloquant, false);
    assert.equal(code(a, "ecritures_desequilibrees")?.nombre, 2);
  });

  test("une même numérotation dans deux journaux : deux écritures", async () => {
    const a = await analyser(fecDepuisLignes([L("1", "706000", "0,00", "1,00", "20240315", "VE"), L("1", "411000", "1,00", "0,00", "20240315", "VE"), L("1", "607000", "2,00", "0,00", "20240315", "AC"), L("1", "401000", "0,00", "2,00", "20240315", "AC")]));
    assert.equal(a.nombreEcritures, 2);
    assert.equal(a.controles.ecrituresDesequilibrees, 0);
  });

  test("lignes strictement identiques : comptées, signalées, jamais retirées", async () => {
    const a = await analyser(fecDepuisLignes([...SIMPLE, ...SIMPLE]));
    assert.equal(a.controles.lignesIdentiques, 2);
    assert.equal(a.totalCredit, 200);
    assert.equal(code(a, "lignes_identiques")?.gravite, "non_bloquante");
  });

  test("montant négatif : signe conservé, écriture équilibrée", async () => {
    const a = await analyser(fecDepuisLignes([L("1", "706000", "0,00", "-50,00"), L("1", "411000", "-50,00", "0,00")]));
    assert.equal(a.bloquant, false);
    assert.equal(a.balances.find((b) => b.compte === "706000")?.credit, -50);
  });

  test("compte alphanumérique : conservé tel quel", async () => {
    const a = await analyser(fecDepuisLignes([L("1", "401ABC", "0,00", "1,00"), L("1", "607A", "1,00", "0,00")]));
    assert.deepEqual(a.balances.map((b) => b.compte), ["401ABC", "607A"]);
  });

  test("à-nouveaux : repérés, dans la balance, sans effet sur le P&L", async () => {
    const a = await analyser(fecDepuisLignes(exerciceSynthetique()));
    assert.equal(a.controles.lignesANouveau, 2);
    assert.equal(a.controles.lignesANouveauDeResultat, 0);
    assert.equal(code(a, "a_nouveaux")?.gravite, "information");
    assert.ok(a.balances.some((b) => b.compte === "101000"));
  });

  test("à-nouveau sur un compte de résultat : signalé", async () => {
    const a = await analyser(fecDepuisLignes([L("1", "706000", "0,00", "1,00", "20240101", "AN"), L("1", "411000", "1,00", "0,00", "20240101", "AN")]));
    assert.equal(code(a, "a_nouveau_de_resultat")?.nombre, 1);
  });
});

describe("Écritures de solde vers le compte de résultat", () => {
  const ventes = [L("1", "706000", "0,00", "100,00"), L("1", "411000", "100,00", "0,00"), L("2", "607000", "30,00", "0,00"), L("2", "401000", "0,00", "30,00")];
  const solde = [L("9", "706000", "100,00", "0,00", "20241231"), L("9", "607000", "0,00", "30,00", "20241231"), L("9", "120000", "0,00", "70,00", "20241231")];

  test("écartées et dites : le P&L n'est pas ramené à zéro", async () => {
    const a = await analyser(fecDepuisLignes([...ventes, ...solde]));
    assert.equal(a.controles.ecrituresDeSoldeExclues, 1);
    assert.equal(code(a, "ecritures_de_solde")?.gravite, "information");
    assert.equal(a.controles.resultatReconstitue, 70);
    assert.equal(a.balances.find((b) => b.compte === "706000")?.credit, 100);
    assert.equal(a.bloquant, false);
  });

  test("le résultat reconstitué concorde avec le compte 12 : pas d'alerte", async () => {
    const a = await analyser(fecDepuisLignes([...ventes, ...solde]));
    assert.equal(a.controles.mouvementsCompte12, 70);
    assert.equal(code(a, "resultat_different"), undefined);
  });

  test("résultat différent du compte 12 : alerte", async () => {
    const a = await analyser(fecDepuisLignes([...ventes, L("9", "706000", "80,00", "0,00", "20241231"), L("9", "120000", "0,00", "80,00", "20241231")]));
    assert.equal(code(a, "resultat_different")?.gravite, "non_bloquante");
  });

  test("une écriture normale mêlant 12 et un autre compte reste dans la balance", async () => {
    const a = await analyser(fecDepuisLignes([L("1", "120000", "10,00", "0,00"), L("1", "457000", "0,00", "10,00")]));
    assert.equal(a.controles.ecrituresDeSoldeExclues, 0);
    assert.equal(a.balances.length, 2);
  });

  test("un exercice sans écriture de solde : aucun contrôle sur le 12", async () => {
    const a = await analyser(fecDepuisLignes(ventes));
    assert.equal(a.controles.mouvementsCompte12, null);
  });
});

describe("Exercice", () => {
  test("clôture lue dans le nom du fichier, début dans les écritures", async () => {
    const a = await analyser(fecDepuisLignes(exerciceSynthetique()), "123456789FEC20241231.txt");
    assert.deepEqual(a.exercice, { debut: "2024-01-01", fin: "2024-12-31", sourceFin: "nom_du_fichier" });
    assert.equal(code(a, "exercice_atypique"), undefined);
  });

  test("exercice décalé : jamais supposé en janvier", async () => {
    const a = await analyser(fecDepuisLignes(exerciceSynthetique({ annee: 2023, debut: "2023-07" })), "123456789FEC20240630.txt");
    assert.deepEqual(a.exercice, { debut: "2023-07-01", fin: "2024-06-30", sourceFin: "nom_du_fichier" });
    assert.equal(a.balances[0].mois, "2023-07");
    assert.equal(a.balances[a.balances.length - 1].mois, "2024-06");
  });

  test("nom sans date : dernier jour du dernier mois écrit", async () => {
    const a = await analyser(fecDepuisLignes(SIMPLE), "export.txt");
    assert.equal(a.exercice?.fin, "2024-03-31");
    assert.equal(a.exercice?.sourceFin, "dernieres_ecritures");
  });

  test("écritures après la date du nom : la date du nom n'est pas retenue, et c'est dit", async () => {
    const a = await analyser(fecDepuisLignes(SIMPLE), "123456789FEC20231231.txt");
    assert.equal(a.exercice?.sourceFin, "dernieres_ecritures");
    assert.equal(code(a, "ecritures_apres_cloture")?.gravite, "non_bloquante");
  });

  test("durée atypique ou très longue : à vérifier", async () => {
    assert.equal(code(await analyser(fecDepuisLignes(SIMPLE), "export.txt"), "exercice_atypique")?.gravite, "information");
    const long = [L("1", "706000", "0,00", "1,00", "20200115"), L("1", "411000", "1,00", "0,00", "20200115"), L("2", "706000", "0,00", "1,00", "20230615"), L("2", "411000", "1,00", "0,00", "20230615")];
    assert.equal(code(await analyser(fecDepuisLignes(long), "export.txt"), "periode_longue")?.gravite, "non_bloquante");
  });
});

describe("Du FEC au P&L", () => {
  const pnlDe = (a: AnalyseFec) => calculerPnlComptable({ soldes: soldesDepuisImportFec(preparerImportFec(a, { debut: a.exercice!.debut, fin: a.exercice!.fin, cloture: true }).lignes), regles: [...MODELE_CORRESPONDANCE] });

  test("exercice complet : la cascade du P&L, écritures de clôture sur le dernier mois", async () => {
    const a = await analyser(fecDepuisLignes(exerciceSynthetique()));
    const p = pnlDe(a);
    assert.equal(p.chiffreAffaires, 1_200_000 - 2_000);
    assert.equal(p.coutsDirects, -480_000);
    assert.equal(p.variationStocks, 30_000);
    assert.equal(p.coutsStructure, -240_000 - 60_000);
    assert.equal(p.amortissements, -24_000);
    assert.equal(p.impots, -50_000);
    assert.equal(p.resultatNet, 1_198_000 - 480_000 + 30_000 - 300_000 - 24_000 - 50_000);
    assert.equal(p.controle.equilibre, true);
    assert.equal(a.controles.resultatReconstitue, p.resultatNet);
  });

  test("écriture annuelle : jamais répartie, entière sur son mois", async () => {
    const a = await analyser(fecDepuisLignes(exerciceSynthetique()));
    const dotations = a.balances.filter((b) => b.compte === "681120");
    assert.deepEqual(dotations.map((b) => [b.mois, b.debit]), [["2024-12", 24_000]]);
  });

  test("extourne : compensée sur l'exercice, visible sur chaque mois", async () => {
    const a = await analyser(fecDepuisLignes(exerciceSynthetique()));
    const parMois = (m: string) => a.balances.find((b) => b.compte === "613200" && b.mois === m)!;
    assert.equal(parMois("2024-06").debit, 6_000);
    assert.equal(parMois("2024-07").credit, 1_000);
    assert.equal(pnlDe(a).coutsStructure, -300_000);
  });

  test("avoir : en déduction du chiffre d'affaires", async () => {
    const a = await analyser(fecDepuisLignes(exerciceSynthetique()));
    assert.equal(a.balances.find((b) => b.compte === "706000" && b.mois === "2024-04")!.debit, 2_000);
  });

  test("un compte de bilan n'entre jamais dans le P&L", async () => {
    const p = pnlDe(await analyser(fecDepuisLignes(exerciceSynthetique())));
    assert.equal(p.comptes.find((c) => c.compte === "411000")?.statut, "bilan");
    assert.equal(p.comptes.find((c) => c.compte === "371000")?.statut, "bilan");
  });

  test("somme des mois = cumul annuel, par compte", async () => {
    const a = await analyser(fecDepuisLignes(exerciceSynthetique()));
    const credit706 = a.balances.filter((b) => b.compte === "706000").reduce((t, b) => t + b.credit, 0);
    assert.equal(credit706, 1_200_000);
  });

  test("compte sans mouvement sur un mois : aucune ligne inventée", async () => {
    const a = await analyser(fecDepuisLignes(exerciceSynthetique()));
    assert.equal(a.balances.filter((b) => b.compte === "695000").length, 1);
  });
});

describe("Ce qui part au serveur", () => {
  const exercice = { debut: "2024-01-01", fin: "2024-12-31", cloture: true };

  test("aucune écriture, aucun libellé d'écriture, aucune pièce", async () => {
    const a = await analyser(fecDepuisLignes([{ ...SIMPLE[0], libelle: "Compte client" }, SIMPLE[1]]));
    const p = JSON.stringify(preparerImportFec(a, exercice));
    assert.doesNotMatch(p, /Libelle synthetique|"P1"/);
    assert.match(p, /Compte client/);
  });

  test("import valide accepté", async () => {
    assert.equal(erreurImportFec(preparerImportFec(await analyser(fecDepuisLignes(SIMPLE)), exercice)), null);
  });

  test("le serveur refuse ce que le navigateur ne doit pas envoyer", async () => {
    const ok = preparerImportFec(await analyser(fecDepuisLignes(SIMPLE)), exercice);
    assert.ok(erreurImportFec(null));
    assert.ok(erreurImportFec({ ...ok, lignes: [] }));
    assert.match(erreurImportFec({ ...ok, exercice: { ...exercice, debut: "2024-06-01" } })!, /hors de l'exercice/);
    assert.match(erreurImportFec({ ...ok, lignes: [["2024-03", "706000", 0, 100, 1]] })!, /total des débits/);
    assert.ok(erreurImportFec({ ...ok, lignes: [["2024-13", "706000", 0, 0, 1]] }));
    assert.ok(erreurImportFec({ ...ok, lignes: [["2024-03", "ABC", 0, 0, 1]] }));
    assert.ok(erreurImportFec({ ...ok, lignes: [["2024-03", "706000", "1", 1, 1]] }));
    assert.ok(erreurImportFec({ ...ok, lignes: [["2024-03", "706000", 1, 1, 1], ["2024-03", "706000", 1, 1, 1]] }));
    assert.ok(erreurImportFec({ ...ok, exercice: { debut: "2024-12-01", fin: "2024-01-01", cloture: true } }));
    assert.ok(erreurImportFec({ ...ok, exercice: { debut: "2020-01-01", fin: "2024-01-01", cloture: true } }));
  });

  test("empreinte : même contenu, même empreinte, quels que soient encodage et ordre", async () => {
    const texte = fecDepuisLignes(SIMPLE);
    const a = preparerImportFec(await analyser(texte), exercice);
    const b = preparerImportFec(await analyserOctets(latin1(texte)), exercice);
    const c = preparerImportFec(await analyser(fecDepuisLignes([...SIMPLE].reverse())), exercice);
    assert.equal(contenuCanonique(a), contenuCanonique(b));
    assert.equal(contenuCanonique(a), contenuCanonique(c));
    assert.notEqual(contenuCanonique(a), contenuCanonique({ ...a, lignes: [["2024-03", "411000", 100, 0, 1], ["2024-03", "706000", 0, 101, 1]] }));
  });
});

describe("Volume", () => {
  test("500 000 lignes : lecture par morceaux, totaux au centime, moins de 10 secondes", async () => {
    const entete = new TextEncoder().encode(`${ENTETE_FEC}\n`);
    async function* flux(): AsyncGenerator<Uint8Array> {
      yield entete;
      const encodeur = new TextEncoder();
      for (let lot = 0; lot < 500; lot++) {
        const lignes: string[] = [];
        for (let i = 0; i < 500; i++) {
          const mois = String((lot % 12) + 1).padStart(2, "0");
          const n = `${lot}-${i}`;
          lignes.push(ligneFec({ numero: n, date: `2024${mois}15`, compte: "706000", credit: "0,10" }));
          lignes.push(ligneFec({ numero: n, date: `2024${mois}15`, compte: `411${String(i % 50).padStart(3, "0")}`, debit: "0,10" }));
        }
        yield encodeur.encode(`${lignes.join("\n")}\n`);
      }
    }
    const debut = Date.now();
    const a = await analyserFec(flux, "123456789FEC20241231.txt");
    assert.equal(a.nombreLignes, 500_000);
    assert.equal(a.totalCredit, 25_000);
    assert.equal(a.totalDebit, 25_000);
    assert.equal(a.bloquant, false);
    assert.equal(a.balances.length, 12 * 51);
    assert.ok(Date.now() - debut < 10_000, `trop lent : ${Date.now() - debut} ms`);
  });
});
