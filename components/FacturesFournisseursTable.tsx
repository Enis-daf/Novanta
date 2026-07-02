"use client";

import { FactureFournisseur } from "@/lib/types";
import { decalerDateISO } from "@/lib/dates";

interface FacturesFournisseursTableProps {
  factures: FactureFournisseur[];
  onChange: (id: string, patch: Partial<FactureFournisseur>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}

export default function FacturesFournisseursTable({
  factures,
  onChange,
  onAdd,
  onRemove,
}: FacturesFournisseursTableProps) {
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
                  value={facture.fournisseur}
                  onChange={(e) => onChange(facture.id, { fournisseur: e.target.value })}
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
        + Ajouter une facture fournisseur
      </button>
    </div>
  );
}
