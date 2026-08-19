"use client";

import { useMemo } from "react";
import { Financement, TriMode } from "@/lib/types";
import { trierParDate, trierParMontant } from "@/lib/dates";
import { filtrerFinancements } from "@/lib/recherche";
import { OccurrencesParId } from "@/lib/periodeFiltre";
import DateField from "./DateField";

interface FinancementsTableProps {
  financements: Financement[];
  onChange: (id: string, patch: Partial<Financement>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  recherche: string;
  tri: TriMode;
  filtrePeriode?: OccurrencesParId | null;
}

export default function FinancementsTable({
  financements,
  onChange,
  onAdd,
  onRemove,
  recherche,
  tri,
  filtrePeriode,
}: FinancementsTableProps) {
  const financementsTries = useMemo(() => {
    const dansPeriode = filtrePeriode ? financements.filter((f) => filtrePeriode.has(f.id)) : financements;
    const filtrees = filtrerFinancements(dansPeriode, recherche);
    return tri === "montant"
      ? trierParMontant(filtrees, (f) => f.montant)
      : trierParDate(filtrees, (f) => f.dateEncaissementPrevue);
  }, [financements, recherche, tri, filtrePeriode]);

  const filtreActif = !!recherche || !!filtrePeriode;

  return (
    <div className="table-wrapper">
      <h3>Financements</h3>
      {filtreActif && financementsTries.length === 0 ? (
        <p className="recherche-vide">Aucun résultat dans cette section</p>
      ) : (
      <table className="invoice-table">
        <thead>
          <tr>
            <th>Libellé</th>
            <th className="col-montant">Montant</th>
            <th>Date d&apos;encaissement prévue</th>
            <th>Versé</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {financementsTries.map((financement) => (
            <tr key={financement.id} className={financement.verse ? "row--litigieuse" : ""}>
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
              <td className="col-checkbox">
                <input
                  type="checkbox"
                  checked={financement.verse}
                  title="Exclut ce financement des projections car les fonds sont déjà comptés dans le Solde bancaire initial."
                  onChange={(e) => onChange(financement.id, { verse: e.target.checked })}
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
