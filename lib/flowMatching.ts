import { MOIS, normalizeTransactionLabel } from "./transactionLabel";

/**
 * Regroupement des transactions en FLUX ÉCONOMIQUES pour l'analyse d'écarts — EXPÉRIMENTAL.
 *
 * La question posée à chaque libellé n'est pas « quel est son texte ? » mais « qui est derrière ? ».
 * Tout le moteur est ici, nulle part ailleurs ; il est déterministe, sans IA, sans référentiel de
 * tiers, et chaque rapprochement s'explique (méthode + score).
 *
 * Ordre de confiance :
 *   1. identifiants structurés (prélèvement SEPA : émetteur + mandat) ;
 *   2. contrepartie stable extraite du libellé (préfixes bancaires retirés, coupe au premier
 *      marqueur ou à la première référence) ;
 *   3. texte normalisé exact (lib/transactionLabel.ts), quand la contrepartie est trop faible ;
 *   4. rapprochement prudent de deux contreparties dont l'une prolonge l'autre.
 *
 * Garde-fous : jamais entre deux catégories ; jamais de chaînage (A~B et B~C ne réunit pas A et
 * C) ; jamais de distance d'édition ; en cas de doute, les lignes restent séparées.
 */

export type MatchMethod = "sepa_emitter_mandate" | "structured_counterparty" | "exact_normalized" | "token_similarity";

const CONFIANCE: Record<MatchMethod, number> = {
  sepa_emitter_mandate: 1,
  structured_counterparty: 0.9,
  exact_normalized: 0.8,
  token_similarity: 0.7,
};

// --- 1. Identité structurée ---

export interface PrelevementSepa {
  idEmetteur: string; // identifiant créancier SEPA (ICS)
  mandat: string | null; // référence unique de mandat (MDT / RUM)
}

const champ = (nom: string) => new RegExp(`\\b${nom}\\s*[/:]\\s*(\\S+)`, "i");

/** Émetteur et mandat d'un prélèvement SEPA balisé (« ID EMETTEUR/… MDT/… »), sinon null. */
export function extractStructuredIdentity(label: string): PrelevementSepa | null {
  const idEmetteur = label.match(champ("ID\\s*EMETTEUR"))?.[1];
  if (!idEmetteur) return null;
  return { idEmetteur: idEmetteur.toUpperCase(), mandat: label.match(champ("MDT"))?.[1]?.toUpperCase() ?? null };
}

// --- 2. Contrepartie stable ---

/** Minuscules, accents retirés, ponctuation remplacée par des espaces. */
export function normalizeLabel(label: string): string {
  return label
    .toLocaleLowerCase("fr")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Mots d'habillage bancaire en tête de libellé : ils disent COMMENT l'argent a circulé, pas avec qui.
const PREFIXES_BANCAIRES = new Set([
  "virement", "vir", "virt", "sepa", "emis", "recu", "inst", "instantane", "web", "ag", "prlv", "prelevement",
  "prelevt", "cb", "carte", "paiement", "par", "en", "votre", "faveur", "vers", "paypal",
]);
// Formes juridiques placées AVANT le nom (« SARL Europcam ») : pas la contrepartie elle-même.
const FORMES_JURIDIQUES = new Set(["sarl", "eurl", "sas", "sasu", "sa", "sci", "selarl", "scp", "earl"]);
// À partir de ces mots, la suite décrit LA transaction (sa facture, sa commande...), plus le flux.
const MARQUEURS = [
  "ref", "reference", "fact", "facture", "fac", "invoice", "inv", "no", "num", "numero", "reason", "motif", "ech", "eid",
  "iid", "pid", "rnf", "sdt", "id", "emetteur", "mdt", "mandat", "commande", "cde", "order", "ordre", "devis", "acompte",
  "solde", "reglement", "remboursement", "avoir", "proforma", "notre", "votre", "sur", "pour", "suite", "selon",
  // Habillage bancaire placé APRÈS le nom (« Assurmax Prelevement n:10058 »).
  "prelevement", "paiement", "virement",
];
const MARQUEURS_SET = new Set(MARQUEURS);
// Mots peu discriminants : ils restent lisibles dans le titre mais ne pèsent rien dans l'identité.
const MOTS_FAIBLES = new Set([
  "software", "service", "services", "payment", "payments", "sa", "sas", "sarl", "eurl", "ltd", "limited", "inc",
  "company", "co", "sl", "gmbh", "bv", "fr", "com", "the", "de", "du", "des", "le", "la", "les", "et", "di", "of",
]);

const MOTS_DE_LIAISON = new Set(["de", "du", "des", "le", "la", "les", "et", "di", "of", "the", "fr", "com"]);

// Bénéficiaire désigné comme une PERSONNE (« M ou Mme Durand ») : la civilité ouvre la contrepartie
// et fait partie de son identité.
const CIVILITES = new Set(["m", "mr", "mme", "mlle", "mrs", "monsieur", "madame", "mademoiselle"]);
const LIAISONS_DE_CIVILITE = new Set(["ou", "et"]);
// Motifs écrits APRÈS le bénéficiaire (« … Durand Salaire ») : ils décrivent l'opération, pas le
// flux. En tête de contrepartie, ils restent des mots comme les autres.
const MOTIFS_APRES_BENEFICIAIRE = new Set(["salaire", "salaires", "paie", "domiciliation"]);
// Virement émis : le libellé suit « habillage bancaire -> bénéficiaire -> [DO | DOMI] -> motif ».
// Une fois le bénéficiaire trouvé, ces mots ouvrent le motif du paiement.
const MOTIFS_DE_VIREMENT_EMIS = new Set([
  ...MOTIFS_APRES_BENEFICIAIRE,
  "loyer", "loyers", "indemnite", "indemnites", "honoraires", "prime", "primes", "note", "frais",
]);
// « DO », « DOMI » : dans un virement émis, marque la fin de la zone bénéficiaire — seulement comme
// mot entier (jamais le début de « Dominique »), après un bénéficiaire, et suivi d'un motif.
const FINS_DE_BENEFICIAIRE = new Set(["do", "domi"]);

const MAX_JETONS_FORTS = 3;
const LONGUEUR_MIN_JETON_FORT = 3;
// Une contrepartie réduite à un seul mot n'identifie un flux que si ce mot est assez long.
const LONGUEUR_MIN_JETON_SEUL = 5;
// Un mot tronqué par la banque n'est reconnu comme préfixe d'un autre qu'à partir de cette longueur.
const LONGUEUR_MIN_PREFIXE = 3;

const estReference = (jeton: string) => (jeton.match(/\d/g)?.length ?? 0) >= 2;
// « factu » pour « facture », « comman » pour « commande » : marqueur tronqué par la banque.
const estMarqueur = (jeton: string) =>
  jeton.length === 1 || MARQUEURS_SET.has(jeton) || (jeton.length >= 4 && MARQUEURS.some((m) => m.length > jeton.length && m.startsWith(jeton)));
const estFort = (jeton: string) => jeton.length >= LONGUEUR_MIN_JETON_FORT && !MOTS_FAIBLES.has(jeton);

export interface StableTokens {
  // Mots de la contrepartie, dans l'ordre, sans doublon : de la fin de l'habillage bancaire au
  // premier marqueur, à la première référence ou à la première date.
  noyau: string[];
  // Ceux qui identifient réellement le flux (MAX_JETONS_FORTS au plus).
  forts: string[];
}

/** Partie stable d'un libellé : la contrepartie, débarrassée de ce qui varie d'une opération à l'autre. */
export function extractStableTokens(label: string): StableTokens {
  // Un retour à la ligne (« … \n- Reason: … ») ouvre toujours un commentaire propre à l'opération.
  const jetons = normalizeLabel(label.split(/\r?\n/)[0]).split(" ").filter(Boolean);
  let debut = 0;
  while (debut < jetons.length && (PREFIXES_BANCAIRES.has(jetons[debut]) || /^x\d{3,4}$/.test(jetons[debut]))) debut++;
  while (debut < jetons.length && FORMES_JURIDIQUES.has(jetons[debut])) debut++;

  // Virement émis : « virement / vir » et « emis » dans l'habillage bancaire retiré.
  const habillage = jetons.slice(0, debut);
  const virementEmis = habillage.includes("emis") && habillage.some((jeton) => jeton === "virement" || jeton === "vir" || jeton === "virt");
  const ouvreUnMotif = (jeton: string | undefined) =>
    jeton !== undefined && (estMarqueur(jeton) || (virementEmis ? MOTIFS_DE_VIREMENT_EMIS : MOTIFS_APRES_BENEFICIAIRE).has(jeton));

  // Personne : une civilité (« M », « Mme », « M ou Mme »…) suivie d'un nom ouvre la contrepartie.
  // Elle entre dans l'identité (« M Durand » n'est pas « Mme Durand »), puis le bénéficiaire se lit
  // comme n'importe quelle contrepartie, jusqu'au motif. Une lettre isolée qui n'introduit pas un
  // nom (« M 6 ») n'est pas une civilité.
  let civilite: string[] = [];
  if (CIVILITES.has(jetons[debut])) {
    let fin = debut + 1;
    while (LIAISONS_DE_CIVILITE.has(jetons[fin]) && CIVILITES.has(jetons[fin + 1])) fin += 2;
    let rangNom = fin;
    while (rangNom < jetons.length && MOTS_DE_LIAISON.has(jetons[rangNom])) rangNom++; // « Le Gall », « De La Tour »
    const nom = jetons[rangNom];
    if (nom !== undefined && estFort(nom) && !estReference(nom) && !MOIS.has(nom) && !ouvreUnMotif(nom) && !FINS_DE_BENEFICIAIRE.has(nom)) {
      civilite = jetons.slice(debut, fin);
      debut = fin;
    }
  }

  const noyau: string[] = [];
  const forts: string[] = [];
  const reste = jetons.slice(debut);
  for (const [rang, jeton] of reste.entries()) {
    if (estReference(jeton) || estMarqueur(jeton) || MOIS.has(jeton)) break;
    // Après le bénéficiaire : le motif, ou le marqueur DO / DOMI qui l'introduit.
    if (forts.length > 0 && ouvreUnMotif(jeton)) break;
    if (virementEmis && forts.length > 0 && FINS_DE_BENEFICIAIRE.has(jeton) && ouvreUnMotif(reste[rang + 1])) break;
    if (noyau.includes(jeton)) continue; // « Kubii Kubii », « TKH Security SA TKH Security SAS »
    if (estFort(jeton)) {
      if (forts.length === MAX_JETONS_FORTS) break;
      forts.push(jeton);
    }
    noyau.push(jeton);
  }
  // Le noyau s'arrête au dernier mot fort, suivi au plus d'un mot faible qui complète le nom
  // (« Klaviyo Inc », « Agence RH ») — jamais d'un mot de liaison laissé en suspens.
  const dernierFort = noyau.lastIndexOf(forts[forts.length - 1]);
  const suite = noyau[dernierFort + 1];
  const fin = suite && !MOTS_DE_LIAISON.has(suite) ? dernierFort + 2 : dernierFort + 1;
  if (forts.length === 0) return { noyau: [], forts: [] };
  return { noyau: [...civilite, ...noyau.slice(0, fin)], forts: [...civilite, ...forts] };
}

function enTitre(texte: string): string {
  return texte.replace(/(^|\s)(\p{L})/gu, (_, espace: string, lettre: string) => espace + lettre.toLocaleUpperCase("fr"));
}

export interface FlowIdentity {
  rawLabel: string;
  normalizedLabel: string;
  // Identité du flux À L'INTÉRIEUR d'une catégorie ; null = à ne rapprocher d'aucune autre ligne.
  canonicalFlowIdentity: string | null;
  matchMethod: MatchMethod;
  confidenceScore: number;
  // Titre lisible, tiré de la partie stable — jamais le libellé bancaire complet.
  title: string;
  // Mots forts de la contrepartie (vide hors méthode « contrepartie ») : servent au rapprochement
  // prudent entre deux contreparties voisines.
  tokens: string[];
}

/**
 * Identité d'un libellé pris isolément (étapes 1 à 3). Le rapprochement entre contreparties
 * voisines (étape 4) a besoin de voir les autres libellés : voir groupComparableTransactions.
 */
export function buildCanonicalFlowIdentity(label: string): FlowIdentity {
  const normalizedLabel = normalizeLabel(label);
  const base = { rawLabel: label, normalizedLabel };
  const { noyau, forts } = extractStableTokens(label);
  const titreContrepartie = enTitre(noyau.join(" "));

  const sepa = extractStructuredIdentity(label);
  if (sepa?.mandat) {
    // Titre : la partie stable du champ LIB quand il existe (« Facebook Ads »), sinon le créancier.
    const lib = label.match(/\bLIB\s*[/:]\s*(.*?)(?=\s+(?:ECH|ID\s*EMETTEUR|MDT|REF)\s*[/:]|$)/i)?.[1] ?? "";
    const titreLib = enTitre(extractStableTokens(lib).noyau.join(" "));
    return {
      ...base,
      canonicalFlowIdentity: `sepa:${sepa.idEmetteur}:${sepa.mandat}`,
      matchMethod: "sepa_emitter_mandate",
      confidenceScore: CONFIANCE.sepa_emitter_mandate,
      title: titreLib || titreContrepartie || sepa.idEmetteur,
      tokens: [],
    };
  }

  const assezForte = forts.length >= 2 || (forts.length === 1 && forts[0].length >= LONGUEUR_MIN_JETON_SEUL);
  if (assezForte) {
    return {
      ...base,
      canonicalFlowIdentity: `tiers:${forts.join(" ")}`,
      matchMethod: "structured_counterparty",
      confidenceScore: CONFIANCE.structured_counterparty,
      title: titreContrepartie,
      tokens: forts,
    };
  }

  // Contrepartie trop faible pour identifier un flux (« ABC 1234 ») : seul le texte exact compte.
  const exact = normalizeTransactionLabel(label);
  return {
    ...base,
    canonicalFlowIdentity: exact === "" ? null : `texte:${exact}`,
    matchMethod: "exact_normalized",
    confidenceScore: CONFIANCE.exact_normalized,
    title: exact === "" ? label.trim() : enTitre(exact),
    tokens: [],
  };
}

/**
 * Compatibilité de deux contreparties, de 0 à 1 — explicable, sans distance d'édition :
 *   1   : mêmes mots forts ;
 *   0,7 : l'une prolonge l'autre (« europcam » / « europcam germain »), ou leur dernier mot est le
 *         même mot tronqué par la banque (« secur » / « security ») ;
 *   0   : sinon, y compris quand seul un mot diffère (« amazon business » / « amazon marketplace »).
 */
export function calculateSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const [court, long] = a.length <= b.length ? [a, b] : [b, a];
  const tronque = (x: string, y: string) => {
    const [petit, grand] = x.length <= y.length ? [x, y] : [y, x];
    return petit.length >= LONGUEUR_MIN_PREFIXE && grand.startsWith(petit);
  };
  for (let i = 0; i < court.length; i++) {
    const dernier = i === court.length - 1;
    // Seul le DERNIER mot du plus court peut être tronqué, et seulement s'il n'est pas tout seul :
    // le reste du noyau doit déjà concorder.
    if (court[i] !== long[i] && !(dernier && court.length >= 2 && tronque(court[i], long[i]))) return 0;
  }
  if (court.length === long.length) return court.every((jeton, i) => jeton === long[i]) ? 1 : 0.7;
  return 0.7;
}

/**
 * Identité de flux de chaque libellé d'un même ensemble (une catégorie, sur les deux périodes
 * comparées). Les étapes 1 à 3 donnent une identité par libellé ; l'étape 4 rapproche ensuite deux
 * contreparties voisines UNIQUEMENT quand c'est sans ambiguïté : chacune est la seule voisine de
 * l'autre. Dès qu'une contrepartie a deux voisines possibles (« amazon » face à « amazon business »
 * et « amazon marketplace »), personne n'est rapproché — c'est ce qui interdit tout chaînage.
 */
export function groupComparableTransactions(labels: Iterable<string>): Map<string, FlowIdentity> {
  const identites = new Map<string, FlowIdentity>();
  for (const label of labels) if (!identites.has(label)) identites.set(label, buildCanonicalFlowIdentity(label));

  const contreparties = new Map<string, string[]>();
  for (const identite of identites.values()) {
    if (identite.matchMethod === "structured_counterparty" && identite.canonicalFlowIdentity) {
      contreparties.set(identite.canonicalFlowIdentity, identite.tokens);
    }
  }
  const cles = [...contreparties.keys()].sort();
  const voisines = new Map<string, string[]>(cles.map((cle) => [cle, []]));
  for (let i = 0; i < cles.length; i++) {
    for (let j = i + 1; j < cles.length; j++) {
      if (calculateSimilarity(contreparties.get(cles[i])!, contreparties.get(cles[j])!) >= 0.7) {
        voisines.get(cles[i])!.push(cles[j]);
        voisines.get(cles[j])!.push(cles[i]);
      }
    }
  }
  // Paires réciproquement uniques : l'identité commune est la plus courte des deux (la forme stable).
  const fusion = new Map<string, string>();
  for (const cle of cles) {
    const [autre, ...reste] = voisines.get(cle)!;
    if (!autre || reste.length > 0 || voisines.get(autre)!.length !== 1) continue;
    const [reference, rattachee] = contreparties.get(cle)!.join(" ").length <= contreparties.get(autre)!.join(" ").length ? [cle, autre] : [autre, cle];
    fusion.set(rattachee, reference);
  }
  if (fusion.size > 0) {
    const titres = new Map([...identites.values()].map((identite) => [identite.canonicalFlowIdentity, identite.title]));
    for (const [label, identite] of identites) {
      const reference = identite.canonicalFlowIdentity && fusion.get(identite.canonicalFlowIdentity);
      if (!reference) continue;
      identites.set(label, {
        ...identite,
        canonicalFlowIdentity: reference,
        matchMethod: "token_similarity",
        confidenceScore: CONFIANCE.token_similarity,
        title: titres.get(reference) ?? identite.title,
      });
    }
  }
  return identites;
}

// --- Alias : le nom donné par l'utilisateur à un flux reconnu ---
//
// Un alias s'applique APRÈS la reconnaissance : il ne change ni l'identité d'un flux, ni les
// regroupements, ni aucune transaction. Il est attaché à l'identité PROPRE d'un libellé (étapes 1
// à 3, buildCanonicalFlowIdentity), pas à l'identité après rapprochement de contreparties voisines
// (étape 4) : celle-ci dépend des autres libellés présents dans la comparaison, et ne serait pas la
// même d'une analyse à l'autre.

/**
 * Version des règles qui produisent les identités. À incrémenter dès qu'une évolution du moteur
 * change une identité existante (voir le test « contrat des identités ») : les alias enregistrés
 * sous l'ancienne version doivent alors être recalculés à partir de leur libellé d'exemple.
 */
export const FLOW_ENGINE_VERSION = "2";

export const LONGUEUR_MAX_ALIAS = 80;

export interface FlowAlias {
  canonicalFlowKey: string;
  displayName: string;
}

/** Identité propre d'un libellé, clé de son alias ; null = flux sans identité, donc sans alias. */
export function aliasFlowKey(label: string): string | null {
  return buildCanonicalFlowIdentity(label).canonicalFlowIdentity;
}

/** Nom saisi par l'utilisateur, nettoyé ; null s'il est vide ou trop long. */
export function normaliserNomAlias(saisie: string): string | null {
  const nom = saisie.replace(/\s+/g, " ").trim();
  return nom === "" || nom.length > LONGUEUR_MAX_ALIAS ? null : nom;
}

/**
 * Nom à afficher pour un groupe de flux, ou null s'il n'a pas d'alias. Un groupe peut réunir
 * plusieurs identités propres (contreparties voisines) : celle qui donne son identité au groupe
 * est prioritaire, puis les autres dans un ordre fixe.
 */
export function resoudreAlias(clesPropres: string[], cleDuGroupe: string | null, alias: ReadonlyMap<string, string>): string | null {
  if (cleDuGroupe !== null && alias.has(cleDuGroupe) && clesPropres.includes(cleDuGroupe)) return alias.get(cleDuGroupe)!;
  for (const cle of [...clesPropres].sort()) if (alias.has(cle)) return alias.get(cle)!;
  return null;
}

/** Clé enregistrée en base (alias, membre d'un groupe) avec de quoi la recalculer. */
export interface CleEnregistree {
  cle: string;
  exemple: string | null; // libellé bancaire d'exemple
  version: string | null; // version du moteur qui a produit la clé
}

/**
 * Clés enregistrées sous une AUTRE version du moteur, repassées dans le moteur actuel à partir de
 * leur libellé d'exemple :
 *  - `deplacees` : l'identité du flux a changé, la clé doit suivre ;
 *  - `confirmees` : même identité, seule la version est à mettre à jour.
 * Une clé sans libellé d'exemple, ou dont l'exemple n'a plus d'identité, est laissée telle quelle.
 */
export function clesARecalculer(lignes: CleEnregistree[]): { deplacees: { ancienne: string; nouvelle: string }[]; confirmees: string[] } {
  const deplacees: { ancienne: string; nouvelle: string }[] = [];
  const confirmees: string[] = [];
  for (const ligne of lignes) {
    if (ligne.version === FLOW_ENGINE_VERSION || !ligne.exemple) continue;
    const nouvelle = aliasFlowKey(ligne.exemple);
    if (nouvelle === null) continue;
    if (nouvelle === ligne.cle) confirmees.push(ligne.cle);
    else deplacees.push({ ancienne: ligne.cle, nouvelle });
  }
  return { deplacees, confirmees };
}
