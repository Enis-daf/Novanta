import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  aliasFlowKey,
  clesARecalculer,
  FLOW_ENGINE_VERSION,
  LONGUEUR_MAX_ALIAS,
  normaliserNomAlias,
  resoudreAlias,
  buildCanonicalFlowIdentity,
  calculateSimilarity,
  extractStableTokens,
  extractStructuredIdentity,
  groupComparableTransactions,
} from "./flowMatching";

// Les libellés ci-dessous reprennent la STRUCTURE de libellés bancaires réels (préfixes, marqueurs,
// références, troncatures). Les noms de personnes et de petites entreprises sont fictifs ; seuls de
// grands organismes publics ou marques (Urssaf, Klaviyo, Meta, Amazon) sont cités tels quels.

const identite = (label: string) => buildCanonicalFlowIdentity(label).canonicalFlowIdentity;
/** Nombre de groupes et composition, pour un ensemble de libellés d'une même catégorie. */
function groupes(labels: string[]): string[][] {
  const parIdentite = new Map<string, string[]>();
  for (const [label, id] of groupComparableTransactions(labels)) {
    const cle = id.canonicalFlowIdentity ?? `seule:${label}`;
    parIdentite.set(cle, [...(parIdentite.get(cle) ?? []), label]);
  }
  return [...parIdentite.values()];
}
const memeFlux = (...labels: string[]) => assert.equal(groupes(labels).length, 1, labels.join(" | "));
const fluxDistincts = (...labels: string[]) => assert.equal(groupes(labels).length, labels.length, labels.join(" | "));

describe("cas réels remontés — un flux économique, une seule ligne", () => {
  test("Urssaf avec et sans référence", () => {
    memeFlux(
      "Prlv Urssaf De Languedoc Roussil Ref Ur 917000001263030403 Aout26753664127000150926",
      "Prlv Urssaf De Languedoc Roussil"
    );
    assert.equal(buildCanonicalFlowIdentity("Prlv Urssaf De Languedoc Roussil").title, "Urssaf De Languedoc Roussil");
  });

  test("Klaviyo avec et sans numéro de facture, mot tronqué par la banque", () => {
    memeFlux("Klaviyo Inc Software", "Cb Klaviyo Inc So Fact 080926");
    assert.equal(buildCanonicalFlowIdentity("Cb Klaviyo Inc So Fact 080926").title, "Klaviyo Inc");
  });

  test("virement à une personne, avec et sans référence de facture", () => {
    memeFlux("Vir Sepa Durand Camille", "Vir Sepa Durand Camille Ref Facture N 6");
    assert.equal(buildCanonicalFlowIdentity("Vir Sepa Durand Camille Ref Facture N 6").title, "Durand Camille");
  });

  test("prélèvements Meta et Bigblue : même émetteur et même mandat", () => {
    const meta = (ech: string, ref: string) =>
      `PRLV SEPA META PLATFORMS IRELAND ECH/${ech} ID EMETTEUR/IE63ZZZ307358 MDT/FBEUX7L00D76 REF/${ref} LIB/FACEBOOK ADS ${ref}`;
    memeFlux(meta("260826", "BW6UVZ4AOC"), meta("290926", "BW72V4VLS1"), meta("280926", "BW74UAHZIE"), meta("080926", "BW70UN8DE4"));
    assert.deepEqual(
      [buildCanonicalFlowIdentity(meta("260826", "BW6UVZ4AOC")).matchMethod, buildCanonicalFlowIdentity(meta("260826", "BW6UVZ4AOC")).title],
      ["sepa_emitter_mandate", "Facebook Ads"]
    );
    memeFlux(
      "PRLV SEPA BIGBLUE ECH/050826 ID EMETTEUR/FR12ZZZ123456 MDT/BB-2024-001 REF/INV20260805 LIB/BIGBLUE INV20260805",
      "PRLV SEPA BIGBLUE ECH/050926 ID EMETTEUR/FR12ZZZ123456 MDT/BB-2024-001 REF/INV20260905 LIB/BIGBLUE INV20260905"
    );
  });

  test("cas à ne pas réunir", () => {
    fluxDistincts("Amazon Business", "Amazon Marketplace");
    fluxDistincts("ABC 1234", "ABC 5678");
  });
});

describe("formats observés sur l'échantillon réel", () => {
  test("virement émis « vers <fournisseur> » : formes juridiques, casse et suite libre ignorées", () => {
    memeFlux(
      "VIREMENT EMIS VIR INST vers ACME SECURITY SAS acompte sur Commande PO2604-0015 du 23 avril 2026 CLIENTX",
      "VIREMENT EMIS VIR INST vers ACME SECURITY Solde facture FR-SI-261826",
      "VIREMENT EMIS VIR INST vers ACME SECURITY SAS notre commande PO2601-0006 Lamberville",
      "VIREMENT EMIS VIR INST AG vers ACME SECURITY SA ACME security SAS solde facture FR-SI-261210 FR-SI-261210 SAS ClientX",
      "VIREMENT EMIS WEB ACME SECURITY facture FR-SI- facture FR-SI-262192",
      "VIREMENT EMIS VIR INST vers ACME SECURITY SAS Reference commande : FR-SO-260135 CLIENTX",
      "VIREMENT EMIS VIR INST vers ACME SECURITY facture proforma FR-SO-262361 commande CLIENTX PO2608-0031"
    );
  });

  test("fournisseur à un seul mot, répété, avec facture tronquée ou remboursement", () => {
    memeFlux(
      "VIREMENT EMIS AG NOVATECH FA445630 FA445630",
      "VIREMENT EMIS VIR INST AG vers NOVATECH Novatech Factu FA436222 FA436222 SAS ClientX",
      "VIREMENT EMIS VIR INST vers NOVATECH ACOMPTE partiel sur devis OD2601-16499 LA HOTTE CLIENTX",
      "VIREMENT EMIS WEB NOVATECH Facture FA442546 Facture FA442546",
      "VIREMENT EN VOTRE FAVEUR NOVATECH VH61522R675DM301 NOVATECH REMBOURSEMENT VRT 27/5/26 VH61522R675DM301"
    );
  });

  test("forme juridique devant le nom, et nom contenant un chiffre", () => {
    memeFlux("VIREMENT EMIS VIR INST vers EURL W3SHOP commande NJWYRVTBQ CLIENTX", "VIREMENT EMIS VIR INST vers EURL W3SHOP facture FA15023338");
    assert.equal(identite("VIREMENT EMIS VIR INST vers EURL W3SHOP facture FA15023338"), "tiers:w3shop");
  });

  test("libellé coupé par un retour à la ligne « Reason: … »", () => {
    memeFlux("SEPA CARTONEX SL", "VIR SEPA CARTONEX SL", "VIR SEPA CARTONEX SL\n- Reason: paiement 1/2 facture A 25 582");
  });

  test("nom suivi d'une référence, puis répété", () => {
    memeFlux("EMBALPACK FS102026 00660 EMBALPACK CLIENT Y PP194002493440", "EMBALPACK FS102026 00660 EMBALPACK CLIENT Y PP210312413184");
  });

  test("habillage bancaire placé après le nom", () => {
    memeFlux("ASSURCOURTAGE0 Prelevement n:10058", "ASSURCOURTAGE0 Prelevement n:11196", "ASSURCOURTAGE0 Prelevement n:7131");
    assert.equal(identite("ASSURCOURTAGE0 Prelevement n:10058"), "tiers:assurcourtage0");
  });

  test("références commerçant collées par une étoile", () => {
    memeFlux("Amazon.fr*678EA75G5", "Amazon.fr*ZC3HC3404");
    memeFlux("AMZN Mktp FR*E495T31C5", "AMZN Mktp FR*NR3472AB4");
    fluxDistincts("Amazon.fr*678EA75G5", "AMZN Mktp FR*E495T31C5");
  });

  test("paiement par carte et virement vers le même fournisseur", () => {
    memeFlux("PAIEMENT PAR CARTE X3026 EUROSHOP ST GERMAIN 27/05", "VIREMENT EMIS VIR INST vers SARL EUROSHOP commande 000066266");
    memeFlux("PAIEMENT PAR CARTE X3026 PAYPAL *DODOTECH L 02/02", "VIREMENT EMIS VIR INST vers Dodotech di Ivan invoice 2026154 order 3256");
  });

  test("virement émis sans aucune contrepartie lisible : jamais rapproché d'un autre", () => {
    fluxDistincts(
      "VIR SEPA EMIS /PID - /IID - /SDT 260310 /EID F2210-07549 /RNF",
      "VIR SEPA EMIS /PID - /IID - /SDT 260413 /EID 2026030006956 /RNF",
      "VIR SEPA EMIS /PID F2210-07917 /IID F2210-07917 /SDT 260902 /EID F2210-07917 /RNF F2210-07917 RETD"
    );
    assert.equal(buildCanonicalFlowIdentity("VIR SEPA EMIS /PID - /IID - /SDT 260310 /EID F2210-07549 /RNF").matchMethod, "exact_normalized");
  });
});

describe("partie stable d'un libellé", () => {
  test("préfixes bancaires retirés, coupe au premier marqueur, à la première référence ou date", () => {
    assert.deepEqual(extractStableTokens("Vir Sepa Durand Camille Ref Facture N 6").forts, ["durand", "camille"]);
    assert.deepEqual(extractStableTokens("PAIEMENT CB X1234 CARREFOUR MARKET LYON 12/09").forts, ["carrefour", "market", "lyon"]);
    assert.deepEqual(extractStableTokens("PRLV SEPA EDF 000123456").forts, ["edf"]);
    assert.deepEqual(extractStableTokens("Loyer septembre 2026").forts, ["loyer"]);
  });

  test("mots faibles lisibles dans le titre, sans poids dans l'identité", () => {
    assert.deepEqual(extractStableTokens("Klaviyo Inc Software"), { noyau: ["klaviyo", "inc"], forts: ["klaviyo"] });
    assert.deepEqual(extractStableTokens("Société Générale SA").forts, ["societe", "generale"]);
    assert.equal(identite("Dupont Services"), identite("Dupont Service"));
  });

  test("au plus trois mots forts : deux personnes au prénom composé restent distinctes", () => {
    fluxDistincts("VIR SEPA JEAN PIERRE MARTIN", "VIR SEPA JEAN PIERRE DURAND");
    assert.deepEqual(extractStableTokens("Guangzhou Colorful Bag Co., Ltd CWY202509093 final balance").forts, ["guangzhou", "colorful", "bag"]);
  });

  test("contrepartie trop faible : retour au texte exact", () => {
    assert.equal(buildCanonicalFlowIdentity("ABC 1234").matchMethod, "exact_normalized");
    assert.equal(identite("ABC 1234"), "texte:abc 1234");
    assert.equal(identite("TVA"), "texte:tva");
    assert.equal(identite("Septembre 2026"), null);
    assert.equal(identite("   "), null);
  });
});

describe("identité structurée", () => {
  test("émetteur et mandat, quel que soit le séparateur", () => {
    assert.deepEqual(extractStructuredIdentity("PRLV SEPA X ECH/010926 ID EMETTEUR/FR12ZZZ123456 MDT/BB-2024-001 REF/A1"), { idEmetteur: "FR12ZZZ123456", mandat: "BB-2024-001" });
    assert.deepEqual(extractStructuredIdentity("prlv x id emetteur : fr12zzz123456 mdt: bb-1"), { idEmetteur: "FR12ZZZ123456", mandat: "BB-1" });
    assert.equal(extractStructuredIdentity("Prlv Urssaf De Languedoc Roussil"), null);
  });

  test("mandat ou émetteur différent : flux différents, même si le nom est identique", () => {
    const p = (emetteur: string, mandat: string) => `PRLV SEPA ORANGE ID EMETTEUR/${emetteur} MDT/${mandat} LIB/ORANGE`;
    fluxDistincts(p("FR1", "M1"), p("FR1", "M2"));
    fluxDistincts(p("FR1", "M1"), p("FR2", "M1"));
  });
});

describe("rapprochement prudent entre contreparties voisines", () => {
  test("score explicable, sans distance d'édition", () => {
    assert.equal(calculateSimilarity(["klaviyo"], ["klaviyo"]), 1);
    assert.equal(calculateSimilarity(["europcam"], ["europcam", "germain"]), 0.7);
    assert.equal(calculateSimilarity(["acme", "secur"], ["acme", "security"]), 0.7);
    assert.equal(calculateSimilarity(["amazon", "business"], ["amazon", "marketplace"]), 0);
    // Des mots qui se ressemblent sans être préfixe l'un de l'autre ne comptent pas.
    assert.equal(calculateSimilarity(["martin"], ["marton"]), 0);
    assert.equal(calculateSimilarity(["dupont", "lyon"], ["dupond", "lyon"]), 0);
  });

  test("un mot tronqué n'est reconnu qu'en dernière position, à partir de 3 lettres, jamais tout seul", () => {
    assert.equal(calculateSimilarity(["acme", "se"], ["acme", "security"]), 0);
    assert.equal(calculateSimilarity(["sec"], ["security"]), 0);
    assert.equal(calculateSimilarity(["acm", "security"], ["acme", "security"]), 0);
  });

  test("une contrepartie avec deux voisines possibles n'est rapprochée d'aucune", () => {
    fluxDistincts("Amazon", "Amazon Business", "Amazon Marketplace");
    // Avec une seule voisine, le rapprochement est sans ambiguïté.
    assert.equal(groupes(["Orange", "Orange Business"]).length, 1);
  });

  test("pas de chaînage : A~B et B~C ne réunit personne", () => {
    const resultat = groupes(["Leroy", "Leroy Merlin", "Leroy Merlin Lyon"]);
    assert.equal(resultat.length, 3);
  });

  test("le résultat ne dépend pas de l'ordre des libellés", () => {
    const labels = ["PAIEMENT PAR CARTE X3026 EUROSHOP ST GERMAIN 27/05", "VIREMENT EMIS VIR INST vers SARL EUROSHOP commande 1", "Amazon Business", "Amazon Marketplace", "Klaviyo Inc Software", "Cb Klaviyo Inc So Fact 080926"];
    const cles = (liste: string[]) => new Map([...groupComparableTransactions(liste)].map(([label, id]) => [label, id.canonicalFlowIdentity]));
    const direct = cles(labels);
    const inverse = cles([...labels].reverse());
    for (const label of labels) assert.equal(direct.get(label), inverse.get(label), label);
  });

  test("chaque rapprochement est explicable : libellé, forme normalisée, identité, méthode, score", () => {
    const [carte] = [...groupComparableTransactions(["PAIEMENT PAR CARTE X3026 EUROSHOP ST GERMAIN 27/05", "VIREMENT EMIS VIR INST vers SARL EUROSHOP commande 1"]).values()];
    assert.deepEqual(
      { ...carte, tokens: undefined },
      {
        rawLabel: "PAIEMENT PAR CARTE X3026 EUROSHOP ST GERMAIN 27/05",
        normalizedLabel: "paiement par carte x3026 euroshop st germain 27 05",
        canonicalFlowIdentity: "tiers:euroshop",
        matchMethod: "token_similarity",
        confidenceScore: 0.7,
        title: "Euroshop",
        tokens: undefined,
      }
    );
  });
});

// Les alias de l'organisation sont enregistrés sous ces identités. Ce test les fige : s'il échoue,
// c'est qu'une évolution du moteur a changé une identité — les alias existants ne seraient plus
// retrouvés. Il faut alors incrémenter FLOW_ENGINE_VERSION et recalculer les alias enregistrés à
// partir de leur libellé d'exemple (colonne sample_label), pas seulement corriger ce test.
describe("contrat des identités (clés des alias de flux)", () => {
  test("version du moteur", () => assert.equal(FLOW_ENGINE_VERSION, "3"));

  const attendues: [string, string | null][] = [
    ["PRELEVEMENT CREANCE 021618 RECLAMEE", "tiers:creance"],
    ["PRLV CREANCE 030426", "tiers:creance"],
    ["CREANCE RECLAMEE 987654", "tiers:creance reclamee"],
    ["PRLV SEPA FACEBOOK ID EMETTEUR/FR12ZZZ123456 MDT/ABC123 LIB/FACEBOOK ADS 0425", "sepa:FR12ZZZ123456:ABC123"],
    ["VIREMENT EMIS VIR INST vers SARL EUROPCAM commande 000066266", "tiers:europcam"],
    ["ABC 1234", "texte:abc 1234"],
    ["", null],
    // Version 2 : bénéficiaire désigné comme une personne, motif écrit après le bénéficiaire.
    ["Virement Emis Vir Inst Vers M Ou Mme Durand Do Salaire", "tiers:m ou mme durand"],
    ["Virement Emis Web M Ou Mme Durand Domi Salaire Salaire", "tiers:m ou mme durand"],
    ["VIR SEPA CABINET MARTEL SALAIRE MARS", "tiers:cabinet martel"],
    // Version 3 : marqueur de paiement avant la contrepartie d'un prélèvement.
    ["PRELEVEMENT FACTURE LABORATOIRE ALTEA FACTURE N 123456", "tiers:laboratoire altea"],
  ];
  for (const [libelle, cle] of attendues) {
    test(`« ${libelle} » -> ${cle}`, () => assert.equal(aliasFlowKey(libelle), cle));
  }
});

describe("alias de flux — nom saisi et résolution", () => {
  test("nom nettoyé ; vide ou trop long refusé", () => {
    assert.equal(normaliserNomAlias("  Remboursement   Dailly "), "Remboursement Dailly");
    assert.equal(normaliserNomAlias("   "), null);
    assert.equal(normaliserNomAlias("x".repeat(LONGUEUR_MAX_ALIAS)), "x".repeat(LONGUEUR_MAX_ALIAS));
    assert.equal(normaliserNomAlias("x".repeat(LONGUEUR_MAX_ALIAS + 1)), null);
  });

  test("sans alias -> null ; l'identité du groupe est prioritaire sur ses voisines", () => {
    const alias = new Map([
      ["tiers:europcam", "Europcam (caméras)"],
      ["tiers:europcam germain", "Boutique Saint-Germain"],
    ]);
    assert.equal(resoudreAlias(["tiers:creance"], "tiers:creance", alias), null);
    assert.equal(resoudreAlias(["tiers:europcam germain", "tiers:europcam"], "tiers:europcam", alias), "Europcam (caméras)");
    // Le groupe ne contient que la voisine (l'autre est absente de cette comparaison) : son alias joue.
    assert.equal(resoudreAlias(["tiers:europcam germain"], "tiers:europcam germain", alias), "Boutique Saint-Germain");
  });
});

// Noms fictifs, structure de libellés réels : « Virement Emis [canal] [bénéficiaire] [DO | DOMI] [motif] ».
describe("virements émis — le bénéficiaire prime sur le canal et le motif", () => {
  const INSTANTANE = "Virement Emis Vir Inst Vers M Ou Mme Durand Do Salaire";
  const WEB = "Virement Emis Web M Ou Mme Durand Domi Salaire Salaire";
  const cle = (libelle: string) => buildCanonicalFlowIdentity(libelle).canonicalFlowIdentity;

  test("même bénéficiaire par deux canaux, DO / DOMI avant le motif : une seule identité", () => {
    const a = buildCanonicalFlowIdentity(INSTANTANE);
    const b = buildCanonicalFlowIdentity(WEB);
    assert.equal(a.canonicalFlowIdentity, "tiers:m ou mme durand");
    assert.equal(b.canonicalFlowIdentity, a.canonicalFlowIdentity);
    assert.equal(a.title, "M Ou Mme Durand");
    assert.equal(b.title, "M Ou Mme Durand");
    assert.equal(a.matchMethod, "structured_counterparty");
    const groupes = groupComparableTransactions([INSTANTANE, WEB]);
    assert.equal(new Set([...groupes.values()].map((i) => i.canonicalFlowIdentity)).size, 1);
  });

  test("ni le canal, ni le mode de virement, ni le motif n'entrent dans l'identité", () => {
    for (const libelle of [
      "VIREMENT EMIS M OU MME DURAND",
      "VIREMENT EMIS VIR INST AG VERS M OU MME DURAND FACTURE 2026-104",
      "VIREMENT EMIS WEB M OU MME DURAND DOMICILIATION",
      "VIREMENT EMIS WEB M OU MME DURAND DO LOYER OCTOBRE",
      "VIR SEPA EMIS VERS M OU MME DURAND DOMI NOTE DE FRAIS",
      "VIREMENT EMIS WEB M OU MME DURAND DOMI REMBOURSEMENT AVANCE",
      "VIREMENT EMIS WEB M OU MME DURAND PRIME ANNUELLE",
    ]) {
      assert.equal(cle(libelle), "tiers:m ou mme durand", libelle);
    }
  });

  test("l'identité porte le bénéficiaire complet : deux homonymes restent deux flux", () => {
    assert.equal(cle("VIREMENT EMIS WEB M DURAND PAUL SALAIRE"), "tiers:m durand paul");
    assert.equal(cle("VIREMENT EMIS WEB M DURAND LUC SALAIRE"), "tiers:m durand luc");
    assert.equal(cle("VIR SEPA EMIS VERS M OU MME DURAND DOMINIQUE SALAIRE OCTOBRE"), "tiers:m ou mme durand dominique");
  });

  test("la civilité fait partie de l'identité ; un autre bénéficiaire est un autre flux", () => {
    assert.deepEqual(
      ["VIREMENT EMIS WEB M OU MME DURAND SALAIRE", "VIREMENT EMIS WEB M OU MME MOREL SALAIRE", "VIREMENT EMIS WEB MME DURAND SALAIRE", "VIREMENT EMIS WEB M DURAND SALAIRE"].map(cle),
      ["tiers:m ou mme durand", "tiers:m ou mme morel", "tiers:mme durand", "tiers:m durand"]
    );
  });

  test("DO / DOMI vaut aussi pour un bénéficiaire qui n'est pas une personne", () => {
    assert.equal(cle("VIREMENT EMIS VIR INST VERS SARL ATELIER MOREL DO FACTURE 2026-14"), "tiers:atelier morel");
  });

  test("DO / DOMI n'est jamais une sous-chaîne : « Dominique » reste un mot du bénéficiaire", () => {
    assert.equal(cle("VIREMENT EMIS WEB DOMINIQUE MARTIN SALAIRE"), "tiers:dominique martin");
  });

  test("DO / DOMI ne coupe pas s'il n'est pas suivi d'un motif", () => {
    assert.equal(cle("VIREMENT EMIS WEB M OU MME DURAND DOMI"), "tiers:m ou mme durand domi");
    assert.equal(buildCanonicalFlowIdentity("VIREMENT EMIS WEB M OU MME DURAND DO BRASIL").title, "M Ou Mme Durand Do Brasil");
  });

  test("DO / DOMI ne coupe pas sans bénéficiaire avant lui", () => {
    assert.equal(buildCanonicalFlowIdentity("VIREMENT EMIS WEB DOMI SALAIRE").matchMethod, "exact_normalized");
  });

  test("DO / DOMI ne coupe pas hors d'un virement émis", () => {
    assert.equal(cle("PRLV SEPA GARAGE DURAND DOMI SALAIRE"), "tiers:garage durand domi");
    assert.notEqual(cle("VIREMENT RECU GARAGE DURAND DOMI LOYER"), "tiers:garage durand");
  });

  test("nom à particule", () => {
    const identite = buildCanonicalFlowIdentity("VIREMENT EMIS WEB MME LE GALL ANNE LOYER");
    assert.equal(identite.canonicalFlowIdentity, "tiers:mme gall anne");
    assert.equal(identite.title, "Mme Le Gall Anne");
  });

  test("une lettre isolée qui n'ouvre pas un nom n'est pas une civilité", () => {
    assert.equal(buildCanonicalFlowIdentity("PRLV SEPA M 6 BOUTIQUE 1234").matchMethod, "exact_normalized");
  });

  test("motif de salaire après un bénéficiaire, hors virement émis : coupé ; en tête de contrepartie : conservé", () => {
    assert.equal(cle("VIR SEPA CABINET MARTEL SALAIRE MARS"), "tiers:cabinet martel");
    assert.equal(cle("SALAIRE DUPONT"), "tiers:salaire dupont");
  });
});

// Structure : « Prelevement [marqueur] <contrepartie> Facture N <référence> ». Noms fictifs.
describe("prélèvements — la contrepartie prime sur le numéro de facture ou la référence", () => {
  const cle = (libelle: string) => buildCanonicalFlowIdentity(libelle).canonicalFlowIdentity;

  test("même contrepartie, numéro de facture différent : même flux", () => {
    const a = buildCanonicalFlowIdentity("PRELEVEMENT FACTURE LABORATOIRE ALTEA FACTURE N 123456");
    assert.equal(a.canonicalFlowIdentity, "tiers:laboratoire altea");
    assert.equal(a.title, "Laboratoire Altea");
    assert.equal(cle("PRELEVEMENT FACTURE LABORATOIRE ALTEA FACTURE N 789012"), a.canonicalFlowIdentity);
    const groupes = groupComparableTransactions(["PRELEVEMENT FACTURE LABORATOIRE ALTEA FACTURE N 123456", "PRELEVEMENT FACTURE LABORATOIRE ALTEA FACTURE N 789012"]);
    assert.equal(new Set([...groupes.values()].map((i) => i.canonicalFlowIdentity)).size, 1);
  });

  test("même contrepartie, référence différente, quel que soit le marqueur", () => {
    for (const libelle of [
      "PRELEVEMENT FACTURE LABORATOIRE ALTEA FACTURE FA-2026-0091",
      "PRELEVEMENT FACT LABORATOIRE ALTEA FACT 55120",
      "PRLV FACTURE LABORATOIRE ALTEA REF AB12CD34",
      "PRELEVEMENT LABORATOIRE ALTEA REFERENCE 2026/10/441",
      "PRELEVEMENT FACTURE LABORATOIRE ALTEA NUMERO 9001",
      "PRELEVEMENT FACTURE SAS LABORATOIRE ALTEA N 77",
    ]) {
      assert.equal(cle(libelle), "tiers:laboratoire altea", libelle);
    }
  });

  test("contrepartie différente, même format : flux différents", () => {
    assert.notEqual(cle("PRELEVEMENT FACTURE LABORATOIRE ALTEA FACTURE N 123456"), cle("PRELEVEMENT FACTURE LABORATOIRE BOREAL FACTURE N 123456"));
  });

  test("le marqueur en tête n'est retiré que pour un prélèvement, et seulement avant la contrepartie", () => {
    // Hors prélèvement : « Facture … » en tête reste un marqueur, comme avant.
    assert.equal(buildCanonicalFlowIdentity("VIREMENT RECU FACTURE LABORATOIRE ALTEA FACTURE N 123456").matchMethod, "exact_normalized");
    // Sans contrepartie derrière le marqueur : aucune identité de tiers n'est inventée.
    assert.equal(buildCanonicalFlowIdentity("PRELEVEMENT FACTURE N 123456").matchMethod, "exact_normalized");
  });

  test("un nombre hors zone transactionnelle n'est pas effacé : sans contrepartie stable, il reste dans l'identité", () => {
    assert.equal(cle("PRELEVEMENT LOT 4410"), "texte:prelevement lot 4410");
    assert.notEqual(cle("PRELEVEMENT LOT 4410"), cle("PRELEVEMENT LOT 4411"));
  });
});

describe("clesARecalculer — alias et groupes enregistrés sous une version antérieure du moteur", () => {
  const WEB = "Virement Emis Web M Ou Mme Durand Domi Salaire Salaire";

  test("identité changée par la nouvelle version : la clé est à déplacer", () => {
    const { deplacees, confirmees } = clesARecalculer([{ cle: "texte:virement emis web m ou mme durand domi salaire salaire", exemple: WEB, version: "1" }]);
    assert.deepEqual(clesARecalculer([{ cle: "texte:prelevement facture laboratoire altea facture n", exemple: "PRELEVEMENT FACTURE LABORATOIRE ALTEA FACTURE N 123456", version: "2" }]).deplacees, [
      { ancienne: "texte:prelevement facture laboratoire altea facture n", nouvelle: "tiers:laboratoire altea" },
    ]);
    assert.deepEqual(deplacees, [{ ancienne: "texte:virement emis web m ou mme durand domi salaire salaire", nouvelle: "tiers:m ou mme durand" }]);
    assert.deepEqual(confirmees, []);
  });

  test("identité inchangée : seule la version est à mettre à jour", () => {
    assert.deepEqual(clesARecalculer([{ cle: "tiers:creance", exemple: "PRLV CREANCE 030426", version: "1" }]), { deplacees: [], confirmees: ["tiers:creance"] });
  });

  test("déjà à la version courante, sans libellé d'exemple, ou exemple sans identité : rien", () => {
    const rien = { deplacees: [], confirmees: [] };
    assert.deepEqual(clesARecalculer([{ cle: "tiers:x", exemple: WEB, version: FLOW_ENGINE_VERSION }]), rien);
    assert.deepEqual(clesARecalculer([{ cle: "tiers:x", exemple: null, version: "1" }]), rien);
    assert.deepEqual(clesARecalculer([{ cle: "tiers:x", exemple: "", version: null }]), rien);
  });
});
