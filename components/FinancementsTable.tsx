"use client";

import { useMemo } from "react";
import { Financement } from "@/lib/types";
import { trierParDate } from "@/lib/dates";

interface FinancementsTableProps {
  financements: Financement[];
  onChange: (id: string, patch: Partial<Financement>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}

export default function FinancementsTable({
  financements,
  onChange,
  onAdd,
  onRemove,
}: FinancementsTableProps) {
  const financementsTries = useMemo(
    () => trierParDate(financements, (f) => f.dateEncaissementPrevue),
    [financements]
  );

  return (
    <div className="table-wrapper">
      <h3>Financements</h3>
      <table className="invoice-table">
        <thead>
          <tr>
            <th>Libellé</th>
            <th className="col-montant">Montant</th>
            <th>Date d&apos;encaissement prévue</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {financementsTries.map((financement) => (
            <tr key={financement.id}>
              <td>
                <input
                  type="text"
                  value={financement.libelle}
                  onChange={(e) => onChange(financement.id, { libelle: e.target.value })}
                />
              </td>
              <td className="col-montant">
                <input
                  type="number"
                  value={financement.montant}
                  onChange={(e) => onChange(financement.id, { montant: Number(e.target.value) })}
                />
              </td>
              <td>
                <input
                  type="date"
                  value={financement.dateEncaissementPrevue}
                  onChange={(e) => onChange(financement.id, { dateEncaissementPrevue: e.target.value })}
                />
              </td>
              <td className="col-actions">
                <button type="button" className="btn-remove" onClick={() => onRemove(financement.id)}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn-add" onClick={onAdd}>
        + Ajouter un financement
      </button>
    </div>
  );
}
