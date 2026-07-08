"use client";

import { useMemo } from "react";
import { AutreDepense } from "@/lib/types";
import { trierParDate } from "@/lib/dates";
import DateField from "./DateField";

interface AutresDepensesTableProps {
  depenses: AutreDepense[];
  onChange: (id: string, patch: Partial<AutreDepense>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}

export default function AutresDepensesTable({
  depenses,
  onChange,
  onAdd,
  onRemove,
}: AutresDepensesTableProps) {
  const depensesTriees = useMemo(() => trierParDate(depenses, (d) => d.datePrevue), [depenses]);

  return (
    <div className="table-wrapper">
      <h3>Autres dépenses</h3>
      <table className="invoice-table">
        <thead>
          <tr>
            <th>Libellé</th>
            <th className="col-montant">Montant</th>
            <th>Date prévue</th>
            <th>Type</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {depensesTriees.map((depense) => (
            <tr key={depense.id}>
              <td>
                <input
                  type="text"
                  value={depense.libelle}
                  onChange={(e) => onChange(depense.id, { libelle: e.target.value })}
                />
              </td>
              <td className="col-montant">
                <input
                  type="number"
                  value={depense.montant}
                  onChange={(e) => onChange(depense.id, { montant: Number(e.target.value) })}
                />
              </td>
              <td>
                <DateField
                  value={depense.datePrevue}
                  onChange={(valeur) => onChange(depense.id, { datePrevue: valeur })}
                />
              </td>
              <td>
                <select
                  value={depense.type}
                  onChange={(e) => onChange(depense.id, { type: e.target.value as AutreDepense["type"] })}
                >
                  <option value="certaine">Certaine</option>
                  <option value="probable">Probable</option>
                </select>
              </td>
              <td className="col-actions">
                <button type="button" className="btn-remove" onClick={() => onRemove(depense.id)}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn-add" onClick={onAdd}>
        + Ajouter une dépense
      </button>
    </div>
  );
}
