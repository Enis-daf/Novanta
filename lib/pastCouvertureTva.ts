/**
 * Couverture de la TVA d'un périmètre, en lecture HT estimé (voir lib/pastHtEstime.ts). Module à
 * part, sans dépendance de calcul, pour être lu à la fois par le P&L et par les écrans de détail.
 */
import type { PartMappee } from "./pastDetail";

export interface CategorieSansTva {
  sourceCategoryId: string;
  sourceCategoryName: string;
  montantTtc: number; // montant de la catégorie dans le périmètre (signé)
}

/**
 * Part des montants d'un périmètre dont la TVA est renseignée — calculée sur les MONTANTS (en valeur
 * absolue) des parts concernées par la période et les filtres, pas sur le nombre de catégories.
 */
export interface CouvertureTva {
  complete: boolean;
  part: number | null; // 0 à 1 ; null si le périmètre ne contient aucun montant
  categoriesSansTva: CategorieSansTva[];
}

export function couvertureTva(parts: PartMappee[]): CouvertureTva {
  let concerne = 0;
  let couvert = 0;
  const manquantes = new Map<string, CategorieSansTva>();
  for (const part of parts) {
    const montantTtc = part.montantTtc ?? part.montant;
    concerne += Math.abs(montantTtc);
    if (!part.tvaManquante) {
      couvert += Math.abs(montantTtc);
      continue;
    }
    const cumul = manquantes.get(part.sourceCategoryId) ?? { sourceCategoryId: part.sourceCategoryId, sourceCategoryName: part.sourceCategoryName, montantTtc: 0 };
    cumul.montantTtc += montantTtc;
    manquantes.set(part.sourceCategoryId, cumul);
  }
  return {
    complete: manquantes.size === 0,
    part: concerne === 0 ? null : couvert / concerne,
    categoriesSansTva: [...manquantes.values()].sort((a, b) => Math.abs(b.montantTtc) - Math.abs(a.montantTtc)),
  };
}

/** « TVA renseignée sur 92 % des montants concernés. » — jamais 100 % pour une couverture incomplète. */
export function libelleCouverture(couverture: CouvertureTva): string {
  if (couverture.part === null) return "Aucun montant concerné sur la période.";
  const pourcentage = couverture.complete ? 100 : Math.min(99, Math.floor(couverture.part * 100));
  return `TVA renseignée sur ${pourcentage} % des montants concernés.`;
}

