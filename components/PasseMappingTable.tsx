"use client";

import { formatMontant } from "@/lib/format";
import {
  EtagePnl,
  ETAGES_PNL,
  FiltreMapping,
  filtrerLignesMapping,
  LigneMapping,
} from "@/lib/pastCategoryMapping";

interface PasseMappingTableProps {
  lignes: LigneMapping[];
  filtre: FiltreMapping;
  onChangeFiltre: (filtre: FiltreMapping) => void;
  onChangeEtage: (sourceCategoryId: string, etage: EtagePnl) => void;
}

const formatNombre = new Intl.NumberFormat("fr-FR");

// Table de correspondance catégorie source -> étage P&L. Toujours accessible et modifiable : ce
// n'est pas un écran d'onboarding. Le nombre et le montant suivent la période affichée ; le
// mapping lui-même en est indépendant.
export default function PasseMappingTable({ lignes, filtre, onChangeFiltre, onChangeEtage }: PasseMappingTableProps) {
  const lignesFiltrees = filtrerLignesMapping(lignes, filtre);

  return (
    <div className="passe-mapping">
      <div className="passe-controle passe-axe">
        <label className="passe-controle__label" htmlFor="passe-mapping-filtre">
          Afficher
        </label>
        <select
          id="passe-mapping-filtre"
          value={filtre}
          onChange={(e) => onChangeFiltre(e.target.value as FiltreMapping)}
        >
          <option value="toutes">Toutes les catégories</option>
          <option value="a_mapper">À mapper</option>
          <option value="mappees">Mappées</option>
          <optgroup label="Par étage P&L">
            {ETAGES_PNL.map((etage) => (
              <option key={etage.cle} value={etage.cle}>
                {etage.libelle}
              </option>
            ))}
          </optgroup>
        </select>
      </div>

      {lignes.length === 0 ? (
        <div className="passe-etat">
          <p>Aucune catégorie connue pour le moment.</p>
          <p>Les catégories apparaissent ici après une synchronisation.</p>
        </div>
      ) : lignesFiltrees.length === 0 ? (
        <div className="passe-etat">Aucune catégorie ne correspond à ce filtre.</div>
      ) : (
        <div className="table-wrapper">
          <table className="passe-table">
            <thead>
              <tr>
                <th>Catégorie</th>
                <th className="col-montant">Transactions sur la période</th>
                <th className="col-montant">Montant sur la période</th>
                <th>Étage P&amp;L</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {lignesFiltrees.map((ligne) => (
                <tr key={ligne.sourceCategoryId}>
                  <td className="passe-table__libelle">{ligne.sourceCategoryName}</td>
                  <td className="col-montant passe-table__montant">{formatNombre.format(ligne.nombreTransactions)}</td>
                  <td className="col-montant passe-table__montant">{formatMontant(ligne.montantTotal)}</td>
                  <td className="passe-axe">
                    <select
                      aria-label={`Étage P&L de la catégorie ${ligne.sourceCategoryName}`}
                      value={ligne.pnlStage ?? ""}
                      onChange={(e) => e.target.value && onChangeEtage(ligne.sourceCategoryId, e.target.value as EtagePnl)}
                    >
                      {ligne.pnlStage === null && <option value="">À choisir…</option>}
                      {ETAGES_PNL.map((etage) => (
                        <option key={etage.cle} value={etage.cle}>
                          {etage.libelle}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {ligne.pnlStage === null ? (
                      <span className="passe-statut passe-statut--a-mapper">À mapper</span>
                    ) : (
                      <span className="passe-statut">Mappé</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
