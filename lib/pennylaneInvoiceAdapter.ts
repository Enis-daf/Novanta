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
  return `Pennylane synchronisé — Fournisseurs : ${fournisseurs}. Clients : ${clients}. ${payees} au total.`;
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

/** Candidat générique (client ou fournisseur) prêt à être comparé à l'existant Novanta. */
export interface CandidatFacturePennylane {
  pennylaneId: string;
  facture: string; // numéro
  tiers: string; // nom du client ou du fournisseur
  montant: number; // toujours positif — le sens (entrée/sortie) est déterminé par le type, jamais ici
  dateEcheance: string; // YYYY-MM-DD, "" si Pennylane n'en fournit aucune
  payee: boolean;
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
 * forme minimale pour les deux, voir FactureBrutePennylane). `paid` (booléen renvoyé directement
 * par l'API) est la SEULE source du statut de paiement retenue : les deux types de facture ont des
 * vocabulaires de statut textuel différents et non garantis alignés, `paid` est le seul champ dont
 * la sémantique ("soldée ou non") est commune et sans ambiguïté aux deux.
 */
function candidatDepuisFactureBrute(
  brute: FactureBrutePennylane,
  libelleGeneriqueTiers: string
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
    payee: brute.paid === true,
  };
}

/** Retourne null pour un brouillon ou un avoir : ni l'un ni l'autre n'est importé en V1. */
export function candidatFactureClient(item: PennylaneCustomerInvoiceListItem): CandidatFacturePennylane | null {
  if (item.draft) return null;
  return candidatDepuisFactureBrute(item, "Client Pennylane");
}

/** Pas de notion de brouillon côté factures fournisseurs (jamais observée dans l'API). */
export function candidatFactureFournisseur(item: PennylaneSupplierInvoiceListItem): CandidatFacturePennylane | null {
  return candidatDepuisFactureBrute(item, "Fournisseur Pennylane");
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
}

/**
 * Cœur de l'algorithme de synchronisation (voir diagnostic §12) :
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
 * synchronisé renvoie aInserer=[] et idsAMettreAJourPayee=[].
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

  for (const candidat of candidats) {
    const existante = existanteParPennylaneId.get(candidat.pennylaneId);

    if (!existante) {
      if (!candidat.payee) aInserer.push(candidat);
      continue;
    }

    if (candidat.payee && !existante.payee) {
      idsAMettreAJourPayee.push(existante.id);
    }
  }

  return { aInserer, idsAMettreAJourPayee };
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
