import { AjustementGestion, sommeAjustements } from "./pastAdjustments";
import { MappingCategorie, NatureRevenu } from "./pastCategoryMapping";
import { moisDeLaPeriode, PartMappee } from "./pastDetail";
import { Periode } from "./pastTransactions";

/**
 * Récurrence du revenu (offre Pilotage) — fonctions pures. Lecture des Encaissements selon la nature
 * du revenu de leur catégorie (lib/pastCategoryMapping.ts, NATURES_REVENU), résolue à la LECTURE par
 * le mapping courant : classer une catégorie en revenu récurrent relit tout son historique, sans
 * réécrire ni figer aucune transaction.
 *
 *   Part du revenu récurrent = revenu récurrent / (revenu récurrent + revenu ponctuel)
 *
 * Les Encaissements dont la catégorie n'a pas encore de nature ne sont comptés NI en récurrent NI
 * en ponctuel : ils sont « à classer » (état de paramétrage), dits à côté de la part, jamais
 * assimilés à du ponctuel. Les ajustements de gestion d'Encaissements n'ont pas de catégorie, donc
 * pas de nature : ils restent dans les Encaissements, hors de la part.
 *
 * Aucun montant n'est recalculé ici : ce sont les parts de l'écran Encaissements (partsMappees,
 * dans la lecture affichée), simplement réparties. Encaissements = récurrent + ponctuel + à classer
 * + ajustements.
 */

export interface CategorieRecurrence {
  sourceCategoryId: string;
  nom: string;
  nature: NatureRevenu | null; // null : à classer
  montant: number;
}

export interface MoisRecurrence {
  mois: string; // YYYY-MM
  recurrent: number;
  ponctuel: number;
  aClasser: number;
  // null : rien de classé ce mois-là (ou base classée nulle / négative) — jamais 0 par défaut.
  part: number | null;
}

export type RaisonPartIndisponible = "aucun_encaissement" | "aucun_classe" | "base_non_positive";

export interface RecurrenceRevenu {
  recurrent: number;
  ponctuel: number;
  aClasser: number;
  ajustements: number;
  // Encaissements de la période, comme l'écran Encaissements.
  encaissements: number;
  part: number | null;
  raison: RaisonPartIndisponible | null;
  // Catégories d'Encaissements actives sur la période, par montant décroissant.
  categories: CategorieRecurrence[];
  categoriesAClasser: number;
  mois: MoisRecurrence[];
}

const TOLERANCE = 0.005;

/**
 * Part récurrente d'une base classée. Indisponible plutôt que trompeuse : sans encaissement classé,
 * ou quand les remboursements rendent la base classée nulle ou négative (une part n'aurait pas de sens).
 */
export function partRecurrente(recurrent: number, ponctuel: number): { part: number | null; raison: RaisonPartIndisponible | null } {
  const base = recurrent + ponctuel;
  if (Math.abs(recurrent) < TOLERANCE && Math.abs(ponctuel) < TOLERANCE) return { part: null, raison: "aucun_classe" };
  if (base <= TOLERANCE || recurrent < -TOLERANCE || ponctuel < -TOLERANCE) return { part: null, raison: "base_non_positive" };
  return { part: recurrent / base, raison: null };
}

export function recurrenceDuRevenu(
  parts: PartMappee[],
  mappings: ReadonlyMap<string, MappingCategorie>,
  ajustements: AjustementGestion[],
  periode: Periode
): RecurrenceRevenu {
  const categories = new Map<string, CategorieRecurrence>();
  const parMois = new Map<string, MoisRecurrence>(moisDeLaPeriode(periode).map((m) => [m, { mois: m, recurrent: 0, ponctuel: 0, aClasser: 0, part: null }]));
  let recurrent = 0;
  let ponctuel = 0;
  let aClasser = 0;
  for (const p of parts) {
    if (p.etage !== "revenue") continue;
    const nature = mappings.get(p.sourceCategoryId)?.revenueNature ?? null;
    const categorie = categories.get(p.sourceCategoryId) ?? { sourceCategoryId: p.sourceCategoryId, nom: p.sourceCategoryName, nature, montant: 0 };
    categorie.montant += p.montant;
    categories.set(p.sourceCategoryId, categorie);
    const mois = parMois.get(p.mois);
    if (nature === "recurring") {
      recurrent += p.montant;
      if (mois) mois.recurrent += p.montant;
    } else if (nature === "one_off") {
      ponctuel += p.montant;
      if (mois) mois.ponctuel += p.montant;
    } else {
      aClasser += p.montant;
      if (mois) mois.aClasser += p.montant;
    }
  }
  for (const m of parMois.values()) m.part = partRecurrente(m.recurrent, m.ponctuel).part;

  const ajustementsEncaissements = sommeAjustements(ajustements, ["revenue"]);
  const encaissements = recurrent + ponctuel + aClasser + ajustementsEncaissements;
  const { part, raison } = partRecurrente(recurrent, ponctuel);
  const listeCategories = [...categories.values()].sort((a, b) => b.montant - a.montant || a.nom.localeCompare(b.nom, "fr"));
  return {
    recurrent,
    ponctuel,
    aClasser,
    ajustements: ajustementsEncaissements,
    encaissements,
    part,
    // Aucun encaissement du tout : dit comme tel, pas comme un défaut de classement.
    raison: raison === "aucun_classe" && Math.abs(aClasser) < TOLERANCE ? "aucun_encaissement" : raison,
    categories: listeCategories,
    categoriesAClasser: listeCategories.filter((c) => c.nature === null).length,
    mois: [...parMois.values()],
  };
}
