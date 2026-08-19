"use client";

import { useMemo } from "react";
import { FactureClient, TriMode } from "@/lib/types";
import {
  decalerDateISO,
  estDateValide,
  estEnRetard,
  estMasqueeApresPaiement,
  trierParDate,
  trierParMontant,
} from "@/lib/dates";
import { filtrerFacturesClients } from "@/lib/recherche";
import { OccurrencesParId } from "@/lib/periodeFiltre";
import DateField from "./DateField";

interface FacturesClientsTableProps {
  factures: FactureClient[];
  onChange: (id: string, patch: Partial<FactureClient>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  recherche: string;
  tri: TriMode;
  filtrePeriode?: OccurrencesParId | null;
}

export default function FacturesClientsTable({
  factures,
  onChange,
  onAdd,
  onRemove,
  recherche,
  tri,
  filtrePeriode,
}: FacturesClientsTableProps) {
  const facturesTriees = useMemo(() => {
    const actives = factures.filter((f) => !estMasqueeApresPaiement(f.payee, f.paidAt));
    const dansPeriode = filtrePeriode ? actives.filter((f) => filtrePeriode.has(f.id)) : actives;
    const filtrees = filtrerFacturesClients(dansPeriode, recherche);
    return tri === "montant"
      ? trierParMontant(filtrees, (f) => f.montant)
      : trierParDate(filtrees, (f) => f.dateEncaissementAnticipee);
  }, [factures, recherche, tri, filtrePeriode]);

  const filtreActif = !!recherche || !!filtrePeriode;

  return (
    <div className="table-wrapper">
      <h3>Factures clients</h3>
      {filtreActif && facturesTriees.length === 0 ? (
        <p className="recherche-vide">Aucun résultat dans cette section</p>
      ) : (
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
            <th>Payée</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {facturesTriees.map((facture) => {
            const enRetard = estEnRetard(facture.dateEncaissementAnticipee, facture.payee, facture.litigieuse);
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
                <DateField
                  value={facture.dateEcheance}
                  onChange={(valeur) => onChange(facture.id, { dateEcheance: valeur })}
                />
              </td>
              <td>
                <DateField
                  className={enRetard ? "date-retard" : ""}
                  value={facture.dateEncaissementAnticipee}
                  onChange={(valeur) => onChange(facture.id, { dateEncaissementAnticipee: valeur })}
                />
                {enRetard && <span className="badge-retard">En retard</span>}
              </td>
              <td className="col-actions">
                {[7, 15, 30].map((jours) => (
                  <button
                    key={jours}
                    type="button"
                    className="btn-shift"
                    disabled={!estDateValide(facture.dateEncaissementAnticipee)}
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
                <span
                  className="checkbox-tooltip"
                  title="Exclut cette facture des projections car son paiement ou son encaissement est incertain."
                >
                  <input
                    type="checkbox"
                    checked={facture.litigieuse}
                    title="Exclut cette facture des projections car son paiement ou son encaissement est incertain."
                    onChange={(e) => onChange(facture.id, { litigieuse: e.target.checked })}
                  />
                </span>
              </td>
              <td className="col-checkbox">
                <span
                  className="checkbox-tooltip"
                  title="Exclut cette facture des projections car elle est déjà comptée dans le Solde bancaire initial."
                >
                  <input
                    type="checkbox"
                    checked={facture.payee}
                    title="Exclut cette facture des projections car elle est déjà comptée dans le Solde bancaire initial."
                    onChange={(e) =>
                      onChange(facture.id, {
                        payee: e.target.checked,
                        paidAt: e.target.checked ? new Date().toISOString() : null,
                      })
                    }
                  />
                </span>
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
        + Ajouter une facture client
      </button>
    </div>
  );
}
