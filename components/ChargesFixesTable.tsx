"use client";

import { useMemo } from "react";
import { ChargeFixe, TriMode } from "@/lib/types";
import { trierParDate, trierParMontant } from "@/lib/dates";
import { filtrerChargesFixes } from "@/lib/recherche";
import DateField from "./DateField";

interface ChargesFixesTableProps {
  charges: ChargeFixe[];
  onChange: (id: string, patch: Partial<ChargeFixe>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  recherche: string;
  tri: TriMode;
}

export default function ChargesFixesTable({
  charges,
  onChange,
  onAdd,
  onRemove,
  recherche,
  tri,
}: ChargesFixesTableProps) {
  const chargesTriees = useMemo(() => {
    const filtrees = filtrerChargesFixes(charges, recherche);
    return tri === "montant"
      ? trierParMontant(filtrees, (c) => c.montant)
      : trierParDate(filtrees, (c) => c.datePrevue);
  }, [charges, recherche, tri]);

  return (
    <div className="table-wrapper">
      <h3>Charges fixes</h3>
      {recherche && chargesTriees.length === 0 ? (
        <p className="recherche-vide">Aucun résultat dans cette section</p>
      ) : (
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
          {chargesTriees.map((charge) => (
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
                <DateField
                  value={charge.datePrevue}
                  onChange={(valeur) => onChange(charge.id, { datePrevue: valeur })}
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
                <DateField
                  value={charge.dateFin ?? ""}
                  onChange={(valeur) => onChange(charge.id, { dateFin: valeur || null })}
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
      )}
      <button type="button" className="btn-add" onClick={onAdd}>
        + Ajouter une charge fixe
      </button>
    </div>
  );
}
