"use client";

import { ChargeFixe } from "@/lib/types";

interface ChargesFixesTableProps {
  charges: ChargeFixe[];
  onChange: (id: string, patch: Partial<ChargeFixe>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}

export default function ChargesFixesTable({ charges, onChange, onAdd, onRemove }: ChargesFixesTableProps) {
  return (
    <div className="table-wrapper">
      <h3>Charges fixes</h3>
      <table className="invoice-table">
        <thead>
          <tr>
            <th>Libellé</th>
            <th className="col-montant">Montant</th>
            <th>Date prévue</th>
            <th>Récurrence</th>
            <th>Date de fin</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {charges.map((charge) => (
            <tr key={charge.id}>
              <td>
                <input
                  type="text"
                  value={charge.libelle}
                  onChange={(e) => onChange(charge.id, { libelle: e.target.value })}
                />
              </td>
              <td className="col-montant">
                <input
                  type="number"
                  value={charge.montant}
                  onChange={(e) => onChange(charge.id, { montant: Number(e.target.value) })}
                />
              </td>
              <td>
                <input
                  type="date"
                  value={charge.datePrevue}
                  onChange={(e) => onChange(charge.id, { datePrevue: e.target.value })}
                />
              </td>
              <td>
                <select
                  value={charge.recurrence}
                  onChange={(e) =>
                    onChange(charge.id, { recurrence: e.target.value as ChargeFixe["recurrence"] })
                  }
                >
                  <option value="ponctuel">Ponctuelle</option>
                  <option value="quotidien">Quotidienne</option>
                  <option value="hebdomadaire">Hebdomadaire</option>
                  <option value="mensuel">Mensuelle</option>
                </select>
              </td>
              <td>
                <input
                  type="date"
                  value={charge.dateFin ?? ""}
                  onChange={(e) => onChange(charge.id, { dateFin: e.target.value || null })}
                />
              </td>
              <td className="col-actions">
                <button type="button" className="btn-remove" onClick={() => onRemove(charge.id)}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn-add" onClick={onAdd}>
        + Ajouter une charge fixe
      </button>
    </div>
  );
}
