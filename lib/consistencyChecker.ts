import { decalerDateISO, parseDateISO, todayISO } from "./dates";
import { NormalizedBankTransaction } from "./bankTransaction";
import { AutreDepense, FactureClient, FactureFournisseur, Financement } from "./types";

/**
 * ConsistencyChecker : signale les écarts potentiels entre les données Novanta et un historique
 * bancaire récent. Ne dépend QUE de NormalizedBankTransaction[] — jamais du XLSX ni d'aucune autre
 * source (voir bankTransaction.ts) — pour rester réutilisable tel quel par une future source
 * Pennylane : XlsxBankTransactionAdapter et un futur PennylaneTransactionAdapter produiraient tous
 * deux le même NormalizedBankTransaction[], consommé ici sans aucune modification.
 *
 * Ce n'est PAS un rapprochement bancaire exhaustif : le moteur détecte des écarts probables,
 * l'utilisateur valide, Novanta modifie — jamais l'inverse. Aucune modification n'est faite ici ;
 * ce module ne fait que produire une liste de ConsistencyIssue, purement.
 *
 * Déterministe, sans IA, sans score numérique visible (uniquement 3 niveaux internes simples).
 */

export type ConsistencyIssueType =
  | "invoice_maybe_paid"
  | "invoice_paid_but_unmatched"
  | "other_expense_maybe_invoiced"
  | "other_expense_invoiced_but_missing_invoice"
  | "financing_maybe_received"
  | "financing_received_but_unmatched"
  | "bank_duplicate_candidate";

/** Niveaux internes uniquement — jamais affichés comme un pourcentage ou un score. */
export type ConsistencySeverity = "strong" | "possible" | "informational";

export type ConsistencyEntityType =
  | "facture_client"
  | "facture_fournisseur"
  | "autre_depense"
  | "financement"
  | "transaction_bancaire";

export interface ConsistencyIssueTransaction {
  date: string; // YYYY-MM-DD
  montant: number; // signé, tel que dans le relevé
  libelle: string; // labelOriginal — jamais un libellé nettoyé, pour rester fidèle à ce que l'utilisateur peut vérifier
}

export interface ConsistencyIssue {
  id: string; // stable pour une session donnée — clé React et identifiant d'ignorance locale
  type: ConsistencyIssueType;
  severity: ConsistencySeverity;
  entityType: ConsistencyEntityType;
  entityId: string | null; // null pour un doublon bancaire (aucune entité Novanta concernée)
  transactions: ConsistencyIssueTransaction[]; // transaction(s) bancaire(s) correspondante(s), le cas échéant
  message: string; // phrase utilisateur complète, prête à afficher
  raison: string; // explication courte du rapprochement (jamais un pourcentage)
  actionPossible: { label: string } | null; // null = aucune action proposée (signal informationnel uniquement)
  donneesAffichage: { libelle: string; montant: number; date: string | null }; // la ligne Novanta (ou bancaire pour un doublon)
}

// 30 jours calendaires glissants, bornes incluses : pour une analyse le 31/08, la fenêtre commence
// le 02/08 inclus (31 - 29 = 2) — soit exactement 30 jours au total (02/08 → 31/08 inclus).
const FENETRE_JOURS = 30;

export function filtrerTransactionsRecentes(
  transactions: NormalizedBankTransaction[],
  dateReference: string
): NormalizedBankTransaction[] {
  const debut = decalerDateISO(dateReference, -(FENETRE_JOURS - 1));
  return transactions.filter((t) => t.date >= debut && t.date <= dateReference);
}

// Tolérance de montant volontairement faible et fixe (pas un pourcentage comme pour les charges
// récurrentes) : un rapprochement de facture doit être précis, pas juste "du même ordre de grandeur".
const TOLERANCE_MONTANT_EUR = 2;

function montantsCompatibles(a: number, b: number): boolean {
  return Math.abs(Math.abs(a) - Math.abs(b)) <= TOLERANCE_MONTANT_EUR;
}

/** Normalisation légère dédiée au rapprochement : PAS de retrait des références techniques (on les cherche activement ici). */
function normaliserTexteRapprochement(texte: string): string {
  return texte
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Référence collée sans espaces/ponctuation, pour tolérer "FA2607-0077" vs "FA2607 0077" vs "FA26070077". */
function normaliserReferenceRapprochement(texte: string): string {
  return normaliserTexteRapprochement(texte).replace(/\s+/g, "");
}

const LONGUEUR_MIN_REFERENCE = 4;

/** Une référence de facture (numéro) est retrouvée telle quelle dans le libellé bancaire brut. */
function referenceTrouveeDansLibelle(labelOriginal: string, reference: string): boolean {
  const ref = normaliserReferenceRapprochement(reference);
  if (ref.length < LONGUEUR_MIN_REFERENCE) return false; // trop court pour être fiable, évite les faux positifs
  return normaliserReferenceRapprochement(labelOriginal).includes(ref);
}

/**
 * Un tiers (ou un libellé Novanta) est jugé "suffisamment similaire" à un texte bancaire si
 * STRICTEMENT PLUS de la moitié de ses tokens significatifs (longueur ≥ 2) s'y retrouvent tels
 * quels — tolère un tiers enregistré différemment ("Noxbat" vs "VIR NOXBAT FA2607-0077") sans
 * jamais fusionner deux tiers différents partageant un seul mot générique en commun (ex:
 * "Fournisseur Alpha" et "Fournisseur Beta" partagent "FOURNISSEUR" mais pas plus — aucun des deux
 * n'atteint la majorité stricte sur ce seul mot).
 */
function libellesSuffisammentSimilaires(texteA: string, texteB: string): boolean {
  const tokensA = normaliserTexteRapprochement(texteA)
    .split(" ")
    .filter((t) => t.length >= 2);
  if (tokensA.length === 0) return false;
  const tokensB = new Set(normaliserTexteRapprochement(texteB).split(" "));
  const trouves = tokensA.filter((t) => tokensB.has(t)).length;
  return trouves > 0 && trouves / tokensA.length > 0.5;
}

const TOLERANCE_JOURS_DATE = 20;

function dateCoherente(dateTransaction: string, dateAttendue: string | null): boolean {
  if (!dateAttendue) return true; // pas de date de référence fiable : ne pas rejeter sur ce seul critère
  const ecart = Math.abs(
    (parseDateISO(dateTransaction).getTime() - parseDateISO(dateAttendue).getTime()) / 86400000
  );
  return ecart <= TOLERANCE_JOURS_DATE;
}

type NiveauCorrespondance = "tres_fort" | "fort" | "possible";

interface Correspondance {
  transaction: NormalizedBankTransaction;
  niveau: NiveauCorrespondance;
  raison: string;
}

/**
 * Cherche, parmi les transactions fournies, la MEILLEURE correspondance pour un montant/tiers/
 * référence/date attendus — jamais uniquement sur le montant (voir hiérarchie dans le module).
 */
function meilleureCorrespondance(
  transactionsCandidates: NormalizedBankTransaction[],
  montantAttendu: number,
  tiers: string,
  reference: string | null,
  dateAttendue: string | null
): Correspondance | null {
  const ordre: Record<NiveauCorrespondance, number> = { tres_fort: 3, fort: 2, possible: 1 };
  let meilleure: Correspondance | null = null;

  for (const transaction of transactionsCandidates) {
    if (!montantsCompatibles(transaction.signedAmount, montantAttendu)) continue;

    const refOk = !!reference && referenceTrouveeDansLibelle(transaction.labelOriginal, reference);
    let candidate: Correspondance;
    if (refOk) {
      candidate = { transaction, niveau: "tres_fort", raison: "Numéro de facture retrouvé dans le libellé bancaire." };
    } else {
      const tiersOk = libellesSuffisammentSimilaires(tiers, transaction.labelOriginal);
      if (!tiersOk) continue;
      const dateOk = dateCoherente(transaction.date, dateAttendue);
      candidate = dateOk
        ? { transaction, niveau: "fort", raison: "Tiers similaire et date cohérente avec le mouvement bancaire." }
        : { transaction, niveau: "possible", raison: "Tiers similaire retrouvé dans le libellé bancaire." };
    }

    if (!meilleure || ordre[candidate.niveau] > ordre[meilleure.niveau]) meilleure = candidate;
  }

  return meilleure;
}

function versConsistencyIssueTransaction(t: NormalizedBankTransaction): ConsistencyIssueTransaction {
  return { date: t.date, montant: t.signedAmount, libelle: t.labelOriginal };
}

const SEVERITE_PAR_NIVEAU: Record<NiveauCorrespondance, ConsistencySeverity> = {
  tres_fort: "strong",
  fort: "strong",
  possible: "possible",
};

// --------------------------------------------------------------------------------------------
// Factures clients / fournisseurs non payées : le contrôle le plus important.
// --------------------------------------------------------------------------------------------

function controlerFacturesFournisseurs(
  factures: FactureFournisseur[],
  transactionsRecentes: NormalizedBankTransaction[]
): ConsistencyIssue[] {
  const debits = transactionsRecentes.filter((t) => t.signedAmount < 0);
  const issues: ConsistencyIssue[] = [];

  for (const facture of factures) {
    if (facture.payee) continue;
    const correspondance = meilleureCorrespondance(
      debits,
      -Math.abs(facture.montant),
      facture.fournisseur,
      facture.facture,
      facture.datePaiementPrevue || facture.dateEcheance || null
    );
    if (!correspondance) continue;

    issues.push({
      id: `invoice_maybe_paid:facture_fournisseur:${facture.id}`,
      type: "invoice_maybe_paid",
      severity: SEVERITE_PAR_NIVEAU[correspondance.niveau],
      entityType: "facture_fournisseur",
      entityId: facture.id,
      transactions: [versConsistencyIssueTransaction(correspondance.transaction)],
      message: `Facture potentiellement déjà payée : ${facture.fournisseur} — ${facture.facture || "sans référence"}.`,
      raison: correspondance.raison,
      actionPossible: { label: "Marquer comme Payée" },
      donneesAffichage: { libelle: `${facture.fournisseur} — ${facture.facture}`, montant: facture.montant, date: facture.dateEcheance || null },
    });
  }

  return issues;
}

function controlerFacturesClients(
  factures: FactureClient[],
  transactionsRecentes: NormalizedBankTransaction[]
): ConsistencyIssue[] {
  const credits = transactionsRecentes.filter((t) => t.signedAmount > 0);
  const issues: ConsistencyIssue[] = [];

  for (const facture of factures) {
    if (facture.payee) continue;
    const correspondance = meilleureCorrespondance(
      credits,
      Math.abs(facture.montant),
      facture.client,
      facture.facture,
      facture.dateEncaissementAnticipee || facture.dateEcheance || null
    );
    if (!correspondance) continue;

    issues.push({
      id: `invoice_maybe_paid:facture_client:${facture.id}`,
      type: "invoice_maybe_paid",
      severity: SEVERITE_PAR_NIVEAU[correspondance.niveau],
      entityType: "facture_client",
      entityId: facture.id,
      transactions: [versConsistencyIssueTransaction(correspondance.transaction)],
      message: `Facture potentiellement déjà encaissée : ${facture.client} — ${facture.facture || "sans référence"}.`,
      raison: correspondance.raison,
      actionPossible: { label: "Marquer comme Payée" },
      donneesAffichage: { libelle: `${facture.client} — ${facture.facture}`, montant: facture.montant, date: facture.dateEcheance || null },
    });
  }

  return issues;
}

/**
 * Factures marquées Payée = true récemment échues : l'ABSENCE de mouvement ne prouve rien (le
 * paiement peut être antérieur à la fenêtre, sur un autre compte, groupé, ou libellé différemment)
 * — signal informationnel uniquement, jamais présenté comme une erreur certaine, jamais d'action.
 */
function controlerFacturesPayeesSansMouvement(
  facturesClients: FactureClient[],
  facturesFournisseurs: FactureFournisseur[],
  transactionsRecentes: NormalizedBankTransaction[],
  dateReference: string
): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const debits = transactionsRecentes.filter((t) => t.signedAmount < 0);
  const credits = transactionsRecentes.filter((t) => t.signedAmount > 0);

  const fenetreDebut = decalerDateISO(dateReference, -(FENETRE_JOURS - 1));

  for (const facture of facturesFournisseurs) {
    if (!facture.payee || !facture.paidAt) continue;
    const paidAtDate = facture.paidAt.slice(0, 10);
    if (paidAtDate < fenetreDebut || paidAtDate > dateReference) continue; // coché hors fenêtre : rien à vérifier ici
    const correspondance = meilleureCorrespondance(debits, -Math.abs(facture.montant), facture.fournisseur, facture.facture, null);
    if (correspondance) continue;

    issues.push({
      id: `invoice_paid_but_unmatched:facture_fournisseur:${facture.id}`,
      type: "invoice_paid_but_unmatched",
      severity: "informational",
      entityType: "facture_fournisseur",
      entityId: facture.id,
      transactions: [],
      message: `Cette facture (${facture.fournisseur} — ${facture.facture}) est marquée Payée dans Novanta, mais aucun mouvement correspondant n'a été trouvé dans les 30 derniers jours.`,
      raison: "Absence de mouvement bancaire correspondant sur la période analysée (ne prouve rien à elle seule).",
      actionPossible: null,
      donneesAffichage: { libelle: `${facture.fournisseur} — ${facture.facture}`, montant: facture.montant, date: facture.dateEcheance || null },
    });
  }

  for (const facture of facturesClients) {
    if (!facture.payee || !facture.paidAt) continue;
    const paidAtDate = facture.paidAt.slice(0, 10);
    if (paidAtDate < fenetreDebut || paidAtDate > dateReference) continue;
    const correspondance = meilleureCorrespondance(credits, Math.abs(facture.montant), facture.client, facture.facture, null);
    if (correspondance) continue;

    issues.push({
      id: `invoice_paid_but_unmatched:facture_client:${facture.id}`,
      type: "invoice_paid_but_unmatched",
      severity: "informational",
      entityType: "facture_client",
      entityId: facture.id,
      transactions: [],
      message: `Cette facture (${facture.client} — ${facture.facture}) est marquée Payée dans Novanta, mais aucun mouvement correspondant n'a été trouvé dans les 30 derniers jours.`,
      raison: "Absence de mouvement bancaire correspondant sur la période analysée (ne prouve rien à elle seule).",
      actionPossible: null,
      donneesAffichage: { libelle: `${facture.client} — ${facture.facture}`, montant: facture.montant, date: facture.dateEcheance || null },
    });
  }

  return issues;
}

// --------------------------------------------------------------------------------------------
// Autres dépenses : cohérence interne avec les factures fournisseurs (pas de données bancaires).
// --------------------------------------------------------------------------------------------

function controlerAutresDepenses(depenses: AutreDepense[], facturesFournisseurs: FactureFournisseur[]): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];

  for (const depense of depenses) {
    const factureCorrespondante = facturesFournisseurs.find(
      (f) => montantsCompatibles(f.montant, depense.montant) && libellesSuffisammentSimilaires(depense.libelle, f.fournisseur)
    );

    if (!depense.facturee && factureCorrespondante) {
      issues.push({
        id: `other_expense_maybe_invoiced:${depense.id}`,
        type: "other_expense_maybe_invoiced",
        severity: "possible",
        entityType: "autre_depense",
        entityId: depense.id,
        transactions: [],
        message: `Cette dépense (${depense.libelle}) semble déjà avoir une facture fournisseur (${factureCorrespondante.fournisseur} — ${factureCorrespondante.facture}).`,
        raison: "Montant et fournisseur compatibles avec une facture fournisseur existante.",
        actionPossible: { label: "Marquer comme Facturée" },
        donneesAffichage: { libelle: depense.libelle, montant: depense.montant, date: depense.datePrevue || null },
      });
    }

    if (depense.facturee && !factureCorrespondante) {
      issues.push({
        id: `other_expense_invoiced_but_missing_invoice:${depense.id}`,
        type: "other_expense_invoiced_but_missing_invoice",
        severity: "informational",
        entityType: "autre_depense",
        entityId: depense.id,
        transactions: [],
        message: `Cette dépense (${depense.libelle}) est marquée Facturée, mais aucune facture fournisseur correspondante n'a été trouvée.`,
        raison: "Aucune facture fournisseur de montant et de tiers compatibles dans Novanta.",
        actionPossible: null,
        donneesAffichage: { libelle: depense.libelle, montant: depense.montant, date: depense.datePrevue || null },
      });
    }
  }

  return issues;
}

// --------------------------------------------------------------------------------------------
// Financements : Versé = false (crédit trouvé) / Versé = true (aucun crédit récent, signal faible).
// --------------------------------------------------------------------------------------------

function controlerFinancements(
  financements: Financement[],
  transactionsRecentes: NormalizedBankTransaction[],
  dateReference: string
): ConsistencyIssue[] {
  const credits = transactionsRecentes.filter((t) => t.signedAmount > 0);
  const issues: ConsistencyIssue[] = [];
  const fenetreDebut = decalerDateISO(dateReference, -(FENETRE_JOURS - 1));

  for (const financement of financements) {
    if (!financement.verse) {
      const correspondance = meilleureCorrespondance(
        credits,
        Math.abs(financement.montant),
        financement.libelle,
        null,
        financement.dateEncaissementPrevue || null
      );
      if (!correspondance) continue;

      issues.push({
        id: `financing_maybe_received:${financement.id}`,
        type: "financing_maybe_received",
        severity: SEVERITE_PAR_NIVEAU[correspondance.niveau],
        entityType: "financement",
        entityId: financement.id,
        transactions: [versConsistencyIssueTransaction(correspondance.transaction)],
        message: `Ce financement (${financement.libelle}) semble avoir été versé.`,
        raison: correspondance.raison,
        actionPossible: { label: "Marquer comme Versé" },
        donneesAffichage: { libelle: financement.libelle, montant: financement.montant, date: financement.dateEncaissementPrevue || null },
      });
      continue;
    }

    // Versé = true : l'absence de crédit récent ne prouve rien (versement antérieur à la fenêtre,
    // autre compte...) — uniquement si la date prévue tombe dans la fenêtre analysée, sinon hors sujet.
    if (
      financement.dateEncaissementPrevue &&
      financement.dateEncaissementPrevue >= fenetreDebut &&
      financement.dateEncaissementPrevue <= dateReference
    ) {
      const correspondance = meilleureCorrespondance(credits, Math.abs(financement.montant), financement.libelle, null, null);
      if (correspondance) continue;

      issues.push({
        id: `financing_received_but_unmatched:${financement.id}`,
        type: "financing_received_but_unmatched",
        severity: "informational",
        entityType: "financement",
        entityId: financement.id,
        transactions: [],
        message: `Ce financement (${financement.libelle}) est marqué Versé, mais aucun crédit correspondant n'a été trouvé dans les 30 derniers jours.`,
        raison: "Absence de crédit bancaire correspondant sur la période analysée (ne prouve rien à elle seule).",
        actionPossible: null,
        donneesAffichage: { libelle: financement.libelle, montant: financement.montant, date: financement.dateEncaissementPrevue || null },
      });
    }
  }

  return issues;
}

// --------------------------------------------------------------------------------------------
// Doublons bancaires potentiels : même date EXACTE + même montant + même libellé normalisé.
// Un abonnement mensuel ou un salaire (même libellé, mois différents) n'est jamais un doublon ici,
// puisque la date doit être strictement identique.
// --------------------------------------------------------------------------------------------

function controlerDoublonsBancaires(transactionsRecentes: NormalizedBankTransaction[]): ConsistencyIssue[] {
  const groupes = new Map<string, NormalizedBankTransaction[]>();
  for (const t of transactionsRecentes) {
    const cle = `${t.date}|${t.signedAmount}|${t.labelNormalized}`;
    const liste = groupes.get(cle) ?? [];
    liste.push(t);
    groupes.set(cle, liste);
  }

  const issues: ConsistencyIssue[] = [];
  for (const [cle, transactions] of groupes) {
    if (transactions.length < 2) continue;
    const [premiere] = transactions;
    issues.push({
      id: `bank_duplicate_candidate:${cle}`,
      type: "bank_duplicate_candidate",
      severity: "possible",
      entityType: "transaction_bancaire",
      entityId: null,
      transactions: transactions.map(versConsistencyIssueTransaction),
      message: `${transactions.length} mouvements identiques trouvés le même jour (${premiere.labelOriginal}).`,
      raison: "Même date, même montant et même libellé normalisé.",
      actionPossible: null,
      donneesAffichage: { libelle: premiere.labelOriginal, montant: premiere.signedAmount, date: premiere.date },
    });
  }

  return issues;
}

// --------------------------------------------------------------------------------------------

export interface ParametresControleCoherence {
  transactions: NormalizedBankTransaction[]; // brutes (toute la période du fichier) — le moteur filtre lui-même J-30
  facturesClients: FactureClient[];
  facturesFournisseurs: FactureFournisseur[];
  autresDepenses: AutreDepense[];
  financements: Financement[];
  dateReference?: string; // YYYY-MM-DD ; par défaut aujourd'hui — paramétrable pour des tests déterministes
}

export interface ResultatControleCoherence {
  issues: ConsistencyIssue[];
  totalTransactions: number; // dans le fichier entier, toutes dates confondues
  transactionsAnalysees: number; // sous-ensemble effectivement analysé (fenêtre 30 jours)
  periodeAnalysee: { debut: string; fin: string } | null;
}

/**
 * Point d'entrée principal, pur : aucune donnée bancaire brute n'est stockée ni journalisée par
 * cette fonction — elle reçoit un tableau en mémoire et retourne une liste d'issues, un point
 * c'est tout. C'est à l'appelant (composant React) de ne jamais persister les transactions.
 */
export function controlerCoherence(params: ParametresControleCoherence): ResultatControleCoherence {
  const dateReference = params.dateReference ?? todayISO();
  const transactionsRecentes = filtrerTransactionsRecentes(params.transactions, dateReference);

  const issues: ConsistencyIssue[] = [
    ...controlerFacturesFournisseurs(params.facturesFournisseurs, transactionsRecentes),
    ...controlerFacturesClients(params.facturesClients, transactionsRecentes),
    ...controlerFacturesPayeesSansMouvement(
      params.facturesClients,
      params.facturesFournisseurs,
      transactionsRecentes,
      dateReference
    ),
    ...controlerAutresDepenses(params.autresDepenses, params.facturesFournisseurs),
    ...controlerFinancements(params.financements, transactionsRecentes, dateReference),
    ...controlerDoublonsBancaires(transactionsRecentes),
  ];

  return {
    issues,
    totalTransactions: params.transactions.length,
    transactionsAnalysees: transactionsRecentes.length,
    periodeAnalysee:
      transactionsRecentes.length > 0
        ? { debut: decalerDateISO(dateReference, -(FENETRE_JOURS - 1)), fin: dateReference }
        : null,
  };
}
