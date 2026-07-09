"use client";

import { useMemo } from "react";
import { Financement } from "@/lib/types";
import { trierParDate } from "@/lib/dates";
import { filtrerFinancements } from "@/lib/recherche";
import DateField from "./DateField";

interface FinancementsTableProps {
  financements: Financement[];
  onChange: (id: string, patch: Partial<Financement>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  recherche: string;
}

export default function FinancementsTable({
  financements,
  onChange,
  onAdd,
  onRemove,
  recherche,
}: FinancementsTableProps) {
  const financementsTries = useMemo(
    () => filtrerFinancements(trierParDate(financements, (f) => f.dateEncaissementPrevue), recherche),
    [financements, recherche]
  );

  return (
    <div className="table-wrapper">
      <h3>Financements</h3>
      {recherche && financementsTries.length === 0 ? (
        <p className="recherche-vide">Aucun résultat dans cette section</p>
      ) : (
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
                <DateField
                  value={financement.dateEncaissementPrevue}
                  onChange={(valeur) => onChange(financement.id, { dateEncaissementPrevue: valeur })}
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
      )}
      <button type="button" className="btn-add" onClick={onAdd}>
        + Ajouter un financement
      </button>
    </div>
  );
}
