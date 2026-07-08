"use client";

import { useMemo } from "react";
import { RentreeReguliere } from "@/lib/types";
import { trierParDate } from "@/lib/dates";

interface RentreesRegulieresTableProps {
  rentrees: RentreeReguliere[];
  onChange: (id: string, patch: Partial<RentreeReguliere>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}

export default function RentreesRegulieresTable({
  rentrees,
  onChange,
  onAdd,
  onRemove,
}: RentreesRegulieresTableProps) {
  const rentreesTriees = useMemo(() => trierParDate(rentrees, (r) => r.dateDebut), [rentrees]);

  return (
    <div className="table-wrapper">
      <h3>Rentrées régulières</h3>
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
                <input
                  type="date"
                  value={rentree.dateDebut}
                  onChange={(e) => onChange(rentree.id, { dateDebut: e.target.value })}
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
                <input
                  type="date"
                  value={rentree.dateFin ?? ""}
                  onChange={(e) => onChange(rentree.id, { dateFin: e.target.value || null })}
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
      <button type="button" className="btn-add" onClick={onAdd}>
        + Ajouter une rentrée régulière
      </button>
    </div>
  );
}
