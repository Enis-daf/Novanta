import { normaliserLibelleBancaire, NormalizedBankTransaction } from "./bankTransaction";
import { PennylaneTransactionRaw } from "./pennylaneClient";

/**
 * Adapte le format Pennylane au modèle interne partagé avec la source XLSX — jamais l'inverse.
 * Pure, sans effet de bord, sans appel réseau : c'est ce qui permet de la tester unitairement et
 * de prouver que Pennylane produit exactement le même NormalizedBankTransaction[] qu'un import
 * XLSX équivalent (voir lib/pennylaneTransactionAdapter.test.ts, tests d'équivalence de source).
 *
 * Aucune règle métier ici : ni normalisation de libellé propre à Pennylane (on réutilise
 * normaliserLibelleBancaire telle quelle, la même que pour le XLSX), ni détection de récurrence,
 * ni rapprochement. L'adapter adapte le format ; le moteur Novanta fait le reste.
 *
 * Mapping :
 *   Pennylane date  -> date            (déjà au format YYYY-MM-DD)
 *   Pennylane label -> labelOriginal   (tel quel, "" si null)
 *   normaliserLibelleBancaire(label)   -> labelNormalized
 *   Pennylane amount -> signedAmount   (négatif = sortie, positif = entrée — voir la note de
 *                                        convention non documentée dans lib/pennylaneClient.ts ;
 *                                        isolé sur cette seule ligne pour rester trivial à inverser)
 */
export function versNormalizedBankTransactions(brutes: PennylaneTransactionRaw[]): NormalizedBankTransaction[] {
  return brutes.map((brute) => {
    const labelOriginal = brute.label ?? "";
    return {
      date: brute.date,
      labelOriginal,
      labelNormalized: normaliserLibelleBancaire(labelOriginal),
      signedAmount: Number(brute.amount),
    };
  });
}
