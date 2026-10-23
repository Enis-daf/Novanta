/**
 * Doublons de factures — pur, sans effet de bord, sans accès aux données.
 *
 * Une facture = UN document économique. Deux lignes Novanta peuvent pourtant représenter le même
 * document : typiquement une facture saisie (ou importée par fichier) dans Novanta, puis la même
 * facture importée par la synchronisation Pennylane, qui ne la reconnaissait que par son
 * identifiant Pennylane.
 *
 * Trois gestes distincts, jamais confondus :
 *  - SUGGÉRER : dès qu'un signal documentaire sérieux existe (même n° de facture fiable) ;
 *  - CONFIRMER : l'utilisateur valide la suggestion ;
 *  - FUSIONNER AUTOMATIQUEMENT : uniquement quand l'identité est certaine (même identifiant
 *    Pennylane). Tout le reste passe par une décision de l'utilisateur.
 *
 * La classification est explicable : chaque rapprochement liste ses signaux concrets (« Même n° de
 * facture · même montant · fournisseur similaire »), jamais un score opaque. Aucun client ni
 * fournisseur n'est nommé dans ce fichier : tout repose sur des règles génériques.
 */
import { EtageDepense, reunirEtagesManuels } from "./futurPnl";
import { normalizeLabel } from "./flowMatching";

export type StatutDoublon = "DUPLICATE_CERTAIN" | "SAME_DOCUMENT" | "REVIEW" | "DISTINCT";
export type Confiance = "certain" | "quasi_certain" | "probable" | "possible";
export type Sens = "client" | "fournisseur";

export type Signal =
  | "meme_id_source" // même identifiant Pennylane
  | "meme_numero" // même n° de facture, fiable
  | "meme_numero_generique" // même n° de facture, mais générique (« 003 », « Simulation »...)
  | "montant_identique"
  | "montant_arrondi" // écart d'arrondi à l'euro (34 171 € / 34 171,20 €)
  | "contrepartie_identique"
  | "contrepartie_similaire"
  | "meme_echeance"
  | "ligne_identique"; // tous les champs du document identiques

/** Ce que la détection lit d'une facture : le document, jamais les réglages de prévision. */
export interface FactureComparable {
  id: string;
  facture: string; // n° de facture
  tiers: string; // client ou fournisseur
  montant: number;
  dateEcheance: string; // YYYY-MM-DD, "" si absente
  pennylaneId?: string | null;
}

export interface DetectionDoublon {
  statut: StatutDoublon;
  confiance: Confiance | null; // null pour DISTINCT
  signaux: Signal[];
  // Deux documents Pennylane distincts portent ce même n° : à vérifier dans Pennylane, jamais
  // fusionnés dans Novanta (la synchronisation les réimporterait).
  deuxDocumentsSource: boolean;
  libelle: string; // « Doublon quasi certain », « Doublon probable », « Doublon possible »
  raison: string; // « Même n° de facture · même montant · fournisseur similaire »
}

// --- Numéro de facture ---

/**
 * N° normalisé : casse, espaces et formes Unicode seulement. La ponctuation reste : « FA2609-0091 »
 * et « FA26090091 » ne sont pas garantis être le même document. Aucun rapprochement approximatif.
 */
export function normaliserNumero(numero: string | null | undefined): string {
  return (numero ?? "").normalize("NFKC").toUpperCase().replace(/\s+/g, "");
}

// Un n° sans aucun chiffre (« Simulation », « Proforma ») ou fait de quelques chiffres seulement
// (« 003 ») ne désigne pas un document : il revient d'un tiers à l'autre, d'une facture à l'autre.
const CHIFFRES_MIN_NUMERO_FIABLE = 4;

/** Le n° identifie-t-il un document à lui seul ? Non pour les références génériques ou trop courtes. */
export function estNumeroFiable(numero: string | null | undefined): boolean {
  const normalise = normaliserNumero(numero);
  const chiffres = normalise.match(/\d/g)?.length ?? 0;
  return chiffres >= CHIFFRES_MIN_NUMERO_FIABLE;
}

// --- Montant ---

const EGALITE_CENTIME = 0.005;
// Montants « quasi identiques » : un arrondi de saisie à l'euro (1 641 € pour 1 641,67 €), ou un
// écart d'au plus 1 % du plus grand des deux. Au-delà, ce sont des montants différents (choix
// produit validé : jamais de tolérance plus large).
const TOLERANCE_ARRONDI = 1;
export const TOLERANCE_RELATIVE_MONTANT = 0.01;

function comparerMontants(a: number, b: number): "identique" | "arrondi" | null {
  const ecart = Math.abs(a - b);
  if (ecart < EGALITE_CENTIME) return "identique";
  if (ecart < TOLERANCE_ARRONDI || ecart <= TOLERANCE_RELATIVE_MONTANT * Math.max(Math.abs(a), Math.abs(b))) return "arrondi";
  return null;
}

// --- Contrepartie ---

// Mots qui ne disent pas QUI est le tiers : formes juridiques, liaisons, mots trop répandus, et
// mots qui décrivent la facture plutôt que le tiers (« acompte », « solde », « montage »...), ajoutés
// au nom lors d'une saisie dans Novanta.
const MOTS_NON_DISTINCTIFS = new Set([
  "sarl", "eurl", "sas", "sasu", "sa", "sci", "selarl", "scp", "earl", "snc", "gmbh", "ltd", "inc", "llc", "bv", "spa",
  "societe", "ste", "groupe", "group", "france", "services", "service", "company", "cie",
  "de", "du", "des", "le", "la", "les", "et", "of", "the", "en", "sur", "pour", "par", "mois",
  "facture", "acompte", "solde", "avoir", "proforma", "devis", "simulation", "prestation", "prestations", "travaux",
  "montage", "maintenance", "livraison", "commande", "mes", "mise", "service", "frais", "reste", "partiel",
]);

const motsDe = (nom: string) => normalizeLabel(nom).split(" ").filter(Boolean);

/** Mots qui identifient le tiers : 3 lettres au moins, pas une référence, pas un mot générique. */
function motsDistinctifs(nom: string): Set<string> {
  return new Set(motsDe(nom).filter((mot) => mot.length >= 3 && (mot.match(/\d/g)?.length ?? 0) < 2 && !MOTS_NON_DISTINCTIFS.has(mot)));
}

/** Sigle d'un nom : l'initiale de chacun de ses mots (« Chaudronnerie de la Cère » -> « cdlc »). */
function sigles(nom: string): Set<string> {
  const mots = motsDe(nom).filter((mot) => !/^\d+$/.test(mot));
  const significatifs = mots.filter((mot) => !MOTS_NON_DISTINCTIFS.has(mot) || mot.length > 3);
  return new Set([mots, significatifs].map((liste) => liste.map((mot) => mot[0]).join("")).filter((sigle) => sigle.length >= 3));
}

/**
 * Deux noms désignent-ils le même tiers ? « identique » : mêmes mots distinctifs. « similaire » : un
 * mot distinctif commun (« SOLVEO acompte » / « SOLVEO ENERGIES », « FLS » / « FLS PEMP Cuxac »), ou
 * l'un est le sigle de l'autre (« CDLC boxes » / « Chaudronnerie de la Cère »). Réservé au contexte
 * d'un même n° de facture : ce signal renforce une identité documentaire, il ne la crée jamais.
 */
export function comparerContreparties(a: string, b: string): "identique" | "similaire" | null {
  const motsA = motsDistinctifs(a);
  const motsB = motsDistinctifs(b);
  if (motsA.size > 0 && motsA.size === motsB.size && [...motsA].every((mot) => motsB.has(mot))) return "identique";
  if ([...motsA].some((mot) => motsB.has(mot))) return "similaire";
  const siglesA = sigles(a);
  const siglesB = sigles(b);
  if ([...motsA].some((mot) => siglesB.has(mot)) || [...motsB].some((mot) => siglesA.has(mot))) return "similaire";
  return null;
}

// --- Classification ---

const LIBELLES: Record<Confiance, string> = {
  certain: "Doublon certain",
  quasi_certain: "Doublon quasi certain",
  probable: "Doublon probable",
  possible: "Doublon possible",
};

function raisonDe(signaux: Signal[], sens: Sens): string {
  const tiers = sens === "client" ? "client" : "fournisseur";
  const textes: Partial<Record<Signal, string>> = {
    meme_id_source: "Même facture Pennylane",
    meme_numero: "Même n° de facture",
    meme_numero_generique: "Même référence (générique)",
    montant_identique: "même montant",
    montant_arrondi: "montant quasi identique",
    contrepartie_identique: `même ${tiers}`,
    contrepartie_similaire: `${tiers} similaire`,
    meme_echeance: "même échéance",
  };
  const morceaux = signaux.filter((s) => s !== "ligne_identique").map((s) => textes[s]).filter((t): t is string => Boolean(t));
  const phrase = morceaux.join(" · ");
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

function resultat(statut: StatutDoublon, confiance: Confiance | null, signaux: Signal[], sens: Sens, deuxDocumentsSource = false): DetectionDoublon {
  return {
    statut,
    confiance,
    signaux,
    deuxDocumentsSource,
    libelle: confiance ? LIBELLES[confiance] : "",
    raison: statut === "DISTINCT" ? "" : raisonDe(signaux, sens) + (deuxDocumentsSource ? " · deux documents Pennylane distincts" : ""),
  };
}

/**
 * Classe une paire de factures du même sens (deux factures clients, ou deux fournisseurs).
 *
 *  - même identifiant Pennylane                          -> DUPLICATE_CERTAIN (certain)
 *  - n° fiable + document strictement identique          -> DUPLICATE_CERTAIN (quasi certain)
 *  - n° fiable + montant + contrepartie                   -> SAME_DOCUMENT (quasi certain)
 *  - n° fiable + montant OU contrepartie                  -> SAME_DOCUMENT (probable)
 *  - n° fiable seul                                       -> REVIEW (possible)
 *  - n° générique + montant + contrepartie + échéance     -> REVIEW (possible)
 *  - tout le reste (dont même montant et même tiers sans même n°) -> DISTINCT
 */
export function comparerFactures(a: FactureComparable, b: FactureComparable, sens: Sens): DetectionDoublon {
  if (a.pennylaneId && b.pennylaneId && a.pennylaneId === b.pennylaneId) {
    return resultat("DUPLICATE_CERTAIN", "certain", ["meme_id_source"], sens);
  }

  const numeroA = normaliserNumero(a.facture);
  if (!numeroA || numeroA !== normaliserNumero(b.facture)) return resultat("DISTINCT", null, [], sens);

  const montant = comparerMontants(a.montant, b.montant);
  const contrepartie = comparerContreparties(a.tiers, b.tiers);
  const memeEcheance = Boolean(a.dateEcheance) && a.dateEcheance === b.dateEcheance;
  const signauxComplementaires: Signal[] = [
    ...(montant === "identique" ? (["montant_identique"] as const) : montant === "arrondi" ? (["montant_arrondi"] as const) : []),
    ...(contrepartie === "identique" ? (["contrepartie_identique"] as const) : contrepartie === "similaire" ? (["contrepartie_similaire"] as const) : []),
    ...(memeEcheance ? (["meme_echeance"] as const) : []),
  ];
  // Deux identifiants Pennylane différents : Pennylane lui-même porte deux documents.
  const deuxDocumentsSource = Boolean(a.pennylaneId && b.pennylaneId);

  if (!estNumeroFiable(numeroA)) {
    const tousLesSignaux = montant !== null && contrepartie !== null && memeEcheance;
    return tousLesSignaux
      ? resultat("REVIEW", "possible", ["meme_numero_generique", ...signauxComplementaires], sens, deuxDocumentsSource)
      : resultat("DISTINCT", null, [], sens);
  }

  const signaux: Signal[] = ["meme_numero", ...signauxComplementaires];
  const ligneIdentique =
    montant === "identique" &&
    normalizeLabel(a.tiers) === normalizeLabel(b.tiers) &&
    memeEcheance &&
    !deuxDocumentsSource &&
    (a.pennylaneId ?? null) === (b.pennylaneId ?? null);
  if (ligneIdentique) return resultat("DUPLICATE_CERTAIN", "quasi_certain", [...signaux, "ligne_identique"], sens);
  if (montant !== null && contrepartie !== null) return resultat("SAME_DOCUMENT", "quasi_certain", signaux, sens, deuxDocumentsSource);
  if (montant !== null || contrepartie !== null) return resultat("SAME_DOCUMENT", "probable", signaux, sens, deuxDocumentsSource);
  return resultat("REVIEW", "possible", signaux, sens, deuxDocumentsSource);
}

const RANG_STATUT: Record<StatutDoublon, number> = { DUPLICATE_CERTAIN: 0, SAME_DOCUMENT: 1, REVIEW: 2, DISTINCT: 3 };
const RANG_CONFIANCE: Record<Confiance, number> = { certain: 0, quasi_certain: 1, probable: 2, possible: 3 };

/** Ordre d'affichage : la plus forte confiance d'abord. */
export function comparerDetections(x: DetectionDoublon, y: DetectionDoublon): number {
  return RANG_STATUT[x.statut] - RANG_STATUT[y.statut] || RANG_CONFIANCE[x.confiance ?? "possible"] - RANG_CONFIANCE[y.confiance ?? "possible"];
}

export interface PaireDoublon<T extends FactureComparable = FactureComparable> {
  a: T;
  b: T;
  detection: DetectionDoublon;
}

/**
 * Toutes les paires suspectes d'une liste de factures du même sens, de la plus sûre à la moins
 * sûre. Seules les factures partageant un n° ou un identifiant Pennylane sont comparées : un même
 * montant ou un même tiers ne suffit jamais à faire remonter une paire.
 */
export function detecterDoublons<T extends FactureComparable>(factures: T[], sens: Sens): PaireDoublon<T>[] {
  const groupes = new Map<string, T[]>();
  for (const facture of factures) {
    for (const cle of [`n:${normaliserNumero(facture.facture)}`, facture.pennylaneId ? `p:${facture.pennylaneId}` : null]) {
      if (!cle || cle === "n:") continue;
      groupes.set(cle, [...(groupes.get(cle) ?? []), facture]);
    }
  }
  const vues = new Set<string>();
  const paires: PaireDoublon<T>[] = [];
  for (const groupe of groupes.values()) {
    for (let i = 0; i < groupe.length; i++) {
      for (let j = i + 1; j < groupe.length; j++) {
        const [a, b] = [groupe[i], groupe[j]];
        const cle = [a.id, b.id].sort().join("|");
        if (vues.has(cle)) continue;
        vues.add(cle);
        const detection = comparerFactures(a, b, sens);
        if (detection.statut !== "DISTINCT") paires.push({ a, b, detection });
      }
    }
  }
  return paires.sort((x, y) => comparerDetections(x.detection, y.detection));
}

// --- Fusion confirmée par l'utilisateur ---
//
// Règle de priorité (impérative) :
//  - FACTURE : la facture de référence fait foi pour le document — n°, tiers, montant, échéance,
//    identité Pennylane. Quand une seule des deux lignes vient de Pennylane, c'est elle, sans
//    exception ni choix : Pennylane est la source de vérité, même si les valeurs diffèrent fortement.
//  - PRÉVISION : les réglages posés dans Novanta (date de paiement prévue, Payée, Litigieuse) sont
//    repris. L'échéance n'est jamais la date de paiement prévue : une date prévue explicite est
//    conservée telle quelle.
//  - Un écart de montant ne devient jamais un paiement partiel ni un montant de prévision : le
//    montant de la référence est le montant pris en compte.
// Seul un vrai conflit entre deux réglages Novanta (deux dates prévues explicites différentes, ou
// deux étages P&L choisis différemment dans Futur) est soumis à l'utilisateur. Un même étage ne
// rend jamais deux factures doublons : il n'entre pas dans la détection.

/** Ce qu'une ligne porte en plus du document : les réglages de prévision Novanta. */
export interface FactureFusionnable extends FactureComparable {
  datePrevue: string; // date d'encaissement ou de paiement prévue
  payee: boolean;
  litigieuse: boolean;
  // Étage P&L choisi dans Futur (lib/futurPnl.ts), réglage Novanta comme la date prévue.
  etagePnlManuel?: EtageDepense | null;
}

export type CoteFusion = "a" | "b";

export interface ConflitDatePrevue {
  valeurs: Record<CoteFusion, string>; // YYYY-MM-DD
}

export interface PropositionFusion {
  // Ligne de référence : la facture Pennylane quand une seule l'est ; sinon au choix.
  referenceId: string;
  retireeId: string;
  referenceImposee: boolean;
  // Deux dates de paiement prévues explicites et différentes : l'utilisateur choisit. null sinon.
  conflitDatePrevue: ConflitDatePrevue | null;
  // Deux étages P&L choisis différemment dans Futur : l'utilisateur choisit. null sinon.
  conflitEtagePnl: { valeurs: Record<CoteFusion, EtageDepense> } | null;
}

export interface ChoixFusion {
  datePrevue?: CoteFusion;
  etagePnl?: CoteFusion;
}

export interface ResultatFusion<T extends FactureFusionnable = FactureFusionnable> {
  reference: T; // la ligne conservée : document de la référence, réglages Novanta repris
  retiree: T; // la ligne retirée, telle qu'avant la fusion (historique)
  // Identifiant Pennylane de la ligne retirée : la synchronisation ne la réimportera plus.
  pennylaneIdRetire: string | null;
}

/** Date de paiement prévue posée explicitement : différente de l'échéance de sa ligne. */
export const datePrevueExplicite = (f: FactureFusionnable) => f.datePrevue !== "" && f.datePrevue !== f.dateEcheance;

function choisirReference<T extends FactureFusionnable>(a: T, b: T, choisie: string | null): { ref: T; autre: T; imposee: boolean } {
  if (a.pennylaneId && !b.pennylaneId) return { ref: a, autre: b, imposee: true };
  if (b.pennylaneId && !a.pennylaneId) return { ref: b, autre: a, imposee: true };
  if (choisie === b.id) return { ref: b, autre: a, imposee: false };
  return { ref: a, autre: b, imposee: false };
}

/** Ce que la fusion implique, à montrer AVANT confirmation. Rien n'est appliqué ici. */
export function proposerFusion(a: FactureFusionnable, b: FactureFusionnable, referenceChoisie: string | null = null): PropositionFusion {
  const { ref, autre, imposee } = choisirReference(a, b, referenceChoisie);
  const conflit = datePrevueExplicite(a) && datePrevueExplicite(b) && a.datePrevue !== b.datePrevue;
  const etages = reunirEtagesManuels(a.etagePnlManuel, b.etagePnlManuel);
  return {
    referenceId: ref.id,
    retireeId: autre.id,
    referenceImposee: imposee,
    conflitDatePrevue: conflit ? { valeurs: { a: a.datePrevue, b: b.datePrevue } } : null,
    conflitEtagePnl: etages.conflit ? { valeurs: etages.conflit } : null,
  };
}

/** Le conflit éventuel est-il tranché ? */
export function fusionPrete(proposition: PropositionFusion, choix: ChoixFusion): boolean {
  return (
    (proposition.conflitDatePrevue === null || choix.datePrevue !== undefined) &&
    (proposition.conflitEtagePnl === null || choix.etagePnl !== undefined)
  );
}

/**
 * Applique une fusion confirmée. La référence garde tout son document ; reçoit les réglages de
 * prévision Novanta :
 *  - date prévue : la date explicite de l'une ou l'autre ligne (celle choisie en cas de conflit) ;
 *    sans date explicite, celle de la référence ;
 *  - Payée, Litigieuse : repris dès que l'une des deux lignes les porte ;
 *  - étage P&L choisi dans Futur : celui de l'une ou l'autre ligne (celui choisi en cas de conflit).
 * null tant que le conflit éventuel n'est pas tranché.
 */
export function appliquerFusion<T extends FactureFusionnable>(a: T, b: T, proposition: PropositionFusion, choix: ChoixFusion): ResultatFusion<T> | null {
  if (!fusionPrete(proposition, choix)) return null;
  const ref = proposition.referenceId === a.id ? a : b;
  const retiree = ref === a ? b : a;
  const datePrevue = proposition.conflitDatePrevue
    ? (choix.datePrevue === "a" ? a : b).datePrevue
    : datePrevueExplicite(ref)
      ? ref.datePrevue
      : datePrevueExplicite(retiree)
        ? retiree.datePrevue
        : ref.datePrevue;
  const etagePnlManuel = proposition.conflitEtagePnl
    ? proposition.conflitEtagePnl.valeurs[choix.etagePnl!]
    : reunirEtagesManuels(ref.etagePnlManuel, retiree.etagePnlManuel).etage;
  return {
    reference: {
      ...ref,
      datePrevue,
      payee: ref.payee || retiree.payee,
      litigieuse: ref.litigieuse || retiree.litigieuse,
      // Aucun champ ajouté à des lignes qui ne portent pas d'étage (factures clients notamment).
      ...(ref.etagePnlManuel === undefined && retiree.etagePnlManuel === undefined ? {} : { etagePnlManuel }),
    },
    retiree,
    pennylaneIdRetire: retiree.pennylaneId ?? null,
  };
}

/**
 * Les montants concordent-ils (à l'arrondi ou à 1 % près) ? Information affichée seulement : même
 * différents, une facture Pennylane se rattache à la ligne Novanta sur confirmation, avec les mêmes
 * règles que la fusion (voir rattacherAPennylane).
 */
export function rattachementPossible(detection: DetectionDoublon): boolean {
  return detection.signaux.includes("montant_identique") || detection.signaux.includes("montant_arrondi");
}

/** Clé d'une paire, indépendante de l'ordre : la même que celle des décisions enregistrées. */
export function clePaire(idA: string, idB: string): string {
  return [idA, idB].sort().join("|");
}

/** Document d'une facture Pennylane, tel que reçu à la synchronisation. */
export interface DocumentPennylane {
  pennylaneId: string;
  facture: string;
  tiers: string;
  montant: number;
  dateEcheance: string;
  payee: boolean;
}

/**
 * Rattachement d'une facture Pennylane non encore importée à la ligne Novanta qui la représente :
 * même règle que la fusion. La ligne prend le document Pennylane (n°, tiers, montant, échéance,
 * identité) et garde ses réglages de prévision (date prévue explicite, Payée, Litigieuse).
 */
export function rattacherAPennylane<T extends FactureFusionnable>(ligne: T, document: DocumentPennylane): T {
  return {
    ...ligne,
    pennylaneId: document.pennylaneId,
    facture: document.facture,
    tiers: document.tiers,
    montant: document.montant,
    dateEcheance: document.dateEcheance,
    // Sans date explicite, la prévision suit l'échéance Pennylane.
    datePrevue: datePrevueExplicite(ligne) ? ligne.datePrevue : document.dateEcheance,
    payee: ligne.payee || document.payee,
  };
}
