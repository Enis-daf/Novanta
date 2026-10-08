"use client";

import { useState } from "react";
import { formatMontant } from "@/lib/format";
import { notePeriodisationIncertaine, StockFinDeMois, variationsDeStock } from "@/lib/pastAdjustments";
import { libelleMois } from "@/lib/pastDetail";

interface PasseStocksProps {
  // Mois (YYYY-MM) de la période affichée : une ligne par mois, renseigné ou non.
  mois: string[];
  // Tous les stocks de l'organisation, y compris hors période : la variation d'un mois dépend du
  // stock renseigné précédent, qui peut être antérieur à la période.
  stocks: StockFinDeMois[];
  onEnregistrer: (mois: string, valeur: number) => void;
  onSupprimer: (mois: string) => void;
}

function formatVariation(montant: number): string {
  return montant > 0 ? `+${formatMontant(montant)}` : formatMontant(montant);
}

// Saisie des stocks de fin de mois. L'utilisateur ne saisit QUE le stock ; la variation est
// toujours calculée (jamais saisie), à partir de la série entière.
export default function PasseStocks({ mois, stocks, onEnregistrer, onSupprimer }: PasseStocksProps) {
  // Saisies en cours, par mois, tant qu'elles ne sont pas validées (sortie du champ ou Entrée).
  const [brouillons, setBrouillons] = useState<Record<string, string>>({});
  const parMois = new Map(stocks.map((s) => [s.mois, s.valeur]));
  const variations = variationsDeStock(stocks);
  const premierMoisRenseigne = stocks.length > 0 ? [...stocks].sort((a, b) => (a.mois < b.mois ? -1 : 1))[0].mois : null;

  const valider = (moisCourant: string) => {
    const brouillon = brouillons[moisCourant];
    if (brouillon === undefined) return;
    setBrouillons(({ [moisCourant]: _retire, ...reste }) => reste);
    const texte = brouillon.trim();
    if (texte === "") {
      if (parMois.has(moisCourant)) onSupprimer(moisCourant);
      return;
    }
    const valeur = Number(texte.replace(",", "."));
    if (!Number.isFinite(valeur) || valeur === parMois.get(moisCourant)) return;
    onEnregistrer(moisCourant, valeur);
  };

  return (
    <div className="passe-mapping">
      <p className="passe-message">
        Saisissez le stock de fin de chaque mois. La variation est calculée automatiquement et entre dans la marge
        brute ; le premier mois renseigné sert de point de départ et n&apos;a pas de variation.
      </p>
      <div className="table-wrapper">
        <table className="passe-table passe-stocks">
          <thead>
            <tr>
              <th>Mois</th>
              <th className="col-montant">Stock fin de mois</th>
              <th className="col-montant">Variation calculée</th>
            </tr>
          </thead>
          <tbody>
            {mois.map((moisCourant) => {
              const valeur = parMois.get(moisCourant);
              const variation = variations.get(moisCourant);
              return (
                <tr key={moisCourant}>
                  <td>{libelleMois(moisCourant)}</td>
                  <td className="col-montant">
                    <input
                      type="number"
                      inputMode="decimal"
                      step="any"
                      aria-label={`Stock de fin de mois, ${libelleMois(moisCourant)}`}
                      placeholder="—"
                      value={brouillons[moisCourant] ?? (valeur === undefined ? "" : String(valeur))}
                      onChange={(e) => setBrouillons((prev) => ({ ...prev, [moisCourant]: e.target.value }))}
                      onBlur={() => valider(moisCourant)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                    />
                  </td>
                  <td className="col-montant passe-table__montant">
                    {variation !== undefined ? (
                      <>
                        {formatVariation(variation.montant)}
                        {/* Trou dans la série : le montant compte, mais on ne sait pas sur quel mois. */}
                        {variation.discontinue && (
                          <span className="passe-detail__source passe-reserve">{notePeriodisationIncertaine(variation)}</span>
                        )}
                      </>
                    ) : moisCourant === premierMoisRenseigne ? (
                      <span className="passe-statut">Point de départ</span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
