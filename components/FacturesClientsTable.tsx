"use client";

import { FactureClient } from "@/lib/types";
import { decalerDateISO } from "@/lib/dates";

interface FacturesClientsTableProps {
  factures: FactureClient[];
  onChange: (id: string, patch: Partial<FactureClient>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}

export default function FacturesClientsTable({
  factures,
  onChange,
  onAdd,
  onRemove,
}: FacturesClientsTableProps) {
  return (
    <div className="table-wrapper">
      <h3>Factures clients</h3>
      <table className="invoice-table">
        <thead>
          <tr>
            <th>Facture</th>
            <th>Client</th>
            <th className="col-montant">Montant</th>
            <th>Échéance</th>
            <th>Encaissement anticipé</th>
            <th>Décalage rapide</th>
            <th>Litigieuse</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {factures.map((facture) => (
            <tr key={facture.id} className={facture.litigieuse ? "row--litigieuse" : ""}>
              <td>
                <input
                  type="text"
                  value={facture.facture}
                  onChange={(e) => onChange(facture.id, { facture: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="text"
                  value={facture.client}
                  onChange={(e) => onChange(facture.id, { client: e.target.value })}
                />
              </td>
              <td className="col-montant">
                <input
                  type="number"
                  min="0"
                  value={facture.montant}
                  onChange={(e) => onChange(facture.id, { montant: Math.abs(Number(e.target.value) || 0) })}
                />
              </td>
              <td>
                <input
                  type="date"
                  value={facture.dateEcheance}
                  onChange={(e) => onChange(facture.id, { dateEcheance: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="date"
                  value={facture.dateEncaissementAnticipee}
                  onChange={(e) => onChange(facture.id, { dateEncaissementAnticipee: e.target.value })}
                />
              </td>
              <td className="col-actions">
                {[7, 15, 30].map((jours) => (
                  <button
                    key={jours}
                    type="button"
                    className="btn-shift"
                    onClick={() =>
                      onChange(facture.id, {
                        dateEncaissementAnticipee: decalerDateISO(facture.dateEncaissementAnticipee, jours),
                      })
                    }
                  >
                    +{jours}j
                  </button>
                ))}
              </td>
              <td className="col-checkbox">
                <input
                  type="checkbox"
                  checked={facture.litigieuse}
                  onChange={(e) => onChange(facture.id, { litigieuse: e.target.checked })}
                />
              </td>
              <td className="col-actions">
                <button
                  type="button"
                  className="btn-remove"
                  onClick={() => {
                    if (window.confirm("Supprimer cette facture ?")) onRemove(facture.id);
                  }}
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn-add" onClick={onAdd}>
        + Ajouter une facture client
      </button>
    </div>
  );
}
