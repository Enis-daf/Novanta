"use client";

import { FactureClient } from "@/lib/types";
import { formatDate, formatMontant } from "@/lib/format";
import { decalerDateISO } from "@/lib/dates";

interface FacturesClientsTableProps {
  factures: FactureClient[];
  onChange: (id: string, patch: Partial<FactureClient>) => void;
}

export default function FacturesClientsTable({ factures, onChange }: FacturesClientsTableProps) {
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
          </tr>
        </thead>
        <tbody>
          {factures.map((facture) => (
            <tr key={facture.id} className={facture.litigieuse ? "row--litigieuse" : ""}>
              <td>{facture.facture}</td>
              <td>{facture.client}</td>
              <td className="col-montant">{formatMontant(facture.montant)}</td>
              <td>{formatDate(facture.dateEcheance)}</td>
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
