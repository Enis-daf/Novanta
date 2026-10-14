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
// Tolérance d'arrondi à l'euro, et rien de plus : une saisie arrondie (1 641 € pour 1 641,67 €).
const TOLERANCE_ARRONDI = 1;

function comparerMontants(a: number, b: number): "identique" | "arrondi" | null {
  const ecart = Math.abs(a - b);
  if (ecart < EGALITE_CENTIME) return "identique";
  if (ecart < TOLERANCE_ARRONDI) return "arrondi";
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

// --- Fusion conservatrice ---

/** Ce qu'une ligne porte en plus du document : les réglages de prévision Novanta. */
export interface FactureFusionnable extends FactureComparable {
  datePrevue: string; // date d'encaissement ou de paiement prévue
  payee: boolean;
  litigieuse: boolean;
}

export type PlanFusion =
  | {
      possible: true;
      survivantId: string; // la ligne qui reste, avec ses réglages de prévision
      surnumeraireId: string; // la ligne retirée
      pennylaneIdATransferer: string | null; // identité source rattachée au survivant
      ecarts: string[]; // différences de valeurs, à montrer avant confirmation
    }
  | { possible: false; motif: string };

export const MOTIF_MONTANTS_DIFFERENTS = "Montants différents : à vérifier et traiter à la main";

/**
 * Une facture Pennylane peut-elle être rattachée d'un clic à la ligne Novanta qu'elle semble
 * dupliquer ? Seulement si les montants concordent (à l'arrondi près) : sinon, même règle que pour
 * la fusion, la question reste ouverte.
 */
export function rattachementPossible(detection: DetectionDoublon): boolean {
  return detection.signaux.includes("montant_identique") || detection.signaux.includes("montant_arrondi");
}

const formatEuros = (montant: number) => `${montant.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} €`;

/**
 * Fusion de deux lignes reconnues comme le même document — appliquée seulement sur confirmation de
 * l'utilisateur (ou, sans confirmation, pour un même identifiant Pennylane). Aucune perte :
 *  - la ligne saisie dans Novanta reste : elle porte les réglages de l'utilisateur (montant prévu,
 *    date prévue, Payée, Litigieuse), qui ne sont pas recalculés ;
 *  - elle reçoit l'identifiant Pennylane de l'autre, qui devient sa source : la synchronisation la
 *    reconnaîtra désormais, et le document Pennylane reste consultable ;
 *  - la ligne importée par Pennylane n'est retirée que si l'utilisateur n'y a rien changé. Sinon,
 *    les deux portent des réglages : pas de fusion automatique, la décision revient à l'utilisateur.
 * Deux documents Pennylane distincts ne sont jamais fusionnés : la synchronisation réimporterait le
 * document retiré. C'est dans Pennylane qu'il faut archiver le doublon.
 */
export function planFusion(a: FactureFusionnable, b: FactureFusionnable): PlanFusion {
  if (a.pennylaneId && b.pennylaneId && a.pennylaneId !== b.pennylaneId) {
    return { possible: false, motif: "Deux documents Pennylane distincts : archivez le doublon dans Pennylane." };
  }
  // Montants différents (au-delà d'un arrondi à l'euro) : la question reste ouverte. Aucune des deux
  // valeurs n'est retenue d'office ; l'utilisateur traite la paire à la main.
  if (comparerMontants(a.montant, b.montant) === null) {
    return { possible: false, motif: `${MOTIF_MONTANTS_DIFFERENTS} (${formatEuros(a.montant)} / ${formatEuros(b.montant)}).` };
  }
  const ecarts = [
    ...(Math.abs(a.montant - b.montant) >= EGALITE_CENTIME ? [`Montant : ${formatEuros(a.montant)} / ${formatEuros(b.montant)}`] : []),
    ...(a.datePrevue !== b.datePrevue ? [`Date prévue : ${a.datePrevue || "—"} / ${b.datePrevue || "—"}`] : []),
    ...(a.payee !== b.payee ? ["Statut Payée différent"] : []),
  ];

  const [source, novanta] = a.pennylaneId && !b.pennylaneId ? [a, b] : b.pennylaneId && !a.pennylaneId ? [b, a] : [null, null];
  if (source && novanta) {
    // Une ligne importée par la synchronisation n'a jamais été touchée tant que la date prévue est
    // l'échéance et qu'elle n'est ni payée ni litigieuse : la retirer ne perd rien.
    const reglagesSurLaSource = source.payee || source.litigieuse || (source.datePrevue !== "" && source.datePrevue !== source.dateEcheance);
    if (reglagesSurLaSource) {
      return { possible: false, motif: "Les deux lignes portent des réglages : choisissez celle à conserver et retirez l'autre." };
    }
    return { possible: true, survivantId: novanta.id, surnumeraireId: source.id, pennylaneIdATransferer: source.pennylaneId ?? null, ecarts };
  }

  // Même identifiant Pennylane (ou aucun) : la ligne qui porte des réglages reste.
  const aDesReglages = (f: FactureFusionnable) => f.payee || f.litigieuse || (f.datePrevue !== "" && f.datePrevue !== f.dateEcheance);
  if (aDesReglages(a) && aDesReglages(b) && ecarts.length > 0) {
    return { possible: false, motif: "Les deux lignes portent des réglages différents : choisissez celle à conserver." };
  }
  const [survivant, surnumeraire] = aDesReglages(b) && !aDesReglages(a) ? [b, a] : [a, b];
  return { possible: true, survivantId: survivant.id, surnumeraireId: surnumeraire.id, pennylaneIdATransferer: null, ecarts };
}
