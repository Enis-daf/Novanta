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
  | "other_expense_maybe_paid"
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
 * Extrait le suffixe numérique discriminant d'une référence de facture ("FA2607-0070" -> "0070") :
 * le dernier bloc de la référence, si c'est un bloc purement numérique d'au moins
 * LONGUEUR_MIN_REFERENCE chiffres. Les banques retirent souvent le préfixe ("FA"), les tirets, et
 * ne conservent que la fin du numéro — ce suffixe reste le signal le plus discriminant disponible.
 * null si la référence n'a pas de suffixe numérique exploitable (évite les faux positifs sur des
 * références trop courtes ou non numériques).
 */
function extraireSuffixeReference(reference: string): string | null {
  const tokens = normaliserTexteRapprochement(reference).split(" ").filter(Boolean);
  const dernier = tokens[tokens.length - 1];
  if (dernier && /^\d+$/.test(dernier) && dernier.length >= LONGUEUR_MIN_REFERENCE) return dernier;
  return null;
}

/** Le suffixe est retrouvé comme TOKEN ENTIER du libellé bancaire (pas une simple sous-chaîne : évite
 * qu'un suffixe de 4 chiffres matche par coïncidence à l'intérieur d'un plus grand nombre non lié,
 * comme une date bancaire "060726"). */
function suffixeTrouveDansLibelle(labelOriginal: string, suffixe: string): boolean {
  return new Set(normaliserTexteRapprochement(labelOriginal).split(" ")).has(suffixe);
}

const LONGUEUR_MIN_TOKEN_TIERS_LEGER = 3;

/**
 * Version faible de la comparaison de tiers : au moins UN token significatif (longueur ≥ 3) du
 * tiers Novanta se retrouve dans le libellé bancaire. Volontairement plus permissif que
 * libellesSuffisammentSimilaires — jamais utilisé seul comme preuve de rapprochement, uniquement
 * combiné à un autre signal fort (suffixe de référence, ou agrégation de montants).
 */
function auMoinsUnTokenTiersTrouve(tiers: string, labelOriginal: string): boolean {
  const tokensTiers = normaliserTexteRapprochement(tiers)
    .split(" ")
    .filter((t) => t.length >= LONGUEUR_MIN_TOKEN_TIERS_LEGER);
  if (tokensTiers.length === 0) return false;
  const tokensBanque = new Set(normaliserTexteRapprochement(labelOriginal).split(" "));
  return tokensTiers.some((t) => tokensBanque.has(t));
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

// EXACT/TRÈS FORT : référence complète retrouvée. FORT : tiers fortement compatible (majorité
// stricte des tokens), ou référence partielle (suffixe discriminant) + tiers léger. AGRÉGÉ FORT :
// somme de 2 ou 3 transactions compatible + signal fort de tiers/référence sur chacune. MÉTIER
// FORT : règle spécifique à un type d'objet (ex. terminologie de déblocage de prêt pour un
// financement — voir meilleureCorrespondanceFinancement). POSSIBLE : tiers seul, date incohérente.
type NiveauCorrespondance = "tres_fort" | "fort" | "agrege_fort" | "metier_fort" | "possible";

const ORDRE_NIVEAU: Record<NiveauCorrespondance, number> = {
  tres_fort: 5,
  fort: 4,
  metier_fort: 4,
  agrege_fort: 3,
  possible: 1,
};

interface Correspondance {
  transactions: NormalizedBankTransaction[]; // presque toujours 1 ; plusieurs pour un paiement fractionné (agrege_fort)
  niveau: NiveauCorrespondance;
  raison: string;
}

function meilleureDe(a: Correspondance | null, b: Correspondance | null): Correspondance | null {
  if (!a) return b;
  if (!b) return a;
  return ORDRE_NIVEAU[b.niveau] > ORDRE_NIVEAU[a.niveau] ? b : a;
}

// Recherche combinatoire volontairement bornée : ne s'applique qu'à un petit nombre de transactions
// ayant déjà un signal de tiers/référence avec la facture (jamais sur l'ensemble des transactions de
// la fenêtre), pour rester à la fois rapide et fiable — une somme de montants seule ne prouve rien.
const MAX_CANDIDATS_POUR_AGREGATION = 8;

/** Transactions qui partagent déjà un signal (référence complète, suffixe, ou tiers) avec la cible. */
function candidatsAvecSignal(
  transactionsCandidates: NormalizedBankTransaction[],
  tiers: string,
  reference: string | null
): NormalizedBankTransaction[] {
  const suffixe = reference ? extraireSuffixeReference(reference) : null;
  return transactionsCandidates.filter((t) => {
    if (reference && referenceTrouveeDansLibelle(t.labelOriginal, reference)) return true;
    if (suffixe && suffixeTrouveDansLibelle(t.labelOriginal, suffixe)) return true;
    if (libellesSuffisammentSimilaires(tiers, t.labelOriginal)) return true;
    if (auMoinsUnTokenTiersTrouve(tiers, t.labelOriginal)) return true;
    return false;
  });
}

/**
 * Cherche si la somme de 2 (puis 3) transactions parmi les candidats correspond au montant attendu —
 * pour les factures payées en plusieurs virements (ex. 73 000 € réglés en 66 000 € + 7 000 €). Ne
 * reçoit que des candidats déjà filtrés par candidatsAvecSignal : une somme de montants seule,
 * sans lien de tiers/référence, n'est jamais considérée comme une correspondance.
 */
function trouverCorrespondanceAgregee(
  candidats: NormalizedBankTransaction[],
  montantAttendu: number
): NormalizedBankTransaction[] | null {
  const n = candidats.length;
  if (n < 2 || n > MAX_CANDIDATS_POUR_AGREGATION) return null;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (montantsCompatibles(candidats[i].signedAmount + candidats[j].signedAmount, montantAttendu)) {
        return [candidats[i], candidats[j]];
      }
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const somme = candidats[i].signedAmount + candidats[j].signedAmount + candidats[k].signedAmount;
        if (montantsCompatibles(somme, montantAttendu)) return [candidats[i], candidats[j], candidats[k]];
      }
    }
  }
  return null;
}

/**
 * Cherche, parmi les transactions fournies, la MEILLEURE correspondance pour un montant/tiers/
 * référence/date attendus — jamais uniquement sur le montant (voir hiérarchie dans le module).
 * Gère aussi bien une transaction unique qu'un paiement fractionné en 2 ou 3 transactions.
 */
function meilleureCorrespondance(
  transactionsCandidates: NormalizedBankTransaction[],
  montantAttendu: number,
  tiers: string,
  reference: string | null,
  dateAttendue: string | null
): Correspondance | null {
  let meilleure: Correspondance | null = null;
  const suffixe = reference ? extraireSuffixeReference(reference) : null;

  for (const transaction of transactionsCandidates) {
    if (!montantsCompatibles(transaction.signedAmount, montantAttendu)) continue;

    const refOk = !!reference && referenceTrouveeDansLibelle(transaction.labelOriginal, reference);
    let candidate: Correspondance;
    if (refOk) {
      candidate = {
        transactions: [transaction],
        niveau: "tres_fort",
        raison: "Numéro de facture retrouvé dans le libellé bancaire.",
      };
    } else if (suffixe && suffixeTrouveDansLibelle(transaction.labelOriginal, suffixe) && auMoinsUnTokenTiersTrouve(tiers, transaction.labelOriginal)) {
      // Référence partielle (suffixe discriminant, ex. "0070") + tiers compatible : le suffixe seul
      // ne suffit jamais, il doit toujours être combiné à un signal de tiers.
      candidate = {
        transactions: [transaction],
        niveau: "fort",
        raison: "Référence partielle et tiers compatibles retrouvés dans le libellé bancaire.",
      };
    } else {
      const tiersOk = libellesSuffisammentSimilaires(tiers, transaction.labelOriginal);
      if (!tiersOk) continue;
      const dateOk = dateCoherente(transaction.date, dateAttendue);
      candidate = dateOk
        ? { transactions: [transaction], niveau: "fort", raison: "Tiers similaire et date cohérente avec le mouvement bancaire." }
        : { transactions: [transaction], niveau: "possible", raison: "Tiers similaire retrouvé dans le libellé bancaire." };
    }

    meilleure = meilleureDe(meilleure, candidate);
  }

  // Paiement fractionné : seulement si aucune transaction unique ne donne déjà un match solide
  // (tres_fort/fort) — inutile et coûteux de chercher une somme quand une seule transaction suffit.
  if (!meilleure || meilleure.niveau === "possible") {
    const signales = candidatsAvecSignal(transactionsCandidates, tiers, reference);
    const combinaison = trouverCorrespondanceAgregee(signales, montantAttendu);
    if (combinaison) {
      meilleure = meilleureDe(meilleure, {
        transactions: combinaison,
        niveau: "agrege_fort",
        raison: `Somme de ${combinaison.length} mouvements bancaires correspondant au montant, avec tiers/référence cohérents.`,
      });
    }
  }

  return meilleure;
}

// Sémantique bancaire déterministe de type "loan_disbursement" — termes seuls ET locutions de
// plusieurs mots, comparés après normalisation (accents/casse déjà retirés par
// normaliserTexteRapprochement). "PRET" couvre déjà "RÉALISATION DE PRÊT"/"RÉALISATION PRET"/"PRÊT"
// (le token suffit, la formulation exacte autour n'a pas besoin d'être listée séparément).
const TERMES_FINANCEMENT = ["PRET", "EMPRUNT", "DEBLOCAGE", "CREDIT", "MISE A DISPOSITION"];

/**
 * Le libellé bancaire contient un terme explicite de déblocage de prêt/financement — recherché comme
 * mot ou locution entière (bornée par des espaces), jamais comme sous-chaîne brute, pour éviter un
 * faux positif à l'intérieur d'un mot plus long non lié.
 */
function libelleBancaireEvoqueUnFinancement(labelOriginal: string): boolean {
  const normalise = ` ${normaliserTexteRapprochement(labelOriginal)} `;
  return TERMES_FINANCEMENT.some((terme) => normalise.includes(` ${terme} `));
}

/**
 * Règle métier dédiée aux financements (MÉTIER FORT) : le libellé Novanta décrit souvent la banque,
 * le projet ou un nom interne — pas le libellé bancaire du déblocage — donc la similarité de tiers
 * n'est pas fiable ici. Un crédit + montant + date cohérents + terminologie explicite de prêt/
 * déblocage suffit, sans exiger que le libellé Novanta apparaisse dans le libellé bancaire.
 */
function meilleureCorrespondanceFinancement(
  transactionsCandidates: NormalizedBankTransaction[],
  montantAttendu: number,
  libelle: string,
  dateAttendue: string | null
): Correspondance | null {
  let meilleure = meilleureCorrespondance(transactionsCandidates, montantAttendu, libelle, null, dateAttendue);

  for (const transaction of transactionsCandidates) {
    if (!montantsCompatibles(transaction.signedAmount, montantAttendu)) continue;
    if (!dateCoherente(transaction.date, dateAttendue)) continue;
    if (!libelleBancaireEvoqueUnFinancement(transaction.labelOriginal)) continue;

    meilleure = meilleureDe(meilleure, {
      transactions: [transaction],
      niveau: "metier_fort",
      raison: "Libellé bancaire typique d'un déblocage de prêt/financement, montant et date cohérents.",
    });
  }

  return meilleure;
}

function versConsistencyIssueTransaction(t: NormalizedBankTransaction): ConsistencyIssueTransaction {
  return { date: t.date, montant: t.signedAmount, libelle: t.labelOriginal };
}

const SEVERITE_PAR_NIVEAU: Record<NiveauCorrespondance, ConsistencySeverity> = {
  tres_fort: "strong",
  fort: "strong",
  agrege_fort: "strong",
  metier_fort: "strong",
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
      transactions: correspondance.transactions.map(versConsistencyIssueTransaction),
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
      transactions: correspondance.transactions.map(versConsistencyIssueTransaction),
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
/**
 * Toutes les dates Novanta potentiellement pertinentes pour juger si le paiement d'une facture
 * fournisseur peut être vérifié dans la fenêtre analysée. paidAt n'est PAS la date réelle du
 * paiement : c'est le moment où la case "Payée" a été cochée dans l'app (import, rattrapage, clic
 * tardif...), qui peut très bien tomber dans la fenêtre alors que le paiement réel est bien plus
 * ancien. datePaiementPrevue/dateEcheance sont la date métier propre à la facture.
 */
function datesPertinentesFournisseur(facture: FactureFournisseur): string[] {
  const dates: string[] = [];
  if (facture.datePaiementPrevue) dates.push(facture.datePaiementPrevue);
  if (facture.dateEcheance) dates.push(facture.dateEcheance);
  if (facture.paidAt) dates.push(facture.paidAt.slice(0, 10));
  return dates;
}

function datesPertinentesClient(facture: FactureClient): string[] {
  const dates: string[] = [];
  if (facture.dateEncaissementAnticipee) dates.push(facture.dateEncaissementAnticipee);
  if (facture.dateEcheance) dates.push(facture.dateEcheance);
  if (facture.paidAt) dates.push(facture.paidAt.slice(0, 10));
  return dates;
}

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
    if (!facture.payee) continue;
    const dates = datesPertinentesFournisseur(facture);
    // Aucune date fiable, OU au moins une date pertinente connue tombe hors fenêtre : la fenêtre de
    // 30 jours ne peut techniquement pas trancher — absence de match hors fenêtre = aucune conclusion.
    if (dates.length === 0 || dates.some((d) => d < fenetreDebut || d > dateReference)) continue;
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
    if (!facture.payee) continue;
    const dates = datesPertinentesClient(facture);
    if (dates.length === 0 || dates.some((d) => d < fenetreDebut || d > dateReference)) continue;
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
// Autres dépenses : rapprochement bancaire pour "Payée" — mécanisme strictement distinct de
// controlerAutresDepenses ci-dessus (qui ne touche jamais payee, uniquement facturee). Un mouvement
// bancaire ne peut jamais proposer "Marquer comme Facturée", et une facture fournisseur ne peut
// jamais proposer "Marquer comme Payée". Bénéficie automatiquement des mêmes règles de matching que
// les factures (référence partielle, paiement fractionné agrégé...) via meilleureCorrespondance.
// --------------------------------------------------------------------------------------------

function controlerAutresDepensesPayees(
  depenses: AutreDepense[],
  transactionsRecentes: NormalizedBankTransaction[]
): ConsistencyIssue[] {
  const debits = transactionsRecentes.filter((t) => t.signedAmount < 0);
  const issues: ConsistencyIssue[] = [];

  for (const depense of depenses) {
    if (depense.payee) continue;
    // Pas de référence de facture pour une Autre dépense : correspondance au mieux "fort" (tiers + date).
    const correspondance = meilleureCorrespondance(debits, -Math.abs(depense.montant), depense.libelle, null, depense.datePrevue || null);
    if (!correspondance) continue;

    issues.push({
      id: `other_expense_maybe_paid:${depense.id}`,
      type: "other_expense_maybe_paid",
      severity: SEVERITE_PAR_NIVEAU[correspondance.niveau],
      entityType: "autre_depense",
      entityId: depense.id,
      transactions: correspondance.transactions.map(versConsistencyIssueTransaction),
      message: `Cette dépense (${depense.libelle}) semble déjà avoir été payée.`,
      raison: correspondance.raison,
      actionPossible: { label: "Marquer comme Payée" },
      donneesAffichage: { libelle: depense.libelle, montant: depense.montant, date: depense.datePrevue || null },
    });
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

  const nonVerses = financements.filter((f) => !f.verse);
  // Pré-calcule la correspondance de chaque financement non versé : nécessaire pour détecter les cas
  // ambigus (deux financements de même montant qui revendiqueraient la MÊME transaction via la seule
  // règle terminologique, sans aucun signal discriminant de tiers/référence pour trancher entre eux).
  const correspondances = new Map(
    nonVerses.map((f) => [
      f.id,
      meilleureCorrespondanceFinancement(credits, Math.abs(f.montant), f.libelle, f.dateEncaissementPrevue || null),
    ])
  );

  for (const financement of nonVerses) {
    const correspondance = correspondances.get(financement.id) ?? null;
    if (!correspondance) continue;

    // Ambiguïté : la règle terminologique (metier_fort) ne s'appuie sur aucun tiers/référence propre à
    // CE financement — si un AUTRE financement non versé revendique la même transaction (par
    // terminologie ou par tiers/référence), ce match-ci n'est pas affirmable : une transaction
    // bancaire ne doit jamais satisfaire plusieurs financements sans justification propre. Un match
    // par référence/tiers (les autres niveaux) a, lui, une justification propre à sa propre ligne et
    // n'est donc jamais remis en cause ici, même si un autre financement cible la même transaction.
    const transactionCible = correspondance.transactions[0];
    const ambigu =
      correspondance.niveau === "metier_fort" &&
      nonVerses.some((autre) => {
        if (autre.id === financement.id) return false;
        const autreCorrespondance = correspondances.get(autre.id) ?? null;
        return autreCorrespondance != null && autreCorrespondance.transactions[0] === transactionCible;
      });

    issues.push({
      id: `financing_maybe_received:${financement.id}`,
      type: "financing_maybe_received",
      severity: ambigu ? "possible" : SEVERITE_PAR_NIVEAU[correspondance.niveau],
      entityType: "financement",
      entityId: financement.id,
      transactions: correspondance.transactions.map(versConsistencyIssueTransaction),
      message: `Ce financement (${financement.libelle}) semble avoir été versé.`,
      raison: ambigu
        ? "Plusieurs financements de même montant pourraient correspondre à ce même mouvement bancaire : à vérifier avant de valider."
        : correspondance.raison,
      actionPossible: { label: "Marquer comme Versé" },
      donneesAffichage: { libelle: financement.libelle, montant: financement.montant, date: financement.dateEncaissementPrevue || null },
    });
  }

  for (const financement of financements) {
    if (!financement.verse) continue;

    // Versé = true : l'absence de crédit récent ne prouve rien (versement antérieur à la fenêtre,
    // autre compte...) — uniquement si la date prévue tombe dans la fenêtre analysée, sinon hors sujet.
    if (
      financement.dateEncaissementPrevue &&
      financement.dateEncaissementPrevue >= fenetreDebut &&
      financement.dateEncaissementPrevue <= dateReference
    ) {
      const correspondance = meilleureCorrespondanceFinancement(credits, Math.abs(financement.montant), financement.libelle, null);
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
    ...controlerAutresDepensesPayees(params.autresDepenses, transactionsRecentes),
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

/**
 * Tri purement visuel de l'écran de validation (impact cash décroissant, montant absolu — le sens
 * débit/crédit n'importe pas ici) ; à montant égal, date la plus récente d'abord, puis libellé.
 * N'est PAS appelé par controlerCoherence lui-même : celui-ci conserve son propre ordre interne
 * (par type de contrôle), qui n'a aucune signification métier à préserver à l'affichage.
 */
export function trierIssuesParImpact(issues: ConsistencyIssue[]): ConsistencyIssue[] {
  return [...issues].sort((a, b) => {
    const impactA = Math.abs(a.donneesAffichage.montant);
    const impactB = Math.abs(b.donneesAffichage.montant);
    if (impactB !== impactA) return impactB - impactA;
    const dateA = a.donneesAffichage.date ?? "";
    const dateB = b.donneesAffichage.date ?? "";
    if (dateB !== dateA) return dateB.localeCompare(dateA); // la plus récente d'abord
    return a.donneesAffichage.libelle.localeCompare(b.donneesAffichage.libelle);
  });
}
