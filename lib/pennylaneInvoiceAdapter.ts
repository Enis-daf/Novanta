/**
 * Adapte les factures Pennylane (clients + fournisseurs) au modèle Novanta, et calcule la
 * synchronisation à appliquer — pur, sans effet de bord, sans appel réseau (voir
 * lib/pennylaneClient.ts pour les appels HTTP, app/api/pennylane/invoices/route.ts pour
 * l'orchestration serveur, app/page.tsx pour l'écriture Supabase côté client).
 *
 * Aucune règle ici n'est devinée : chaque décision renvoie au diagnostic vérifié empiriquement
 * contre l'API Pennylane v2 réelle (voir le rapport livré avant implémentation).
 */
import {
  PennylaneCustomerInvoiceDetail,
  PennylaneSupplierInvoiceListItem,
} from "./pennylaneClient";
import { FactureClient, FactureFournisseur } from "./types";

/**
 * Statuts Pennylane considérés comme "définitivement payée" côté Novanta. Volontairement
 * restreint aux deux états TERMINAUX confirmés par l'énumération réelle de l'API
 * (to_be_processed, to_be_paid, partially_paid, payment_error, payment_scheduled,
 * payment_in_progress, payment_emitted, payment_found, paid_offline, fully_paid) : un paiement
 * partiel ou en cours (payment_found, payment_emitted...) reste "non payée" côté Novanta — mieux
 * vaut détecter un paiement un cycle de synchro plus tard que marquer Payée à tort, cohérent avec
 * la règle absolue "jamais Payée true -> false".
 */
const STATUTS_PENNYLANE_PAYEE: ReadonlySet<string> = new Set(["fully_paid", "paid_offline"]);

export function pennylanePayee(paymentStatus: string): boolean {
  return STATUTS_PENNYLANE_PAYEE.has(paymentStatus);
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

/**
 * Construit un candidat "facture client" à partir du DÉTAIL Pennylane (seule source de
 * payment_status pour les factures clients — voir lib/pennylaneClient.ts). Retourne null pour
 * un brouillon ou un avoir : ni l'un ni l'autre n'est importé en V1.
 */
export function candidatFactureClient(detail: PennylaneCustomerInvoiceDetail): CandidatFacturePennylane | null {
  if (detail.draft) return null;
  if (estAvoir(detail.amount)) return null;
  const montant = Math.abs(Number(detail.amount));
  if (!Number.isFinite(montant) || montant === 0) return null;
  return {
    pennylaneId: String(detail.id),
    facture: detail.number ?? String(detail.id),
    tiers: detail.customer_name || "Client Pennylane",
    montant,
    dateEcheance: detail.deadline ?? detail.date ?? "",
    payee: pennylanePayee(detail.payment_status),
  };
}

// Format observé sur des libellés réels Pennylane :
//   "Facture SOCIETE D'EXPLOITATION EOLIENNE ANGRIE - FA2609-0090 (label généré)"
//   "Avoir EOLIA - AV2607-0006 (label généré)"
//   "Facture AMAZON - INV-407-1429953-4000307(2) (label généré)"
//   "Facture - 2026-3080464 (label généré)"                        (nom du tiers absent)
// Le nom du tiers peut donc être vide, et le suffixe "(label généré)" n'est pas garanti présent
// (un libellé personnalisé dans Pennylane n'a aucune raison de le porter). Best-effort : si le
// motif ne correspond pas du tout, on retombe sur le libellé complet plutôt que d'échouer.
const MOTIF_LABEL_FACTURE = /^(?:Facture|Avoir)\s*(.*?)\s*-\s*(.+?)(?:\s*\(label généré\))?$/;

export function extraireTiersEtNumero(label: string | null, idFallback: string): { tiers: string; numero: string } {
  if (!label) return { tiers: "Fournisseur Pennylane", numero: idFallback };
  const correspondance = label.match(MOTIF_LABEL_FACTURE);
  if (!correspondance) return { tiers: label, numero: idFallback };
  const tiers = correspondance[1].trim();
  const numero = correspondance[2].trim();
  return {
    tiers: tiers || "Fournisseur Pennylane",
    numero: numero || idFallback,
  };
}

/**
 * Construit un candidat "facture fournisseur" directement depuis la LISTE Pennylane —
 * payment_status y est déjà présent, aucun appel détail nécessaire (voir lib/pennylaneClient.ts).
 * Le nom du fournisseur et le numéro sont extraits du libellé (best-effort, voir
 * extraireTiersEtNumero) : la liste ne fournit pas de champ fournisseur/numéro séparé.
 */
export function candidatFactureFournisseur(item: PennylaneSupplierInvoiceListItem): CandidatFacturePennylane | null {
  if (estAvoir(item.amount)) return null;
  const montant = Math.abs(Number(item.amount));
  if (!Number.isFinite(montant) || montant === 0) return null;
  const id = String(item.id);
  const { tiers, numero } = extraireTiersEtNumero(item.label, id);
  return {
    pennylaneId: id,
    facture: numero,
    tiers,
    montant,
    dateEcheance: item.deadline ?? item.date ?? "",
    payee: pennylanePayee(item.payment_status),
  };
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
