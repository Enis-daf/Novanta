"use client";

import { useMemo } from "react";
import { RentreeReguliere } from "@/lib/types";
import { trierParDate } from "@/lib/dates";
import { filtrerRentreesRegulieres } from "@/lib/recherche";
import DateField from "./DateField";

interface RentreesRegulieresTableProps {
  rentrees: RentreeReguliere[];
  onChange: (id: string, patch: Partial<RentreeReguliere>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  recherche: string;
}

export default function RentreesRegulieresTable({
  rentrees,
  onChange,
  onAdd,
  onRemove,
  recherche,
}: RentreesRegulieresTableProps) {
  const rentreesTriees = useMemo(
    () => filtrerRentreesRegulieres(trierParDate(rentrees, (r) => r.dateDebut), recherche),
    [rentrees, recherche]
  );

  return (
    <div className="table-wrapper">
      <h3>Rentrées régulières</h3>
      {recherche && rentreesTriees.length === 0 ? (
        <p className="recherche-vide">Aucun résultat dans cette section</p>
      ) : (
      <table className="invoice-table">
        <thead>
          <tr>
            <th>Libellé</th>
            <th className="col-montant">Montant</th>
            <th>Date de début</th>
            <th>Fréquence</th>
            <th>Date de fin</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rentreesTriees.map((rentree) => (
            <tr key={rentree.id}>
              <td>
                <input
                  type="text"
                  value={rentree.libelle}
                  onChange={(e) => onChange(rentree.id, { libelle: e.target.value })}
                />
              </td>
              <td className="col-montant">
                <input
                  type="number"
                  min="0"
                  value={rentree.montant}
                  onChange={(e) => onChange(rentree.id, { montant: Math.abs(Number(e.target.value) || 0) })}
                />
              </td>
              <td>
                <DateField
                  value={rentree.dateDebut}
                  onChange={(valeur) => onChange(rentree.id, { dateDebut: valeur })}
                />
              </td>
              <td>
                <select
                  value={rentree.frequence}
                  onChange={(e) =>
                    onChange(rentree.id, { frequence: e.target.value as RentreeReguliere["frequence"] })
                  }
                >
                  <option value="ponctuel">Ponctuel</option>
                  <option value="quotidien">Quotidien</option>
                  <option value="mensuel">Mensuel</option>
                </select>
              </td>
              <td>
                <DateField
                  value={rentree.dateFin ?? ""}
                  onChange={(valeur) => onChange(rentree.id, { dateFin: valeur || null })}
                />
              </td>
              <td className="col-actions">
                <button type="button" className="btn-remove" onClick={() => onRemove(rentree.id)}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      )}
      <button type="button" className="btn-add" onClick={onAdd}>
        + Ajouter une rentrée régulière
      </button>
    </div>
  );
}
