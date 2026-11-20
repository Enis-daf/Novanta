/**
 * Factures prévisionnelles — pur, sans effet de bord.
 *
 * Une facture prévisionnelle est une facture que l'entreprise prévoit d'émettre mais qui n'existe
 * pas encore. Objet distinct d'une facture client (table forecast_customer_invoices, jamais
 * customer_invoices) : une vraie facture n'est jamais transformée en prévisionnelle, ni l'inverse.
 *
 * Règle de double compte, SEULE définition (estPrevisionnelleActive) :
 *  - prévisionnelle « À facturer » (aucun rapprochement) -> compte dans la projection, à sa date
 *    d'encaissement prévue ;
 *  - prévisionnelle « Facturée » (rapprochée d'une vraie facture) -> ne compte plus nulle part ;
 *    la vraie facture compte selon ses propres règles (Payée, Litigieuse…).
 * Le rapprochement est persistant : il ne dépend ni du statut de la vraie facture (Payée), ni de
 * son montant, ni même de sa présence (facture supprimée). Seule l'action volontaire
 * « Annuler le rapprochement » rend la prévisionnelle à nouveau active.
 *
 * Suggestions (proposerRapprochementsPrevisionnelles) : déterministes, jamais appliquées sans
 * confirmation. Signaux, par priorité : client, montant, proximité de date.
 */
import { cleNomFournisseur } from "./rapprochementChargesFixes";
import { estDateValide, parseDateISO } from "./dates";
import { FactureClient } from "./types";

/** Lien persistant entre une prévisionnelle et la vraie facture qui l'a remplacée. */
export interface RapprochementPrevisionnelle {
  // null = la vraie facture n'existe plus dans Novanta (supprimée) : la prévisionnelle reste
  // Facturée (pas d'annulation implicite), la copie ci-dessous identifie la facture concernée.
  factureClientId: string | null;
  // Copie de la vraie facture au moment du rapprochement (historique, et réattachement d'une
  // facture Pennylane réimportée sous un nouvel identifiant interne).
  factureNumero: string;
  facturePennylaneId: string | null;
  montantFacture: number;
  rapprocheLe: string; // ISO 8601
}

export interface FacturePrevisionnelle {
  id: string;
  client: string; // client ou libellé
  montant: number;
  dateFacturationPrevue: string; // YYYY-MM-DD ou "" — informative, sert au rapprochement
  dateEncaissementPrevue: string; // YYYY-MM-DD ou "" — pilote le cash
  rapprochement: RapprochementPrevisionnelle | null; // null = « À facturer »
  // Vraies factures écartées par « Ignorer » (clés cleFactureClient) : plus jamais suggérées pour
  // cette prévisionnelle. N'a aucun effet sur le calcul.
  facturesIgnorees: string[];
}

export type StatutPrevisionnelle = "a_facturer" | "facturee";

/** SEULE règle d'inclusion d'une prévisionnelle dans la trésorerie projetée. */
export function estPrevisionnelleActive(p: Pick<FacturePrevisionnelle, "rapprochement">): boolean {
  return p.rapprochement === null;
}

export function statutPrevisionnelle(p: Pick<FacturePrevisionnelle, "rapprochement">): StatutPrevisionnelle {
  return estPrevisionnelleActive(p) ? "a_facturer" : "facturee";
}

/** Identité durable d'une vraie facture : son identifiant Pennylane s'il existe, sinon l'interne. */
export function cleFactureClient(f: Pick<FactureClient, "id" | "pennylaneId">): string {
  return f.pennylaneId ? `pennylane:${f.pennylaneId}` : `id:${f.id}`;
}

export function nouvellePrevisionnelle(id: string): FacturePrevisionnelle {
  return { id, client: "", montant: 0, dateFacturationPrevue: "", dateEncaissementPrevue: "", rapprochement: null, facturesIgnorees: [] };
}

/** Rapprochement confirmé par l'utilisateur. La vraie facture n'est pas modifiée. */
export function rapprocher(p: FacturePrevisionnelle, facture: FactureClient, maintenant: Date = new Date()): FacturePrevisionnelle {
  return {
    ...p,
    rapprochement: {
      factureClientId: facture.id,
      factureNumero: facture.facture,
      facturePennylaneId: facture.pennylaneId ?? null,
      montantFacture: facture.montant,
      rapprocheLe: maintenant.toISOString(),
    },
  };
}

/** « Annuler le rapprochement » : la prévisionnelle redevient À facturer. La vraie facture reste inchangée. */
export function annulerRapprochement(p: FacturePrevisionnelle): FacturePrevisionnelle {
  return { ...p, rapprochement: null };
}

/** « Ignorer » une suggestion : la vraie facture n'est plus proposée pour ces prévisionnelles. Aucune neutralisation. */
export function ignorerFacture(p: FacturePrevisionnelle, facture: Pick<FactureClient, "id" | "pennylaneId">): FacturePrevisionnelle {
  const cle = cleFactureClient(facture);
  return p.facturesIgnorees.includes(cle) ? p : { ...p, facturesIgnorees: [...p.facturesIgnorees, cle] };
}

/** Vraie facture rapprochée, si elle est encore présente dans Novanta. */
export function factureRapprochee(p: FacturePrevisionnelle, factures: FactureClient[]): FactureClient | null {
  const id = p.rapprochement?.factureClientId;
  return id ? (factures.find((f) => f.id === id) ?? null) : null;
}

/** Libellé de l'état d'une prévisionnelle : « À facturer » ou « Facturée — FAC-2026-123 ». */
export function libelleStatut(p: FacturePrevisionnelle, factures: FactureClient[]): string {
  if (!p.rapprochement) return "À facturer";
  const facture = factureRapprochee(p, factures);
  const numero = facture?.facture || p.rapprochement.factureNumero;
  return `Facturée — ${numero}${facture ? "" : " (facture supprimée)"}`;
}

/**
 * Prévisionnelles rapprochées dont la vraie facture a disparu (identifiant interne effacé par la
 * base), alors qu'une facture portant le même identifiant Pennylane est présente : le lien y est
 * rattaché. Renvoie uniquement les prévisionnelles modifiées.
 */
export function previsionnellesARattacher(previsionnelles: FacturePrevisionnelle[], factures: FactureClient[]): FacturePrevisionnelle[] {
  const ids = new Set(factures.map((f) => f.id));
  const parPennylane = new Map(factures.filter((f) => f.pennylaneId).map((f) => [f.pennylaneId!, f]));
  const modifiees: FacturePrevisionnelle[] = [];
  for (const p of previsionnelles) {
    const r = p.rapprochement;
    if (!r || (r.factureClientId && ids.has(r.factureClientId)) || !r.facturePennylaneId) continue;
    const facture = parPennylane.get(r.facturePennylaneId);
    if (facture) modifiees.push({ ...p, rapprochement: { ...r, factureClientId: facture.id } });
  }
  return modifiees;
}

/** Une vraie facture retirée (fusion de doublons) : ses rapprochements passent à la facture gardée. */
export function deplacerRapprochements(
  previsionnelles: FacturePrevisionnelle[],
  retireeId: string,
  reference: FactureClient
): FacturePrevisionnelle[] {
  return previsionnelles
    .filter((p) => p.rapprochement?.factureClientId === retireeId)
    .map((p) => ({ ...p, rapprochement: { ...p.rapprochement!, factureClientId: reference.id, facturePennylaneId: reference.pennylaneId ?? p.rapprochement!.facturePennylaneId } }));
}

// --- Suggestions ---------------------------------------------------------------------------------

/**
 * Seuils des SUGGESTIONS, regroupés pour être ajustables en un seul endroit. Le rapprochement
 * manuel ne les consulte jamais : l'utilisateur peut rapprocher n'importe quelle vraie facture.
 */
export const SEUILS_SUGGESTION_PREVISIONNELLE = {
  // Écart maximal entre le montant réel et le montant prévu, rapporté au montant prévu.
  ecartMontantMax: 0.1,
  // Distance maximale entre l'échéance réelle et la date d'encaissement prévue (à défaut, la date
  // de facturation prévue). La date d'émission Pennylane n'est pas conservée dans Novanta.
  toleranceJours: 45,
} as const;

const MS_PAR_JOUR = 24 * 60 * 60 * 1000;

/** Client « identique ou proche » : même nom normalisé (sans accents, ponctuation ni forme juridique), ou l'un contient l'autre mot pour mot. */
export function clientsProches(a: string, b: string): boolean {
  const ka = cleNomFournisseur(a);
  const kb = cleNomFournisseur(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [court, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  return ` ${long} `.includes(` ${court} `);
}

export interface CandidatPrevisionnelle {
  previsionnelleId: string;
  ecartMontant: number; // relatif, 0 = identique
  ecartJours: number | null; // null = aucune date comparable
}

export interface SuggestionPrevisionnelle {
  factureClientId: string;
  // Une seule = correspondance unique ; plusieurs = ambiguïté, l'utilisateur choisit. Triées de la
  // plus plausible à la moins plausible (date, puis montant), jamais départagées automatiquement.
  candidats: CandidatPrevisionnelle[];
}

function dateReference(p: FacturePrevisionnelle): string {
  return estDateValide(p.dateEncaissementPrevue) ? p.dateEncaissementPrevue : p.dateFacturationPrevue;
}

function evaluer(p: FacturePrevisionnelle, f: FactureClient): CandidatPrevisionnelle | null {
  if (!clientsProches(p.client, f.client)) return null;
  if (!(p.montant > 0) || !(f.montant > 0)) return null;
  const ecartMontant = Math.abs(f.montant - p.montant) / p.montant;
  if (ecartMontant > SEUILS_SUGGESTION_PREVISIONNELLE.ecartMontantMax) return null;
  const datePrevue = dateReference(p);
  const dateReelle = estDateValide(f.dateEcheance) ? f.dateEcheance : f.dateEncaissementAnticipee;
  let ecartJours: number | null = null;
  if (estDateValide(datePrevue) && estDateValide(dateReelle)) {
    ecartJours = Math.abs(Math.round((parseDateISO(dateReelle).getTime() - parseDateISO(datePrevue).getTime()) / MS_PAR_JOUR));
    if (ecartJours > SEUILS_SUGGESTION_PREVISIONNELLE.toleranceJours) return null;
  }
  return { previsionnelleId: p.id, ecartMontant, ecartJours };
}

/**
 * Vraies factures qui semblent correspondre à une prévisionnelle encore À facturer. Ne propose
 * jamais : une vraie facture déjà rapprochée, ni une paire écartée par « Ignorer ». Ne décide
 * jamais : chaque suggestion attend « Rapprocher » ou « Ignorer ».
 */
export function proposerRapprochementsPrevisionnelles(
  previsionnelles: FacturePrevisionnelle[],
  factures: FactureClient[]
): SuggestionPrevisionnelle[] {
  const dejaRapprochees = new Set(previsionnelles.map((p) => p.rapprochement?.factureClientId).filter(Boolean));
  const actives = previsionnelles.filter(estPrevisionnelleActive);
  const suggestions: SuggestionPrevisionnelle[] = [];
  for (const f of factures) {
    if (dejaRapprochees.has(f.id)) continue;
    const cle = cleFactureClient(f);
    const candidats = actives
      .filter((p) => !p.facturesIgnorees.includes(cle))
      .map((p) => evaluer(p, f))
      .filter((c): c is CandidatPrevisionnelle => c !== null)
      .sort((a, b) => (a.ecartJours ?? Infinity) - (b.ecartJours ?? Infinity) || a.ecartMontant - b.ecartMontant);
    if (candidats.length > 0) suggestions.push({ factureClientId: f.id, candidats });
  }
  return suggestions;
}

/** Vraies factures proposées au rapprochement manuel : celles qui ne sont pas déjà rapprochées, les plus plausibles d'abord. */
export function facturesRapprochables(p: FacturePrevisionnelle, previsionnelles: FacturePrevisionnelle[], factures: FactureClient[]): FactureClient[] {
  const dejaRapprochees = new Set(previsionnelles.map((x) => x.rapprochement?.factureClientId).filter(Boolean));
  const libres = factures.filter((f) => !dejaRapprochees.has(f.id));
  const score = (f: FactureClient) => {
    const c = evaluer({ ...p, facturesIgnorees: [] }, f);
    return c ? (c.ecartJours ?? 0) + c.ecartMontant * 100 : clientsProches(p.client, f.client) ? 1000 : 10000;
  };
  return [...libres].sort((a, b) => score(a) - score(b) || a.client.localeCompare(b.client, "fr"));
}
