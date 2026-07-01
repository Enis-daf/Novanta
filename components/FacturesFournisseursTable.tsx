"use client";

import { FactureFournisseur } from "@/lib/types";
import { formatDate, formatMontant } from "@/lib/format";
import { decalerDateISO } from "@/lib/dates";

interface FacturesFournisseursTableProps {
  factures: FactureFournisseur[];
  onChange: (id: string, patch: Partial<FactureFournisseur>) => void;
}

export default function FacturesFournisseursTable({ factures, onChange }: FacturesFournisseursTableProps) {
  return (
    <div className="table-wrapper">
      <h3>Factures fournisseurs</h3>
      <table className="invoice-table">
        <thead>
          <tr>
            <th>Facture</th>
            <th>Fournisseur</th>
            <th className="col-montant">Montant</th>
            <th>Échéance</th>
            <th>Paiement prévu</th>
            <th>Décalage rapide</th>
            <th>Litigieuse</th>
          </tr>
        </thead>
        <tbody>
          {factures.map((facture) => (
            <tr key={facture.id} className={facture.litigieuse ? "row--litigieuse" : ""}>
              <td>{facture.facture}</td>
              <td>{facture.fournisseur}</td>
              <td className="col-montant">{formatMontant(facture.montant)}</td>
              <td>{formatDate(facture.dateEcheance)}</td>
              <td>
                <input
                  type="date"
                  value={facture.datePaiementPrevue}
                  onChange={(e) => onChange(facture.id, { datePaiementPrevue: e.target.value })}
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
                        datePaiementPrevue: decalerDateISO(facture.datePaiementPrevue, jours),
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
