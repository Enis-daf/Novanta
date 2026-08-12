import { ChargeFixe, RentreeReguliere, TypeSourceCalculChargeFixe } from "./types";
import { ajouterJours, estDateValide, FrequenceRecurrence, genererOccurrencesRecurrentes, parseDateISO } from "./dates";
import { montantOccurrenceRentreeReguliere } from "./saisonnalite";

function arrondirCentimes(montant: number): number {
  return Math.round(montant * 100) / 100;
}

// Plus le rang est élevé, plus la fréquence est "fréquente". "ponctuel" est volontairement
// absent : une ligne ponctuelle n'est contrainte dans aucun sens (voir frequenceCompatible).
const RANG_FREQUENCE: Partial<Record<FrequenceRecurrence, number>> = {
  quotidien: 3,
  hebdomadaire: 2,
  mensuel: 1,
};

/**
 * Une source ne peut alimenter une charge calculée que si elle est au moins aussi fréquente
 * que la charge (quotidien peut nourrir hebdomadaire/mensuel, hebdomadaire peut nourrir
 * mensuel, etc.) — jamais l'inverse, sinon une période de la charge pourrait n'avoir aucune
 * occurrence de source, ou une notion de "période" mal définie. "ponctuel" n'est contraint
 * dans aucun sens (il ne s'inscrit pas dans cette hiérarchie récurrente).
 */
export function frequenceCompatible(frequenceSource: FrequenceRecurrence, frequenceCharge: FrequenceRecurrence): boolean {
  const rangSource = RANG_FREQUENCE[frequenceSource];
  const rangCharge = RANG_FREQUENCE[frequenceCharge];
  if (rangSource === undefined || rangCharge === undefined) return true;
  return rangSource >= rangCharge;
}

interface SourceResolue {
  libelle: string;
  frequence: FrequenceRecurrence;
  dateDebut: string;
  dateFin: string | null;
  /**
   * Montant d'UNE occurrence précise de la source, à sa propre date. Une charge fixe non
   * calculée a un montant nominal constant (ignore la date). Une rentrée régulière peut être
   * fixe (montant constant) ou saisonnalisée (variable selon le mois de l'occurrence, via
   * montantOccurrenceRentreeReguliere) — la Charge calculée n'a pas à connaître la différence.
   */
  montantOccurrence: (dateOccurrence: Date) => number | null;
}

/**
 * Résout la ligne source d'une charge calculée. Retourne null si la source est introuvable,
 * si elle référence la charge elle-même, si elle pointe vers une charge fixe elle-même en
 * mode "calcule" (interdit — voir chargesUtilisantCommeSource / la contrainte de conversion),
 * ou si sa fréquence n'est pas compatible avec celle de la charge (garde-fou défensif : la
 * sélection dans l'UI filtre déjà ces cas, ceci couvre un changement ultérieur de fréquence).
 * Une rentrée régulière saisonnalisée est une source valide comme une autre : la saisonnalité
 * reste définie une seule fois sur la rentrée, la charge calculée en hérite via montantOccurrence.
 */
function resoudreSourceCalcul(
  charge: ChargeFixe,
  chargesFixes: ChargeFixe[],
  rentreesRegulieres: RentreeReguliere[]
): SourceResolue | null {
  const { sourceCalculId, sourceCalculType } = charge;
  if (!sourceCalculId || !sourceCalculType) return null;

  if (sourceCalculType === "charge_fixe") {
    if (sourceCalculId === charge.id) return null;
    const source = chargesFixes.find((c) => c.id === sourceCalculId);
    if (!source || source.modeMontant === "calcule") return null;
    if (!frequenceCompatible(source.recurrence, charge.recurrence)) return null;
    return {
      libelle: source.libelle,
      frequence: source.recurrence,
      dateDebut: source.datePrevue,
      dateFin: source.dateFin,
      montantOccurrence: () => source.montant,
    };
  }

  const source = rentreesRegulieres.find((r) => r.id === sourceCalculId);
  if (!source) return null;
  if (!frequenceCompatible(source.frequence, charge.recurrence)) return null;
  return {
    libelle: source.libelle,
    frequence: source.frequence,
    dateDebut: source.dateDebut,
    dateFin: source.dateFin,
    montantOccurrence: (dateOccurrence) => montantOccurrenceRentreeReguliere(source, dateOccurrence),
  };
}

/**
 * Montant d'UNE occurrence précise d'une charge fixe calculée : taux % appliqué à la somme
 * des occurrences réelles de la source tombant dans la période couverte par cette occurrence
 * — pas au montant nominal de la source, et pas à un coefficient moyen. La période est
 * [occurrence précédente + 1 jour, cette occurrence] ; pour la toute première occurrence de la
 * charge (dateOccurrencePrecedente = null), la période est réduite au seul jour de
 * l'occurrence elle-même — jamais d'occurrences de source antérieures au début réel de la
 * charge. En mode "fixe", le montant ne dépend d'aucune période : c'est toujours charge.montant.
 * null = montant indisponible (taux/source/fréquence invalide) ; l'appelant doit exclure
 * l'occurrence du calcul.
 */
export function montantOccurrenceChargeFixe(
  charge: ChargeFixe,
  dateOccurrence: Date,
  dateOccurrencePrecedente: Date | null,
  chargesFixes: ChargeFixe[],
  rentreesRegulieres: RentreeReguliere[],
  finHorizon: Date
): number | null {
  if (charge.modeMontant === "fixe") return charge.montant;

  if (charge.tauxCalcul === null || !Number.isFinite(charge.tauxCalcul)) return null;

  const source = resoudreSourceCalcul(charge, chargesFixes, rentreesRegulieres);
  if (!source) return null;

  const periodeDebut = dateOccurrencePrecedente ? ajouterJours(dateOccurrencePrecedente, 1) : dateOccurrence;
  const periodeFin = dateOccurrence;

  const occurrencesSource = genererOccurrencesRecurrentes(source.dateDebut, source.frequence, source.dateFin, finHorizon);
  const occurrencesDansPeriode = occurrencesSource.filter((d) => d >= periodeDebut && d <= periodeFin);

  let sommeSource = 0;
  for (const dateOccurrenceSource of occurrencesDansPeriode) {
    const montantOccurrenceSource = source.montantOccurrence(dateOccurrenceSource);
    if (montantOccurrenceSource === null) return null; // une occurrence de la source est indisponible
    sommeSource += montantOccurrenceSource;
  }

  return arrondirCentimes((charge.tauxCalcul / 100) * sommeSource);
}

const HORIZON_APERCU_JOURS = 730;

/**
 * Montant "représentatif" d'une charge calculée, pour l'aperçu du formulaire et le tri par
 * montant — pas pour le moteur de projection (voir montantOccurrenceChargeFixe, seule source
 * de vérité pour une occurrence réelle). Utilise la PREMIÈRE PÉRIODE COMPLÈTE de la charge
 * (2e occurrence) plutôt que sa toute première occurrence, qui est structurellement partielle
 * et donnerait une valeur trompeuse (ex. 400 € au lieu de 2 800 € pour "40 % de CA quotidien"
 * hebdomadaire) — sauf si la charge n'a pas encore de 2e occurrence dans une fenêtre large,
 * auquel cas on retombe sur la première (partielle).
 */
export function montantApercuChargeFixe(
  charge: ChargeFixe,
  chargesFixes: ChargeFixe[],
  rentreesRegulieres: RentreeReguliere[]
): number | null {
  if (charge.modeMontant === "fixe") return charge.montant;
  if (!estDateValide(charge.datePrevue)) return null;

  const finApercu = ajouterJours(parseDateISO(charge.datePrevue), HORIZON_APERCU_JOURS);
  const occurrences = genererOccurrencesRecurrentes(charge.datePrevue, charge.recurrence, charge.dateFin, finApercu);
  if (occurrences.length === 0) return null;

  const index = occurrences.length > 1 ? 1 : 0;
  const precedente = index > 0 ? occurrences[index - 1] : null;
  return montantOccurrenceChargeFixe(charge, occurrences[index], precedente, chargesFixes, rentreesRegulieres, finApercu);
}

/** Libellé de la source d'une charge calculée, pour l'aperçu et le tooltip ("Salaires"). */
export function libelleSourceCalcul(
  charge: ChargeFixe,
  chargesFixes: ChargeFixe[],
  rentreesRegulieres: RentreeReguliere[]
): string | null {
  return resoudreSourceCalcul(charge, chargesFixes, rentreesRegulieres)?.libelle ?? null;
}

/**
 * Message affiché quand le montant d'une charge calculée est indisponible. Diagnostic de
 * présentation uniquement : il ne fait que ré-interroger les mêmes signaux (taux, source,
 * frequenceCompatible) que montantOccurrenceChargeFixe pour choisir le message le plus précis
 * possible — il ne duplique ni ne modifie aucune règle de calcul ou de compatibilité.
 */
export function messageMontantIndisponible(
  charge: ChargeFixe,
  chargesFixes: ChargeFixe[],
  rentreesRegulieres: RentreeReguliere[]
): string {
  if (charge.tauxCalcul === null || !Number.isFinite(charge.tauxCalcul)) {
    return "Le taux doit être compris entre 0 et 100 %.";
  }

  const { sourceCalculId, sourceCalculType } = charge;
  if (sourceCalculId && sourceCalculType) {
    const frequenceSource =
      sourceCalculType === "charge_fixe"
        ? chargesFixes.find((c) => c.id === sourceCalculId)?.recurrence
        : rentreesRegulieres.find((r) => r.id === sourceCalculId)?.frequence;
    if (frequenceSource && !frequenceCompatible(frequenceSource, charge.recurrence)) {
      return "Source incompatible : elle doit être au moins aussi fréquente que la charge calculée.";
    }
  }

  return "Vérifier le taux, la récurrence et la source.";
}

/** Charges fixes calculées dépendant d'une ligne source donnée (charge fixe ou rentrée régulière). */
export function chargesUtilisantCommeSource(
  sourceType: TypeSourceCalculChargeFixe,
  sourceId: string,
  chargesFixes: ChargeFixe[]
): ChargeFixe[] {
  return chargesFixes.filter(
    (c) => c.modeMontant === "calcule" && c.sourceCalculType === sourceType && c.sourceCalculId === sourceId
  );
}

function listerLibelles(dependantes: ChargeFixe[]): string {
  return dependantes.map((c) => `« ${c.libelle || "Sans libellé"} »`).join(", ");
}

export function messageBlocageSuppression(dependantes: ChargeFixe[]): string {
  const pluriel = dependantes.length > 1;
  return `Impossible de supprimer cette ligne. Elle est utilisée pour calculer ${listerLibelles(dependantes)}. Modifiez d'abord ${
    pluriel ? "ces charges calculées" : "cette charge calculée"
  }.`;
}

export function messageBlocageConversion(dependantes: ChargeFixe[]): string {
  const pluriel = dependantes.length > 1;
  return `Impossible de passer cette charge en "Calculé". Elle est utilisée comme source pour calculer ${listerLibelles(
    dependantes
  )}. Modifiez d'abord ${pluriel ? "ces charges calculées" : "cette charge calculée"}.`;
}

export interface OptionSourceCalcul {
  type: TypeSourceCalculChargeFixe;
  id: string;
  libelle: string;
  montant: number;
  frequence: string;
}

export interface OptionsSourceCalcul {
  chargesFixes: OptionSourceCalcul[];
  rentreesRegulieres: OptionSourceCalcul[];
}

/**
 * Sources sélectionnables pour une charge fixe donnée : jamais la ligne elle-même, jamais une
 * charge fixe déjà en mode "calcule" (interdit en cascade), et seulement une fréquence au
 * moins aussi fréquente que celle de la charge (voir frequenceCompatible).
 */
export function optionsSourceDisponibles(
  charge: ChargeFixe,
  chargesFixes: ChargeFixe[],
  rentreesRegulieres: RentreeReguliere[]
): OptionsSourceCalcul {
  return {
    chargesFixes: chargesFixes
      .filter(
        (c) =>
          c.id !== charge.id && c.modeMontant !== "calcule" && frequenceCompatible(c.recurrence, charge.recurrence)
      )
      .map((c) => ({ type: "charge_fixe", id: c.id, libelle: c.libelle, montant: c.montant, frequence: c.recurrence })),
    rentreesRegulieres: rentreesRegulieres
      .filter((r) => frequenceCompatible(r.frequence, charge.recurrence))
      .map((r) => ({
        type: "rentree_reguliere",
        id: r.id,
        libelle: r.libelle,
        // Pour une rentrée saisonnalisée, r.montant n'est pas la source de vérité : on affiche
        // le montant du mois calendaire courant (même convention que le tri et l'aperçu de
        // conversion dans RentreesRegulieresTable), à défaut le montant fixe habituel.
        montant: montantOccurrenceRentreeReguliere(r, new Date()) ?? r.montant,
        frequence: r.frequence,
      })),
  };
}
