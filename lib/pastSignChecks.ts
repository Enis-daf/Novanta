import { EtagePnl, MappingCategorie, ventilerTransaction } from "./pastCategoryMapping";
import { PastTransactionStockee } from "./pastTransactions";

/**
 * Contrôles de cohérence sur le signe des transactions du module "Passé". Fonctions pures.
 *
 * Ces contrôles SIGNALENT seulement : ils ne modifient jamais un montant, un signe, une catégorie
 * ou un mapping, et n'excluent rien du reporting. Un signe inhabituel n'est pas forcément une
 * erreur (remboursement client, avoir fournisseur, correction bancaire...).
 *
 * Calculés à la lecture avec le mapping COURANT : changer l'étage d'une catégorie fait apparaître
 * ou disparaître ses anomalies, sans réécrire aucune transaction.
 */

export type TypeAnomalieSigne = "ca_negatif" | "cout_positif";

export const LIBELLES_ANOMALIE_SIGNE: Record<TypeAnomalieSigne, string> = {
  ca_negatif: "CA négatif",
  cout_positif: "Coût positif",
};

// Signe attendu par étage. Aucune règle pour extra_pnl : il peut légitimement porter des
// encaissements comme des décaissements.
const SIGNE_ATTENDU: Partial<Record<EtagePnl, "positif" | "negatif">> = {
  revenue: "positif",
  gross_margin: "negatif",
  contribution_margin: "negatif",
  ebitda: "negatif",
};

/** Anomalie d'un montant dans un étage, ou null si le signe est conforme (ou sans règle). */
export function anomalieDeSigne(etage: EtagePnl, montant: number): TypeAnomalieSigne | null {
  const attendu = SIGNE_ATTENDU[etage];
  if (attendu === "positif" && montant < 0) return "ca_negatif";
  if (attendu === "negatif" && montant > 0) return "cout_positif";
  return null;
}

export interface AnomalieSigne {
  transactionId: string;
  transactionDate: string;
  label: string;
  sourceCategoryId: string;
  sourceCategoryName: string;
  etage: EtagePnl;
  // Part pondérée de la transaction rattachée à cette catégorie (montant réel, jamais corrigé).
  montant: number;
  type: TypeAnomalieSigne;
}

/**
 * Anomalies de signe des transactions fournies (celles de la période affichée). Le contrôle porte
 * sur chaque part pondérée d'une transaction ventilée, dans l'étage de SA catégorie — pas sur la
 * seule catégorie principale. Les catégories non mappées n'ont pas d'étage, donc pas de règle.
 */
export function anomaliesDeSigne(
  transactions: PastTransactionStockee[],
  axeId: string | null,
  mappings: ReadonlyMap<string, MappingCategorie>
): AnomalieSigne[] {
  const anomalies: AnomalieSigne[] = [];
  for (const transaction of transactions) {
    for (const part of ventilerTransaction(transaction, axeId)) {
      const mapping = mappings.get(part.sourceCategoryId);
      const etage = mapping?.pnlStage ?? null;
      if (etage === null) continue;
      const type = anomalieDeSigne(etage, part.montant);
      if (type === null) continue;
      anomalies.push({
        transactionId: transaction.id,
        transactionDate: transaction.transactionDate,
        label: transaction.label,
        sourceCategoryId: part.sourceCategoryId,
        sourceCategoryName: mapping?.sourceCategoryName ?? part.sourceCategoryName,
        etage,
        montant: part.montant,
        type,
      });
    }
  }
  return anomalies;
}

/** Nombre de TRANSACTIONS concernées (une transaction ventilée ne compte qu'une fois). */
export function compterTransactionsAvecAnomalie(anomalies: AnomalieSigne[]): number {
  return new Set(anomalies.map((a) => a.transactionId)).size;
}
