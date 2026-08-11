import { ChargeFixe, RentreeReguliere, TypeSourceCalculChargeFixe } from "./types";

function arrondirCentimes(montant: number): number {
  return Math.round(montant * 100) / 100;
}

interface SourceResolue {
  montant: number;
  libelle: string;
}

/**
 * Résout la ligne source d'une charge calculée. Retourne null si la source est introuvable,
 * si elle référence la charge elle-même, ou si elle pointe vers une charge fixe elle-même en
 * mode "calcule" (interdit — voir chargesUtilisantCommeSource / la contrainte de conversion).
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
    return { montant: source.montant, libelle: source.libelle };
  }

  const source = rentreesRegulieres.find((r) => r.id === sourceCalculId);
  if (!source) return null;
  return { montant: source.montant, libelle: source.libelle };
}

/**
 * Montant effectif d'une charge fixe : le montant saisi en mode "fixe", ou le montant dérivé
 * dynamiquement (taux % de la source) en mode "calcule". Ne renvoie jamais une valeur mise en
 * cache — toujours recalculé à partir de l'état courant de la source. null = indisponible
 * (source ou taux invalide) ; l'appelant doit alors exclure la ligne du calcul.
 */
export function montantEffectifChargeFixe(
  charge: ChargeFixe,
  chargesFixes: ChargeFixe[],
  rentreesRegulieres: RentreeReguliere[]
): number | null {
  if (charge.modeMontant === "fixe") return charge.montant;

  if (charge.tauxCalcul === null || !Number.isFinite(charge.tauxCalcul)) return null;

  const source = resoudreSourceCalcul(charge, chargesFixes, rentreesRegulieres);
  if (!source) return null;

  return arrondirCentimes((charge.tauxCalcul / 100) * source.montant);
}

/** Libellé de la source d'une charge calculée, pour l'aperçu et le tooltip ("Salaires"). */
export function libelleSourceCalcul(
  charge: ChargeFixe,
  chargesFixes: ChargeFixe[],
  rentreesRegulieres: RentreeReguliere[]
): string | null {
  return resoudreSourceCalcul(charge, chargesFixes, rentreesRegulieres)?.libelle ?? null;
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
 * Sources sélectionnables pour une charge fixe donnée : jamais la ligne elle-même, jamais
 * une charge fixe déjà en mode "calcule" (interdit en cascade).
 */
export function optionsSourceDisponibles(
  chargeId: string,
  chargesFixes: ChargeFixe[],
  rentreesRegulieres: RentreeReguliere[]
): OptionsSourceCalcul {
  return {
    chargesFixes: chargesFixes
      .filter((c) => c.id !== chargeId && c.modeMontant !== "calcule")
      .map((c) => ({ type: "charge_fixe", id: c.id, libelle: c.libelle, montant: c.montant, frequence: c.recurrence })),
    rentreesRegulieres: rentreesRegulieres.map((r) => ({
      type: "rentree_reguliere",
      id: r.id,
      libelle: r.libelle,
      montant: r.montant,
      frequence: r.frequence,
    })),
  };
}
