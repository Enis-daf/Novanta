/**
 * Rapprochement Facture fournisseur <-> occurrence de Charge fixe — pur, sans effet de bord.
 *
 * But : ne pas compter deux fois une dépense prévue en Charge fixe quand sa facture réelle
 * arrive. La facture REMPLACE l'occurrence correspondante (une seule occurrence, jamais la série) :
 * montant réel et date réelle font foi, y compris une fois la facture payée.
 *
 * Règle absolue : ce module ne fait que PROPOSER. Rien n'est neutralisé sans une décision
 * explicite de l'utilisateur (confirmation d'une proposition, ou rapprochement manuel).
 *
 * Trois responsabilités :
 *  1. resoudreRemplacements : liens confirmés -> occurrences remplacées (lu par les moteurs) et
 *     liens « à revoir » (état dérivé, jamais stocké) ;
 *  2. proposerRapprochements : candidats à soumettre à l'utilisateur après une synchronisation ;
 *  3. construireLien / construireMapping : ce qu'il faut enregistrer pour une décision.
 */
import { ajouterJours, estDateValide, genererOccurrencesRecurrentes, parseDateISO, toISODate } from "./dates";
import { montantOccurrenceChargeFixe } from "./montantCalcule";
import { cleOccurrence, Remplacements } from "./remplacementsOccurrences";
import { ChargeFixe, FactureFournisseur, LienRapprochement, MappingFournisseurCharge, RentreeReguliere } from "./types";

/**
 * Seuils du rapprochement AUTOMATIQUE (propositions). Choix de Novanta, regroupés ici pour être
 * ajustables en un seul endroit. Le rapprochement manuel ne les consulte jamais.
 */
export const SEUILS_RAPPROCHEMENT = {
  // Écart maximal entre le montant de la facture et le montant prévu de l'occurrence.
  ecartMaxFournisseurInconnu: 0.1,
  ecartMaxFournisseurConnu: 0.15,
  // Charge mensuelle ou ponctuelle sans occurrence dans le mois de la facture : occurrence la plus
  // proche, à cette distance au plus.
  toleranceJoursMensuel: 10,
  toleranceJoursHebdomadaire: 3,
} as const;

const MS_PAR_JOUR = 24 * 60 * 60 * 1000;

function ecartJours(a: Date, b: Date): number {
  return Math.abs(Math.round((a.getTime() - b.getTime()) / MS_PAR_JOUR));
}

// Formes juridiques retirées du nom pour comparer « Crocatus » et « CROCATUS SAS ».
const FORMES_JURIDIQUES = new Set(["sas", "sasu", "sarl", "sa", "eurl", "sci", "snc", "scop", "ei", "gmbh", "ltd", "inc", "llc", "bv"]);

/**
 * Nom de fournisseur normalisé : minuscules, sans accents ni ponctuation, sans forme juridique.
 * Repli d'identité uniquement — l'identifiant Pennylane du fournisseur fait foi quand il existe.
 */
export function cleNomFournisseur(nom: string): string {
  const mots = nom
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const sansForme = mots.filter((mot) => !FORMES_JURIDIQUES.has(mot));
  return (sansForme.length > 0 ? sansForme : mots).join(" ");
}

/**
 * Date à laquelle la facture pèse réellement sur la trésorerie : la date de paiement prévue (celle
 * que lit le moteur de projection), à défaut l'échéance. "" si aucune des deux n'est exploitable.
 */
export function dateCashFacture(facture: Pick<FactureFournisseur, "datePaiementPrevue" | "dateEcheance">): string {
  if (estDateValide(facture.datePaiementPrevue)) return facture.datePaiementPrevue;
  if (estDateValide(facture.dateEcheance)) return facture.dateEcheance;
  return "";
}

function memeMois(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/**
 * Occurrence d'une série qui correspond à une date donnée — règle temporelle UNIQUE, utilisée à
 * la fois pour proposer un rapprochement (date cash de la facture -> occurrence) et pour retrouver
 * l'occurrence d'un rapprochement déjà confirmé (date enregistrée -> occurrence actuelle, même si
 * le jour de la charge a été décalé depuis) :
 *  - mensuel / ponctuel : l'occurrence du même mois civil ; à défaut la plus proche à
 *    toleranceJoursMensuel jours au plus ;
 *  - hebdomadaire : la plus proche à toleranceJoursHebdomadaire jours au plus ;
 *  - quotidien : la date exacte uniquement.
 * null si aucune occurrence ne correspond.
 */
export function occurrenceCorrespondante(occurrences: Date[], recurrence: ChargeFixe["recurrence"], dateISO: string): Date | null {
  if (!estDateValide(dateISO)) return null;
  const cible = parseDateISO(dateISO);
  const plusProche = (candidates: Date[]): Date | null =>
    candidates.reduce<Date | null>((meilleure, d) => (meilleure === null || ecartJours(d, cible) < ecartJours(meilleure, cible) ? d : meilleure), null);

  if (recurrence === "quotidien") {
    return occurrences.find((d) => toISODate(d) === dateISO) ?? null;
  }
  if (recurrence === "hebdomadaire") {
    const proche = plusProche(occurrences);
    return proche && ecartJours(proche, cible) <= SEUILS_RAPPROCHEMENT.toleranceJoursHebdomadaire ? proche : null;
  }
  const duMois = plusProche(occurrences.filter((d) => memeMois(d, cible)));
  if (duMois) return duMois;
  const proche = plusProche(occurrences);
  return proche && ecartJours(proche, cible) <= SEUILS_RAPPROCHEMENT.toleranceJoursMensuel ? proche : null;
}

/** Occurrences d'une charge jusqu'à `fin`, prolongées si nécessaire pour couvrir `dateISO`. */
function occurrencesCouvrant(charge: ChargeFixe, fin: Date, dateISO?: string): Date[] {
  let borne = fin;
  if (dateISO && estDateValide(dateISO)) {
    const apres = ajouterJours(parseDateISO(dateISO), 31);
    if (apres > borne) borne = apres;
  }
  return genererOccurrencesRecurrentes(charge.datePrevue, charge.recurrence, charge.dateFin, borne);
}

// --- 1. Liens confirmés -> occurrences remplacées ---

export type MotifARevoir =
  // La facture qui avait remplacé l'occurrence n'existe plus (supprimée, ou archivée dans Pennylane).
  // L'occurrence RESTE remplacée : une dépense déjà matérialisée ne réapparaît jamais d'elle-même.
  | "facture_absente"
  // Le calendrier de la charge a changé : le rapprochement ne désigne plus aucune occurrence.
  | "occurrence_introuvable";

export interface LienARevoir {
  lien: LienRapprochement;
  motif: MotifARevoir;
}

export interface ResolutionRemplacements {
  remplacements: Remplacements;
  // Lien confirmé -> date (YYYY-MM-DD) de l'occurrence qu'il remplace actuellement.
  occurrenceParLien: Map<string, string>;
  aRevoir: LienARevoir[];
}

function factureDuLien(lien: LienRapprochement, factures: FactureFournisseur[]): FactureFournisseur | null {
  if (!lien.factureFournisseurId) return null;
  return factures.find((f) => f.id === lien.factureFournisseurId) ?? null;
}

/**
 * Traduit les rapprochements confirmés en occurrences remplacées. Ne dépend jamais du statut
 * Payée de la facture : le remplacement est une information durable. Le montant réel est celui de
 * la facture tant qu'elle existe, sinon celui copié dans le lien.
 */
export function resoudreRemplacements(
  liens: LienRapprochement[],
  chargesFixes: ChargeFixe[],
  facturesFournisseurs: FactureFournisseur[],
  fin: Date
): ResolutionRemplacements {
  const montantsReels = new Map<string, number>();
  const occurrenceParLien = new Map<string, string>();
  const aRevoir: LienARevoir[] = [];

  for (const lien of liens) {
    if (lien.statut !== "confirme") continue;
    const charge = chargesFixes.find((c) => c.id === lien.chargeFixeId);
    if (!charge) continue; // charge supprimée : plus aucune occurrence à remplacer

    const occurrence = occurrenceCorrespondante(occurrencesCouvrant(charge, fin, lien.dateOccurrence), charge.recurrence, lien.dateOccurrence);
    const cle = occurrence ? cleOccurrence(charge.id, occurrence) : null;
    if (!occurrence || !cle || montantsReels.has(cle)) {
      aRevoir.push({ lien, motif: "occurrence_introuvable" });
      continue;
    }

    const facture = factureDuLien(lien, facturesFournisseurs);
    montantsReels.set(cle, facture ? facture.montant : (lien.montantFacture ?? 0));
    occurrenceParLien.set(lien.id, toISODate(occurrence));
    if (!facture && !lien.revueEcarteeLe) aRevoir.push({ lien, motif: "facture_absente" });
  }

  return { remplacements: { montantsReels }, occurrenceParLien, aRevoir };
}

// --- 2. Propositions ---

export type NiveauConfiance = "forte" | "probable" | "ambigue";

export interface CandidatRapprochement {
  chargeFixeId: string;
  dateOccurrence: string; // YYYY-MM-DD
  montantPrevu: number;
  fournisseurConnu: boolean;
  // Renseigné quand l'occurrence est tenue par un rapprochement dont la facture a disparu : la
  // confirmation rattache ce lien à la nouvelle facture au lieu d'en créer un second.
  lienARemplacerId: string | null;
}

export interface PropositionRapprochement {
  factureId: string;
  niveau: NiveauConfiance;
  candidats: CandidatRapprochement[];
}

/** Le fournisseur de cette facture a-t-il déjà été rapproché de cette charge ? */
export function fournisseurConnuPourCharge(
  facture: Pick<FactureFournisseur, "fournisseur" | "pennylaneSupplierId">,
  chargeFixeId: string,
  mappings: MappingFournisseurCharge[]
): boolean {
  const cleNom = cleNomFournisseur(facture.fournisseur);
  return mappings.some((m) => {
    if (m.chargeFixeId !== chargeFixeId) return false;
    // L'identifiant Pennylane fait foi : deux fournisseurs aux noms proches ne se confondent pas.
    if (m.pennylaneSupplierId) return m.pennylaneSupplierId === (facture.pennylaneSupplierId ?? null);
    // Mapping sans identifiant (fournisseur saisi à la main) : repli sur le nom normalisé.
    return cleNom !== "" && m.cleNom === cleNom;
  });
}

/** Une décision (confirmée ou refusée) existe-t-elle déjà pour ce couple facture <-> charge ? */
function lienDuCouple(liens: LienRapprochement[], facture: FactureFournisseur, chargeFixeId: string): LienRapprochement | null {
  return (
    liens.find(
      (l) =>
        l.chargeFixeId === chargeFixeId &&
        (l.factureFournisseurId === facture.id || (Boolean(facture.pennylaneId) && l.facturePennylaneId === facture.pennylaneId))
    ) ?? null
  );
}

/** La facture remplace-t-elle déjà une occurrence (identité interne ou identité Pennylane) ? */
export function lienConfirmeDeFacture(liens: LienRapprochement[], facture: FactureFournisseur): LienRapprochement | null {
  return (
    liens.find(
      (l) =>
        l.statut === "confirme" &&
        (l.factureFournisseurId === facture.id || (Boolean(facture.pennylaneId) && l.facturePennylaneId === facture.pennylaneId))
    ) ?? null
  );
}

export interface ParametresRapprochement {
  facturesFournisseurs: FactureFournisseur[];
  chargesFixes: ChargeFixe[];
  rentreesRegulieres: RentreeReguliere[];
  liens: LienRapprochement[];
  mappings: MappingFournisseurCharge[];
  dateReleve: string; // YYYY-MM-DD
  horizonJours: number;
}

const ORDRE_NIVEAU: Record<NiveauConfiance, number> = { forte: 0, probable: 1, ambigue: 2 };

/**
 * Rapprochements à proposer à l'utilisateur. Déterministe et idempotent : ne dépend que de l'état
 * courant, donc une resynchronisation sans changement redonne exactement les mêmes propositions,
 * et un couple déjà confirmé ou refusé n'est jamais reproposé.
 *
 * Un candidat réunit toujours TROIS conditions — jamais le montant seul :
 *  - date : la date cash de la facture désigne une occurrence de la charge (occurrenceCorrespondante) ;
 *  - montant : écart au montant prévu dans le seuil, plus large si le fournisseur est déjà connu ;
 *  - disponibilité : l'occurrence n'est pas déjà remplacée par une facture existante.
 *
 * Niveau : "forte" si le fournisseur est déjà rapproché de cette charge et qu'elle est la seule
 * dans ce cas ; "probable" s'il y a un seul couple possible avec un fournisseur inconnu ; "ambigue"
 * dès que plusieurs charges, ou plusieurs factures pour une même occurrence, restent possibles.
 */
export function proposerRapprochements(params: ParametresRapprochement): PropositionRapprochement[] {
  const { facturesFournisseurs, chargesFixes, rentreesRegulieres, liens, mappings, dateReleve, horizonJours } = params;
  if (!estDateValide(dateReleve)) return [];
  const debut = parseDateISO(dateReleve);
  const fin = ajouterJours(debut, horizonJours);

  const { remplacements, occurrenceParLien } = resoudreRemplacements(liens, chargesFixes, facturesFournisseurs, fin);
  // Occurrence remplacée -> lien qui la tient, pour repérer celles dont la facture a disparu.
  const lienParOccurrence = new Map<string, LienRapprochement>();
  for (const lien of liens) {
    const date = occurrenceParLien.get(lien.id);
    if (date) lienParOccurrence.set(cleOccurrence(lien.chargeFixeId, date), lien);
  }

  const chargesEligibles = chargesFixes.filter((c) => !c.aCouper && c.recurrence !== "quotidien" && estDateValide(c.datePrevue));

  const propositions: PropositionRapprochement[] = [];
  for (const facture of facturesFournisseurs) {
    if (facture.litigieuse || !(facture.montant > 0)) continue;
    const dateCash = dateCashFacture(facture);
    if (!dateCash) continue; // ni paiement prévu ni échéance : jamais proposée automatiquement
    if (lienConfirmeDeFacture(liens, facture)) continue;
    const dateCashPassee = parseDateISO(dateCash) < debut;

    const candidats: CandidatRapprochement[] = [];
    for (const charge of chargesEligibles) {
      if (lienDuCouple(liens, facture, charge.id)) continue; // déjà confirmé ou refusé

      const occurrences = occurrencesCouvrant(charge, fin, dateCash);
      const occurrence = occurrenceCorrespondante(occurrences, charge.recurrence, dateCash);
      if (!occurrence) continue;

      // Ni l'occurrence ni la facture ne sont dans la projection : rien à dédoublonner.
      if (occurrence < debut && (facture.payee || dateCashPassee)) continue;

      const cle = cleOccurrence(charge.id, occurrence);
      const lienExistant = lienParOccurrence.get(cle) ?? null;
      // Occurrence déjà remplacée par une facture toujours présente : indisponible.
      if (lienExistant && factureDuLien(lienExistant, facturesFournisseurs)) continue;

      const index = occurrences.findIndex((d) => d.getTime() === occurrence.getTime());
      const precedente = index > 0 ? occurrences[index - 1] : null;
      const montantPrevu = montantOccurrenceChargeFixe(charge, occurrence, precedente, chargesFixes, rentreesRegulieres, fin, remplacements);
      if (montantPrevu === null || !(montantPrevu > 0)) continue;

      const fournisseurConnu = fournisseurConnuPourCharge(facture, charge.id, mappings);
      const seuil = fournisseurConnu ? SEUILS_RAPPROCHEMENT.ecartMaxFournisseurConnu : SEUILS_RAPPROCHEMENT.ecartMaxFournisseurInconnu;
      // Arrondi au dix-millième : 2 300 € pour 2 000 € prévus vaut exactement 15 %, pas 15,000000002 %.
      const ecart = Math.round((Math.abs(facture.montant - montantPrevu) / montantPrevu) * 10000) / 10000;
      if (ecart > seuil) continue;

      candidats.push({
        chargeFixeId: charge.id,
        dateOccurrence: toISODate(occurrence),
        montantPrevu,
        fournisseurConnu,
        lienARemplacerId: lienExistant ? lienExistant.id : null,
      });
    }
    if (candidats.length === 0) continue;

    // Un seul candidat à fournisseur connu : l'historique validé par l'utilisateur tranche.
    const connus = candidats.filter((c) => c.fournisseurConnu);
    if (connus.length === 1) {
      propositions.push({ factureId: facture.id, niveau: "forte", candidats: connus });
    } else if (connus.length > 1) {
      propositions.push({ factureId: facture.id, niveau: "ambigue", candidats: connus });
    } else {
      propositions.push({ factureId: facture.id, niveau: candidats.length === 1 ? "probable" : "ambigue", candidats });
    }
  }

  // Plusieurs factures pour une même occurrence.
  const facturesParOccurrence = new Map<string, PropositionRapprochement[]>();
  for (const proposition of propositions) {
    for (const candidat of proposition.candidats) {
      const cle = cleOccurrence(candidat.chargeFixeId, candidat.dateOccurrence);
      facturesParOccurrence.set(cle, [...(facturesParOccurrence.get(cle) ?? []), proposition]);
    }
  }
  for (const [cle, concurrentes] of facturesParOccurrence) {
    if (concurrentes.length < 2) continue;
    const fortes = concurrentes.filter((p) => p.niveau === "forte");
    if (fortes.length === 1) {
      // Un fournisseur déjà rapproché de cette charge prime : les autres factures (même montant,
      // autre fournisseur) ne sont pas proposées sur cette occurrence.
      for (const autre of concurrentes) {
        if (autre === fortes[0]) continue;
        autre.candidats = autre.candidats.filter((c) => cleOccurrence(c.chargeFixeId, c.dateOccurrence) !== cle);
        if (autre.niveau === "ambigue" && autre.candidats.length === 1) {
          autre.niveau = autre.candidats[0].fournisseurConnu ? "forte" : "probable";
        }
      }
    } else {
      for (const concurrente of concurrentes) concurrente.niveau = "ambigue";
    }
  }

  return propositions
    .filter((p) => p.candidats.length > 0)
    .sort((a, b) => ORDRE_NIVEAU[a.niveau] - ORDRE_NIVEAU[b.niveau]);
}

// --- Rapprochement manuel ---

export interface OccurrenceRapprochable {
  dateOccurrence: string; // YYYY-MM-DD
  montantPrevu: number | null;
  suggeree: boolean; // celle que désigne la date cash de la facture
  lienARemplacerId: string | null;
}

const FENETRE_MANUELLE_JOURS = 62;

/**
 * Occurrences d'une charge qu'une facture peut remplacer par décision manuelle : celles qui ne
 * sont pas déjà remplacées par une facture existante, dans une fenêtre autour de la date cash de
 * la facture (ou de la date de relevé si la facture n'a aucune date). Aucun seuil de montant : c'est
 * l'utilisateur qui affirme que c'est la même dépense.
 */
export function occurrencesRapprochables(
  facture: FactureFournisseur,
  charge: ChargeFixe,
  params: Omit<ParametresRapprochement, "mappings">
): OccurrenceRapprochable[] {
  const { facturesFournisseurs, chargesFixes, rentreesRegulieres, liens, dateReleve, horizonJours } = params;
  if (!estDateValide(dateReleve) || !estDateValide(charge.datePrevue)) return [];
  const fin = ajouterJours(parseDateISO(dateReleve), horizonJours);
  const dateCash = dateCashFacture(facture);
  const centre = parseDateISO(dateCash || dateReleve);

  const { remplacements, occurrenceParLien } = resoudreRemplacements(liens, chargesFixes, facturesFournisseurs, fin);
  const lienParOccurrence = new Map<string, LienRapprochement>();
  for (const lien of liens) {
    const date = occurrenceParLien.get(lien.id);
    if (date) lienParOccurrence.set(cleOccurrence(lien.chargeFixeId, date), lien);
  }

  const occurrences = occurrencesCouvrant(charge, fin, toISODate(centre));
  const suggeree = dateCash ? occurrenceCorrespondante(occurrences, charge.recurrence, dateCash) : null;
  const resultat: OccurrenceRapprochable[] = [];
  occurrences.forEach((occurrence, index) => {
    if (ecartJours(occurrence, centre) > FENETRE_MANUELLE_JOURS) return;
    const lienExistant = lienParOccurrence.get(cleOccurrence(charge.id, occurrence)) ?? null;
    if (lienExistant && factureDuLien(lienExistant, facturesFournisseurs)) return;
    const precedente = index > 0 ? occurrences[index - 1] : null;
    resultat.push({
      dateOccurrence: toISODate(occurrence),
      montantPrevu: montantOccurrenceChargeFixe(charge, occurrence, precedente, chargesFixes, rentreesRegulieres, fin, remplacements),
      suggeree: suggeree !== null && suggeree.getTime() === occurrence.getTime(),
      lienARemplacerId: lienExistant ? lienExistant.id : null,
    });
  });
  return resultat;
}

// --- 3. Ce qu'une décision enregistre ---

/**
 * Lien à enregistrer pour une décision. Seul endroit où un lien est construit : la copie de la
 * facture — et surtout son identifiant Pennylane, qui rend la décision durable quand la même
 * facture est réimportée sous un nouvel identifiant interne — y est donc toujours renseignée.
 */
export function construireLien(
  facture: FactureFournisseur,
  chargeFixeId: string,
  dateOccurrence: string,
  statut: LienRapprochement["statut"],
  id: string = crypto.randomUUID()
): LienRapprochement {
  return {
    id,
    chargeFixeId,
    factureFournisseurId: facture.id,
    dateOccurrence,
    statut,
    factureLibelle: facture.facture,
    fournisseurLibelle: facture.fournisseur,
    montantFacture: facture.montant,
    dateCashFacture: dateCashFacture(facture) || null,
    facturePennylaneId: facture.pennylaneId ?? null,
    fournisseurPennylaneId: facture.pennylaneSupplierId ?? null,
    revueEcarteeLe: null,
  };
}

/**
 * Mapping fournisseur <-> charge à mémoriser après un rapprochement confirmé (suggéré ou manuel).
 * null si ce fournisseur est déjà connu pour cette charge, ou s'il n'a ni identifiant ni nom.
 */
export function construireMapping(
  facture: FactureFournisseur,
  chargeFixeId: string,
  mappings: MappingFournisseurCharge[],
  id: string = crypto.randomUUID()
): MappingFournisseurCharge | null {
  const pennylaneSupplierId = facture.pennylaneSupplierId ?? null;
  const cleNom = cleNomFournisseur(facture.fournisseur);
  if (!pennylaneSupplierId && !cleNom) return null;
  const dejaConnu = mappings.some(
    (m) =>
      m.chargeFixeId === chargeFixeId &&
      (pennylaneSupplierId ? m.pennylaneSupplierId === pennylaneSupplierId : !m.pennylaneSupplierId && m.cleNom === cleNom)
  );
  if (dejaConnu) return null;
  return { id, chargeFixeId, pennylaneSupplierId, cleNom: cleNom || "fournisseur", libelle: facture.fournisseur };
}

/**
 * Factures réimportées : une décision dont la facture avait disparu retrouve sa facture quand la
 * même facture Pennylane revient sous un nouvel identifiant interne. Renvoie les rattachements à
 * appliquer (lien -> facture) ; vide si rien à faire.
 */
export function liensARattacher(
  liens: LienRapprochement[],
  facturesFournisseurs: FactureFournisseur[]
): { lienId: string; factureFournisseurId: string }[] {
  const idsPresents = new Set(facturesFournisseurs.map((f) => f.id));
  const parPennylaneId = new Map<string, FactureFournisseur>();
  for (const facture of facturesFournisseurs) {
    if (facture.pennylaneId) parPennylaneId.set(facture.pennylaneId, facture);
  }
  const rattachements: { lienId: string; factureFournisseurId: string }[] = [];
  for (const lien of liens) {
    if (lien.factureFournisseurId && idsPresents.has(lien.factureFournisseurId)) continue;
    const facture = lien.facturePennylaneId ? parPennylaneId.get(lien.facturePennylaneId) : undefined;
    if (facture) rattachements.push({ lienId: lien.id, factureFournisseurId: facture.id });
  }
  return rattachements;
}
