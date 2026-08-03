"use client";

import { useMemo } from "react";
import { FactureFournisseur, TriMode } from "@/lib/types";
import {
  decalerDateISO,
  estDateValide,
  estEnRetard,
  estMasqueeApresPaiement,
  trierParDate,
  trierParMontant,
} from "@/lib/dates";
import { filtrerFacturesFournisseurs } from "@/lib/recherche";
import { OccurrencesParId } from "@/lib/periodeFiltre";
import DateField from "./DateField";

interface FacturesFournisseursTableProps {
  factures: FactureFournisseur[];
  onChange: (id: string, patch: Partial<FactureFournisseur>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  recherche: string;
  tri: TriMode;
  filtrePeriode?: OccurrencesParId | null;
}

export default function FacturesFournisseursTable({
  factures,
  onChange,
  onAdd,
  onRemove,
  recherche,
  tri,
  filtrePeriode,
}: FacturesFournisseursTableProps) {
  const facturesTriees = useMemo(() => {
    const actives = factures.filter((f) => !estMasqueeApresPaiement(f.payee, f.paidAt));
    const dansPeriode = filtrePeriode ? actives.filter((f) => filtrePeriode.has(f.id)) : actives;
    const filtrees = filtrerFacturesFournisseurs(dansPeriode, recherche);
    return tri === "montant"
      ? trierParMontant(filtrees, (f) => f.montant)
      : trierParDate(filtrees, (f) => f.datePaiementPrevue);
  }, [factures, recherche, tri, filtrePeriode]);

  const filtreActif = !!recherche || !!filtrePeriode;

  return (
    <div className="table-wrapper">
      <h3>Factures fournisseurs</h3>
      {filtreActif && facturesTriees.length === 0 ? (
        <p className="recherche-vide">Aucun résultat dans cette section</p>
      ) : (
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
            <th>Payée</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {facturesTriees.map((facture) => {
            const enRetard = estEnRetard(facture.datePaiementPrevue, facture.payee, facture.litigieuse);
            const rowClassName = [facture.litigieuse || facture.payee ? "row--litigieuse" : "", enRetard ? "row--en-retard" : ""]
              .filter(Boolean)
              .join(" ");
            return (
            <tr key={facture.id} className={rowClassName}>
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
                <DateField
                  value={facture.dateEcheance}
                  onChange={(valeur) => onChange(facture.id, { dateEcheance: valeur })}
                />
              </td>
              <td>
                <DateField
                  className={enRetard ? "date-retard" : ""}
                  value={facture.datePaiementPrevue}
                  onChange={(valeur) => onChange(facture.id, { datePaiementPrevue: valeur })}
                />
                {enRetard && <span className="badge-retard">En retard</span>}
              </td>
              <td className="col-actions">
                {[7, 15, 30].map((jours) => (
                  <button
                    key={jours}
                    type="button"
                    className="btn-shift"
                    disabled={!estDateValide(facture.datePaiementPrevue)}
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
              <td className="col-checkbox">
                <input
                  type="checkbox"
                  checked={facture.payee}
                  onChange={(e) =>
                    onChange(facture.id, {
                      payee: e.target.checked,
                      paidAt: e.target.checked ? new Date().toISOString() : null,
                    })
                  }
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
            );
          })}
        </tbody>
      </table>
      )}
      <button type="button" className="btn-add" onClick={onAdd}>
        + Ajouter une facture fournisseur
      </button>
    </div>
  );
}
