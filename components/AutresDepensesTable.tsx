"use client";

import { useMemo, useState } from "react";
import { AutreDepense, TriMode } from "@/lib/types";
import { trierParDate, trierParMontant } from "@/lib/dates";
import { filtrerAutresDepenses } from "@/lib/recherche";
import { OccurrencesParId } from "@/lib/periodeFiltre";
import {
  classerDepense,
  CORRESPONDANCE_VIDE,
  correspondAuFiltreEtage,
  CorrespondanceFutur,
  EtageDepense,
  FiltreEtage,
  idsAAffecter,
} from "@/lib/futurPnl";
import DateField from "./DateField";
import { CaseSelectionLigne, OutilsEtagePnl, SelecteurEtagePnl, useSelectionLignes } from "./EtagePnl";

interface AutresDepensesTableProps {
  depenses: AutreDepense[];
  onChange: (id: string, patch: Partial<AutreDepense>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  recherche: string;
  tri: TriMode;
  filtrePeriode?: OccurrencesParId | null;
  // Étage P&L (lib/futurPnl.ts) : écriture du seul choix manuel, classement par ligne.
  correspondance?: CorrespondanceFutur;
  onChangeEtage?: (ids: string[], etage: EtageDepense | null) => void;
}

export default function AutresDepensesTable({
  depenses,
  onChange,
  onAdd,
  onRemove,
  recherche,
  tri,
  filtrePeriode,
  correspondance = CORRESPONDANCE_VIDE,
  onChangeEtage,
}: AutresDepensesTableProps) {
  const [filtreEtage, setFiltreEtage] = useState<FiltreEtage>("tous");
  const { selection, basculer, basculerTout, vider } = useSelectionLignes();
  const depensesTriees = useMemo(() => {
    const dansPeriode = filtrePeriode ? depenses.filter((d) => filtrePeriode.has(d.id)) : depenses;
    const dansEtage = dansPeriode.filter((d) => correspondAuFiltreEtage(classerDepense(d, correspondance), filtreEtage));
    const filtrees = filtrerAutresDepenses(dansEtage, recherche);
    return tri === "montant"
      ? trierParMontant(filtrees, (d) => d.montant)
      : trierParDate(filtrees, (d) => d.datePrevue);
  }, [depenses, recherche, tri, filtrePeriode, filtreEtage, correspondance]);

  const filtreActif = !!recherche || !!filtrePeriode || filtreEtage !== "tous";
  const idsAffiches = depensesTriees.map((x) => x.id);
  const idsSelectionnes = idsAAffecter(selection, idsAffiches);
  const toutSelectionne = idsAffiches.length > 0 && idsSelectionnes.length === idsAffiches.length;

  return (
    <div className="table-wrapper">
      <h3>Autres dépenses</h3>
      {onChangeEtage && (
        <OutilsEtagePnl
          idSection="autres-depenses"
          filtre={filtreEtage}
          onChangeFiltre={setFiltreEtage}
          nombreSelectionnees={idsSelectionnes.length}
          onAffecter={(etage) => {
            onChangeEtage(idsSelectionnes, etage);
            vider();
          }}
          onDeselectionner={vider}
        />
      )}
      {filtreActif && depensesTriees.length === 0 ? (
        <p className="recherche-vide">Aucun résultat dans cette section</p>
      ) : (
      <table className="invoice-table">
        <thead>
          <tr>
            {onChangeEtage && (
              <th className="col-checkbox">
                <input
                  type="checkbox"
                  aria-label="Sélectionner toutes les dépenses affichées"
                  checked={toutSelectionne}
                  onChange={(e) => basculerTout(idsAffiches, e.target.checked)}
                />
              </th>
            )}
            <th>Libellé</th>
            <th className="col-montant">Montant</th>
            <th>Date prévue</th>
            <th>Type</th>
            {onChangeEtage && <th>Étage P&amp;L</th>}
            <th>Facturée</th>
            <th>Payée</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {depensesTriees.map((depense) => (
            <tr key={depense.id} className={depense.facturee || depense.payee ? "row--litigieuse" : ""}>
              {onChangeEtage && (
                <td className="col-checkbox">
                  <CaseSelectionLigne
                    coche={selection.has(depense.id)}
                    libelleLigne={depense.libelle}
                    onChange={(coche) => basculer(depense.id, coche)}
                  />
                </td>
              )}
              <td>
                <input
                  type="text"
                  value={depense.libelle}
                  onChange={(e) => onChange(depense.id, { libelle: e.target.value })}
                />
              </td>
              <td className="col-montant">
                <input
                  type="number"
                  value={depense.montant}
                  onChange={(e) => onChange(depense.id, { montant: Number(e.target.value) })}
                />
              </td>
              <td>
                <DateField
                  value={depense.datePrevue}
                  onChange={(valeur) => onChange(depense.id, { datePrevue: valeur })}
                />
              </td>
              <td>
                <select
                  value={depense.type}
                  onChange={(e) => onChange(depense.id, { type: e.target.value as AutreDepense["type"] })}
                >
                  <option value="certaine">Certaine</option>
                  <option value="probable">Probable</option>
                </select>
              </td>
              {onChangeEtage && (
                <td>
                  <SelecteurEtagePnl
                    classement={classerDepense(depense, correspondance)}
                    libelleLigne={depense.libelle}
                    onChange={(etage) => onChangeEtage([depense.id], etage)}
                  />
                </td>
              )}
              <td className="col-checkbox">
                <span
                  className="checkbox-tooltip"
                  title="Exclut cette dépense des projections pour éviter un doublon avec la facture fournisseur correspondante."
                >
                  <input
                    type="checkbox"
                    checked={depense.facturee}
                    title="Exclut cette dépense des projections pour éviter un doublon avec la facture fournisseur correspondante."
                    onChange={(e) => onChange(depense.id, { facturee: e.target.checked })}
                  />
                </span>
              </td>
              <td className="col-checkbox">
                <span
                  className="checkbox-tooltip"
                  title="Exclut cette dépense des projections car elle est déjà comptée dans le Solde bancaire initial."
                >
                  <input
                    type="checkbox"
                    checked={depense.payee}
                    title="Exclut cette dépense des projections car elle est déjà comptée dans le Solde bancaire initial."
                    onChange={(e) => onChange(depense.id, { payee: e.target.checked })}
                  />
                </span>
              </td>
              <td className="col-actions">
                <button type="button" className="btn-remove" onClick={() => onRemove(depense.id)}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      )}
      <button type="button" className="btn-add" onClick={onAdd}>
        + Ajouter une dépense
      </button>
    </div>
  );
}
