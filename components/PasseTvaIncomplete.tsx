"use client";

import { formatMontant } from "@/lib/format";
import { CouvertureTva, libelleCouverture } from "@/lib/pastHtEstime";

const MAX_CATEGORIES_LISTEES = 4;

/**
 * Lecture HT estimé incomplète : des montants n'ont pas de taux de TVA. Dit lesquels, dans quelle
 * proportion, et mène à la correspondance P&L pour les renseigner. Aucun total n'est alors présenté
 * comme fiable.
 */
export default function PasseTvaIncomplete({ couverture, onConfigurer }: { couverture: CouvertureTva; onConfigurer: () => void }) {
  const listees = couverture.categoriesSansTva.slice(0, MAX_CATEGORIES_LISTEES);
  const autres = couverture.categoriesSansTva.length - listees.length;
  return (
    <div className="passe-message passe-tva-incomplete" role="status">
      <p>
        Estimation HT incomplète — TVA non définie pour{" "}
        {listees.map((c) => `${c.sourceCategoryName} (${formatMontant(c.montantTtc)})`).join(", ")}
        {autres > 0 ? ` et ${autres} autre${autres > 1 ? "s" : ""} catégorie${autres > 1 ? "s" : ""}` : ""}.{" "}
        <span className="passe-tva-incomplete__couverture">{libelleCouverture(couverture)}</span>
      </p>
      <button type="button" className="passe-lien-ligne" onClick={onConfigurer}>
        Renseigner la TVA dans Correspondance P&amp;L
      </button>
    </div>
  );
}
