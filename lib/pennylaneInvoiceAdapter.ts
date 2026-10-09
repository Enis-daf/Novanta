/**
 * Adapte les factures Pennylane (clients + fournisseurs) au modèle Novanta, et calcule la
 * synchronisation à appliquer — pur, sans effet de bord, sans appel réseau (voir
 * lib/pennylaneClient.ts pour les appels HTTP, app/api/pennylane/invoices/route.ts pour
 * l'orchestration serveur, app/page.tsx pour l'écriture Supabase côté client).
 *
 * Aucune règle ici n'est devinée : chaque décision renvoie au diagnostic vérifié empiriquement
 * contre l'API Pennylane v2 réelle (voir le rapport livré avant implémentation).
 */
import { PennylaneCustomerInvoiceListItem, PennylaneSupplierInvoiceListItem } from "./pennylaneClient";
import { FactureClient, FactureFournisseur } from "./types";

/**
 * Résultat affiché après un clic sur "Synchroniser Pennylane" — déclenchable depuis
 * FacturesClientsTable ou FacturesFournisseursTable (voir app/page.tsx), toujours le résultat
 * complet des deux catégories quel que soit le bouton cliqué : une seule opération de
 * synchronisation, affichée aux deux endroits où elle peut être déclenchée.
 */
export interface ResultatSyncPennylane {
  // Nombre total de factures candidates renvoyées par Pennylane (avant le rapprochement avec
  // l'existant Novanta) — permet de distinguer "0 ajoutée parce qu'aucune facture chez Pennylane"
  // de "0 ajoutée parce que déjà toutes importées" : sans ce chiffre, les deux cas semblent
  // identiques et un utilisateur ne peut pas savoir si la synchro a bien tourné.
  nombreClientsAnalysees: number;
  nombreFournisseursAnalysees: number;
  nombreClientsAjoutes: number;
  nombreFournisseursAjoutes: number;
  nombreMarquesPayees: number;
  // Factures fournisseurs déjà importées dont la version Pennylane est désormais archivée : retirées.
  nombreArchiveesRetirees: number;
  erreurClients: string | null;
  erreurFournisseurs: string | null;
}

function pluriel(n: number, mot: string): string {
  return n > 1 ? `${mot}s` : mot;
}

/**
 * Message affiché après une synchronisation — factorisé ici (plutôt que dupliqué dans
 * FacturesClientsTable/FacturesFournisseursTable/ImportFactures, les trois endroits où le résultat
 * s'affiche) pour qu'un seul texte, un seul calcul de pluriel, ne puisse jamais diverger entre les
 * trois. Distingue explicitement "analysée" (trouvée chez Pennylane) de "ajoutée" (réellement
 * nouvelle pour Novanta) : un utilisateur qui relance une synchro déjà à jour voit "0 ajoutée" à
 * côté de "X analysées", ce qui explique le 0 au lieu de ressembler à un échec silencieux.
 */
export function messageSyncPennylane(r: ResultatSyncPennylane): string {
  const fournisseurs = `${r.nombreFournisseursAnalysees} ${pluriel(r.nombreFournisseursAnalysees, "facture")} fournisseur${
    r.nombreFournisseursAnalysees > 1 ? "s" : ""
  } chez Pennylane, ${r.nombreFournisseursAjoutes} nouvelle${r.nombreFournisseursAjoutes > 1 ? "s" : ""} importée${
    r.nombreFournisseursAjoutes > 1 ? "s" : ""
  }`;
  const clients = `${r.nombreClientsAnalysees} ${pluriel(r.nombreClientsAnalysees, "facture")} client${
    r.nombreClientsAnalysees > 1 ? "s" : ""
  } chez Pennylane, ${r.nombreClientsAjoutes} nouvelle${r.nombreClientsAjoutes > 1 ? "s" : ""} importée${
    r.nombreClientsAjoutes > 1 ? "s" : ""
  }`;
  const payees = `${r.nombreMarquesPayees} ${pluriel(r.nombreMarquesPayees, "facture")} marquée${
    r.nombreMarquesPayees > 1 ? "s" : ""
  } payée${r.nombreMarquesPayees > 1 ? "s" : ""}`;
  const retirees =
    r.nombreArchiveesRetirees > 0
      ? ` ${r.nombreArchiveesRetirees} ${pluriel(r.nombreArchiveesRetirees, "facture")} archivée${
          r.nombreArchiveesRetirees > 1 ? "s" : ""
        } dans Pennylane retirée${r.nombreArchiveesRetirees > 1 ? "s" : ""}.`
      : "";
  return `Pennylane synchronisé — Fournisseurs : ${fournisseurs}. Clients : ${clients}. ${payees} au total.${retirees}`;
}

/**
 * Un avoir a un montant négatif chez Pennylane (vérifié en direct : "Avoir EOLIA - AV2607-0006",
 * amount "-19800.0"). Jamais importé comme facture classique en V1 (voir diagnostic) — accepte
 * number pour rester utilisable indifféremment sur du texte brut ("amount") ou un montant déjà
 * converti.
 */
export function estAvoir(montant: string | number): boolean {
  return Number(montant) < 0;
}

/**
 * Pourquoi une facture Pennylane n'est pas importée dans Novanta :
 *  - "payee"    : Pennylane la considère réglée ;
 *  - "archivee" : version archivée ou annulée — elle n'est plus la facture de référence.
 */
export type MotifSolde = "payee" | "archivee";

/** Candidat générique (client ou fournisseur) prêt à être comparé à l'existant Novanta. */
export interface CandidatFacturePennylane {
  pennylaneId: string;
  facture: string; // numéro
  tiers: string; // nom du client ou du fournisseur
  montant: number; // toujours positif — le sens (entrée/sortie) est déterminé par le type, jamais ici
  dateEcheance: string; // YYYY-MM-DD, "" si Pennylane n'en fournit aucune
  payee: boolean; // true = réglée selon Pennylane (voir decisionPaiementFournisseur / decisionPaiementClient)
  motifSolde?: MotifSolde | null; // non null = jamais importée (voir MotifSolde)
  // Facture fournisseur archivée dans Pennylane : jamais importée, et retirée de Novanta si elle y
  // est déjà (voir calculerSynchronisation). Ce n'est pas une facture de trésorerie active.
  aRetirer?: boolean;
}

// --- Statut de paiement : SEUL endroit où il se décide ---

/**
 * Statuts de paiement d'une facture FOURNISSEUR (champ payment_status de l'API). payment_status
 * décrit le workflow de paiement, pas le règlement : c'est le booléen `paid` qui arbitre (voir
 * estPayeeFournisseur). Les statuts ne servent qu'à rattraper un `paid` resté à false et à repérer
 * un statut inconnu.
 */
export const STATUTS_PAIEMENT_FOURNISSEUR = {
  // Statuts terminaux : la facture est réglée même si `paid` est resté à false.
  payes: ["fully_paid", "paid_offline"],
  // Statuts de workflow : ils ne disent rien du règlement, `paid` seul décide.
  ouverts: [
    "to_be_processed",
    "to_be_paid",
    "partially_paid",
    "payment_error",
    "payment_scheduled",
    "payment_in_progress",
    "payment_emitted",
    "payment_found",
  ],
} as const;

/** Statuts d'une facture CLIENT (champ status de l'API) qui la soldent. */
export const STATUTS_FACTURE_CLIENT = {
  payes: ["paid"],
  retires: ["archived", "cancelled"],
} as const;

const inclut = (liste: readonly string[], valeur: string | null | undefined) => typeof valeur === "string" && liste.includes(valeur);

export interface DecisionPaiement {
  payee: boolean;
  motifSolde: MotifSolde | null;
  // Statut de paiement que ce code ne connaît pas : jamais deviné. La facture suit alors le booléen
  // `paid`, et le statut est remonté pour être journalisé.
  statutInconnu: string | null;
}

/**
 * Facture fournisseur ACTIVE réglée ? Le booléen `paid` de Pennylane arbitre : une facture
 * to_be_processed ou to_be_paid dont `paid` est true est payée, la même avec `paid` false ne l'est
 * pas. Le reste à payer n'est jamais lu.
 * Seule variante : fully_paid et paid_offline valent aussi « payée » quand `paid` est resté à
 * false — constaté sur des données réelles (factures réglées hors Pennylane ou en attente de
 * validation comptable), et ne lire que `paid` les importait toutes comme impayées.
 */
export function estPayeeFournisseur(item: { paid: boolean; payment_status?: string | null }): boolean {
  return item.paid === true || inclut(STATUTS_PAIEMENT_FOURNISSEUR.payes, item.payment_status);
}

/** Version archivée d'une facture fournisseur (accounting_status "archived" ou archived_at renseigné). */
export function estArchiveeFournisseur(item: { accounting_status?: string | null; archived_at?: string | null }): boolean {
  return item.accounting_status === "archived" || Boolean(item.archived_at);
}

/**
 * Facture fournisseur : une version archivée n'est pas une facture de trésorerie (motif
 * "archivee", jamais marquée Payée à ce titre) ; sinon `payee` vient de estPayeeFournisseur.
 */
export function decisionPaiementFournisseur(item: {
  paid: boolean;
  payment_status?: string | null;
  accounting_status?: string | null;
  archived_at?: string | null;
}): DecisionPaiement {
  const payee = estPayeeFournisseur(item);
  const connu =
    item.payment_status == null ||
    inclut(STATUTS_PAIEMENT_FOURNISSEUR.payes, item.payment_status) ||
    inclut(STATUTS_PAIEMENT_FOURNISSEUR.ouverts, item.payment_status);
  return {
    payee,
    motifSolde: estArchiveeFournisseur(item) ? "archivee" : payee ? "payee" : null,
    statutInconnu: connu ? null : (item.payment_status as string),
  };
}

/**
 * Facture client : pas de payment_status côté clients, le champ `status` et le booléen `paid` font
 * foi. Une facture archivée ou annulée reste marquée Payée (comportement inchangé).
 */
export function decisionPaiementClient(item: { paid: boolean; status?: string | null; archived_at?: string | null }): DecisionPaiement {
  if (inclut(STATUTS_FACTURE_CLIENT.retires, item.status) || item.archived_at) {
    return { payee: true, motifSolde: "archivee", statutInconnu: null };
  }
  const payee = item.paid === true || inclut(STATUTS_FACTURE_CLIENT.payes, item.status);
  return { payee, motifSolde: payee ? "payee" : null, statutInconnu: null };
}

// Format observé sur des libellés réels Pennylane :
//   "Facture SOCIETE D'EXPLOITATION EOLIENNE ANGRIE - FA2609-0090 (label généré)"
//   "Avoir EOLIA - AV2607-0006 (label généré)"
//   "Facture AMAZON - INV-407-1429953-4000307(2) (label généré)"
//   "Facture - 2026-3080464 (label généré)"                        (nom du tiers absent)
// Le nom du tiers peut donc être vide, et le suffixe "(label généré)" n'est pas garanti présent
// (un libellé personnalisé dans Pennylane n'a aucune raison de le porter). Best-effort : si le
// motif ne correspond pas du tout, on retombe sur le libellé complet plutôt que d'échouer. Utilisé
// pour les deux types de facture : ni l'une ni l'autre des deux listes Pennylane ne fournit de nom
// de tiers en clair (seulement un identifiant/objet de référence), uniquement ce libellé.
const MOTIF_LABEL_FACTURE = /^(?:Facture|Avoir)\s*(.*?)\s*-\s*(.+?)(?:\s*\(label généré\))?$/;

export function extraireTiersEtNumero(
  label: string | null,
  idFallback: string,
  libelleGenerique = "Tiers Pennylane"
): { tiers: string; numero: string } {
  if (!label) return { tiers: libelleGenerique, numero: idFallback };
  const correspondance = label.match(MOTIF_LABEL_FACTURE);
  if (!correspondance) return { tiers: label, numero: idFallback };
  const tiers = correspondance[1].trim();
  const numero = correspondance[2].trim();
  return {
    tiers: tiers || libelleGenerique,
    numero: numero || idFallback,
  };
}

// Champs communs aux deux types de facture Pennylane, nécessaires au calcul d'un candidat —
// PennylaneCustomerInvoiceListItem et PennylaneSupplierInvoiceListItem satisfont tous les deux
// cette forme (voir lib/pennylaneClient.ts).
interface FactureBrutePennylane {
  id: number | string;
  invoice_number: string | null;
  date: string | null;
  label: string | null;
  amount: string;
  deadline: string | null;
  paid: boolean;
}

/**
 * Construit un candidat à partir d'une facture brute Pennylane (client ou fournisseur — même
 * forme minimale pour les deux, voir FactureBrutePennylane). Le statut de paiement est décidé par
 * l'appelant (decisionPaiementFournisseur / decisionPaiementClient) : il ne se lit pas de la même
 * façon pour les deux types de facture, et jamais sur le seul booléen `paid`.
 */
function candidatDepuisFactureBrute(
  brute: FactureBrutePennylane,
  libelleGeneriqueTiers: string,
  decision: DecisionPaiement
): CandidatFacturePennylane | null {
  if (estAvoir(brute.amount)) return null;
  const montant = Math.abs(Number(brute.amount));
  if (!Number.isFinite(montant) || montant === 0) return null;
  const id = String(brute.id);
  const { tiers, numero } = extraireTiersEtNumero(brute.label, id, libelleGeneriqueTiers);
  return {
    pennylaneId: id,
    facture: brute.invoice_number || numero,
    tiers,
    montant,
    dateEcheance: brute.deadline ?? brute.date ?? "",
    payee: decision.payee,
    motifSolde: decision.motifSolde,
  };
}

/** Retourne null pour un brouillon ou un avoir : ni l'un ni l'autre n'est importé en V1. */
export function candidatFactureClient(item: PennylaneCustomerInvoiceListItem): CandidatFacturePennylane | null {
  if (item.draft) return null;
  return candidatDepuisFactureBrute(item, "Client Pennylane", decisionPaiementClient(item));
}

/** Pas de notion de brouillon côté factures fournisseurs (jamais observée dans l'API). */
export function candidatFactureFournisseur(item: PennylaneSupplierInvoiceListItem): CandidatFacturePennylane | null {
  const candidat = candidatDepuisFactureBrute(item, "Fournisseur Pennylane", decisionPaiementFournisseur(item));
  return candidat && estArchiveeFournisseur(item) ? { ...candidat, aRetirer: true } : candidat;
}

export interface CandidatsPennylane {
  candidats: CandidatFacturePennylane[];
  // Statuts de paiement inconnus rencontrés, avec leur nombre d'occurrences : à journaliser.
  statutsInconnus: Record<string, number>;
}

/**
 * Toutes les factures fournisseurs d'une réponse Pennylane -> candidats Novanta. Chaque objet
 * Pennylane est traité pour lui-même, par son identifiant : deux versions d'un même numéro ne sont
 * jamais départagées ici.
 */
export function candidatsFournisseursPennylane(items: PennylaneSupplierInvoiceListItem[]): CandidatsPennylane {
  const candidats: CandidatFacturePennylane[] = [];
  const statutsInconnus: Record<string, number> = {};
  for (const item of items) {
    const { statutInconnu } = decisionPaiementFournisseur(item);
    if (statutInconnu) statutsInconnus[statutInconnu] = (statutsInconnus[statutInconnu] ?? 0) + 1;
    const candidat = candidatFactureFournisseur(item);
    if (candidat) candidats.push(candidat);
  }
  return { candidats, statutsInconnus };
}

/** Toutes les factures clients d'une réponse Pennylane -> candidats Novanta. */
export function candidatsClientsPennylane(items: PennylaneCustomerInvoiceListItem[]): CandidatsPennylane {
  const candidats: CandidatFacturePennylane[] = [];
  for (const item of items) {
    const candidat = candidatFactureClient(item);
    if (candidat) candidats.push(candidat);
  }
  return { candidats, statutsInconnus: {} };
}

/** Facture Novanta existante, réduite aux seuls champs nécessaires au calcul de synchronisation. */
export interface FactureExistantePourSync {
  id: string; // id Novanta (jamais l'id Pennylane)
  pennylaneId?: string | null;
  payee: boolean;
}

export interface ResultatCalculSynchronisation {
  aInserer: CandidatFacturePennylane[];
  idsAMettreAJourPayee: string[]; // ids NOVANTA (pas pennylaneId) à patcher payee=true
  idsASupprimer: string[]; // ids NOVANTA dont la version Pennylane est archivée
}

/**
 * Cœur de l'algorithme de synchronisation (voir diagnostic §12) :
 *   - candidat archivé dans Pennylane (aRetirer) -> jamais importé ; déjà connu, il est SUPPRIMÉ de
 *     Novanta, payé ou non : une version archivée n'est plus une facture de trésorerie ;
 *   - candidat absent de Novanta, non payée -> INSERT ;
 *   - candidat absent de Novanta, déjà payée -> jamais importée (règle produit A : on ne récupère
 *     que les factures ouvertes) ;
 *   - candidat déjà connu (même pennylaneId), Pennylane payée ET Novanta encore non payée ->
 *     marquer Payée=true ;
 *   - tout le reste (déjà payée des deux côtés, encore non payée des deux côtés) -> NO-OP.
 * Ne renvoie JAMAIS un id à repasser à false : cette fonction ne lit `existante.payee` que pour
 * décider si une MISE À JOUR vers true est nécessaire, jamais pour en proposer une vers false —
 * la règle absolue "jamais Payée true -> false" est donc garantie par construction, pas seulement
 * par convention d'appel.
 * Idempotente par construction : ré-appliquer avec les mêmes candidats sur un état Novanta déjà
 * synchronisé renvoie aInserer=[], idsAMettreAJourPayee=[] et idsASupprimer=[].
 */
export function calculerSynchronisation(
  candidats: CandidatFacturePennylane[],
  facturesExistantes: FactureExistantePourSync[]
): ResultatCalculSynchronisation {
  const existanteParPennylaneId = new Map<string, FactureExistantePourSync>();
  for (const facture of facturesExistantes) {
    if (facture.pennylaneId) existanteParPennylaneId.set(facture.pennylaneId, facture);
  }

  const aInserer: CandidatFacturePennylane[] = [];
  const idsAMettreAJourPayee: string[] = [];
  const idsASupprimer: string[] = [];

  for (const candidat of candidats) {
    const existante = existanteParPennylaneId.get(candidat.pennylaneId);

    if (candidat.aRetirer) {
      if (existante) idsASupprimer.push(existante.id);
      continue;
    }

    if (!existante) {
      if (!candidat.payee) aInserer.push(candidat);
      continue;
    }

    if (candidat.payee && !existante.payee) {
      idsAMettreAJourPayee.push(existante.id);
    }
  }

  return { aInserer, idsAMettreAJourPayee, idsASupprimer };
}

/**
 * Convertit un candidat retenu pour insertion en FactureClient Novanta complète, prête pour
 * lib/supabaseRepository.ts::importerFacturesClients (même fonction que l'import manuel, voir
 * app/page.tsx::handleImporterFactures). dateEncaissementAnticipee (date prévue, propre à
 * Novanta) est initialisée à l'échéance Pennylane faute de meilleure source — l'utilisateur peut
 * l'éditer ensuite normalement, une synchronisation ultérieure ne la touchera plus jamais (seul
 * `payee` est mis à jour pour une facture déjà connue, voir calculerSynchronisation).
 */
export function candidatVersFactureClient(candidat: CandidatFacturePennylane): FactureClient {
  return {
    id: crypto.randomUUID(),
    facture: candidat.facture,
    client: candidat.tiers,
    montant: candidat.montant,
    dateEcheance: candidat.dateEcheance,
    dateEncaissementAnticipee: candidat.dateEcheance,
    litigieuse: false,
    payee: false,
    paidAt: null,
    pennylaneId: candidat.pennylaneId,
  };
}

/** Voir candidatVersFactureClient — même rôle côté factures fournisseurs. */
export function candidatVersFactureFournisseur(candidat: CandidatFacturePennylane): FactureFournisseur {
  return {
    id: crypto.randomUUID(),
    facture: candidat.facture,
    fournisseur: candidat.tiers,
    montant: candidat.montant,
    dateEcheance: candidat.dateEcheance,
    datePaiementPrevue: candidat.dateEcheance,
    litigieuse: false,
    payee: false,
    paidAt: null,
    pennylaneId: candidat.pennylaneId,
  };
}
