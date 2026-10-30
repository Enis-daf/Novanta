"use client";

import { formatMontantComptable, MENTION_TTC } from "@/lib/format";
import { FluxHorsPnl, LIBELLE_NON_CATEGORISE, LIBELLE_NON_MAPPE } from "@/lib/pastPnlCashEstime";

const formatNombre = new Intl.NumberFormat("fr-FR");

/**
 * Flux bancaires sans affectation, sous le P&L cash estimé : hors du calcul, chiffrés en TTC avec
 * leur signe. Une transaction sans catégorie se corrige dans Pennylane, une catégorie sans étage dans
 * la correspondance P&L : les deux cas restent distincts.
 */
export default function PasseFluxHorsPnl({ flux, onConfigurer }: { flux: FluxHorsPnl; onConfigurer: () => void }) {
  if (!flux.incomplet) return null;
  const { nonCategorise, nonMappe } = flux;
  return (
    <div className="passe-message passe-flux-hors-pnl" role="status">
      <p>Marges incomplètes : ces flux bancaires n&apos;ont pas d&apos;affectation. Ils sont exclus du P&amp;L, jamais estimés.</p>
      {nonCategorise.nombreTransactions > 0 && (
        <p className="passe-flux-hors-pnl__ligne">
          <span>
            {LIBELLE_NON_CATEGORISE} ({formatNombre.format(nonCategorise.nombreTransactions)} transaction{nonCategorise.nombreTransactions > 1 ? "s" : ""})
          </span>
          <span className="passe-pnl__montant">{formatMontantComptable(nonCategorise.montant)} {MENTION_TTC}</span>
        </p>
      )}
      {nonMappe.categories.length > 0 && (
        <p className="passe-flux-hors-pnl__ligne">
          <span>
            {LIBELLE_NON_MAPPE} ({formatNombre.format(nonMappe.categories.length)})
          </span>
          <span className="passe-pnl__montant">{formatMontantComptable(nonMappe.montant)} {MENTION_TTC}</span>
        </p>
      )}
      {nonMappe.categories.length > 0 && (
        <button type="button" className="passe-lien-ligne" onClick={onConfigurer}>
          Compléter la correspondance P&amp;L
        </button>
      )}
    </div>
  );
}
