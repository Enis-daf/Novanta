"use client";

import { useMemo } from "react";
import { ChargeFixe, RentreeReguliere, TriMode } from "@/lib/types";
import { formatDateCourte, parseDateISO, trierParDate, trierParMontant } from "@/lib/dates";
import { formatMontant } from "@/lib/format";
import { filtrerChargesFixes } from "@/lib/recherche";
import { OccurrencesParId, PeriodeFiltre } from "@/lib/periodeFiltre";
import {
  detailChargeFixeSurPeriode,
  libelleSourceCalcul,
  messageMontantIndisponible,
  montantApercuChargeFixe,
  optionsSourceDisponibles,
} from "@/lib/montantCalcule";
import DateField from "./DateField";
import SourceCalculSelect from "./SourceCalculSelect";
import IconCalculatrice from "./IconCalculatrice";

interface ChargesFixesTableProps {
  charges: ChargeFixe[];
  rentreesRegulieres: RentreeReguliere[];
  onChange: (id: string, patch: Partial<ChargeFixe>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  recherche: string;
  tri: TriMode;
  filtrePeriode?: OccurrencesParId | null;
  periodeFiltre?: PeriodeFiltre | null;
}

export default function ChargesFixesTable({
  charges,
  rentreesRegulieres,
  onChange,
  onAdd,
  onRemove,
  recherche,
  tri,
  filtrePeriode,
  periodeFiltre,
}: ChargesFixesTableProps) {
  const chargesTriees = useMemo(() => {
    const dansPeriode = filtrePeriode ? charges.filter((c) => filtrePeriode.has(c.id)) : charges;
    const filtrees = filtrerChargesFixes(dansPeriode, recherche);
    return tri === "montant"
      ? trierParMontant(filtrees, (c) => montantApercuChargeFixe(c, charges, rentreesRegulieres) ?? Number.NaN)
      : trierParDate(filtrees, (c) => c.datePrevue);
  }, [charges, rentreesRegulieres, recherche, tri, filtrePeriode]);

  const filtreActif = !!recherche || !!filtrePeriode;

  return (
    <div className="table-wrapper">
      <h3>Charges fixes</h3>
      {filtreActif && chargesTriees.length === 0 ? (
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
            <th>À couper</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {chargesTriees.map((charge) => {
            const occurrences = filtrePeriode?.get(charge.id);
            const estCalculee = charge.modeMontant === "calcule";
            const montantCalcule = estCalculee
              ? montantApercuChargeFixe(charge, charges, rentreesRegulieres)
              : null;
            const sourceLibelle = estCalculee ? libelleSourceCalcul(charge, charges, rentreesRegulieres) : null;
            const sourceSaisonnalisee =
              estCalculee &&
              charge.sourceCalculType === "rentree_reguliere" &&
              rentreesRegulieres.find((r) => r.id === charge.sourceCalculId)?.modeMontant === "saisonnalise";
            // Aperçu contextuel à la plage sélectionnée sur la courbe (D-3..D+3 autour du clic) :
            // remplace l'aperçu par défaut (2e occurrence) uniquement quand un filtre est actif ET
            // que cette charge a des occurrences dans la plage (sinon la ligne n'est pas affichée
            // du tout — voir filtrePeriode plus haut, qui masque déjà les lignes sans occurrence).
            // En mode filtré, un résultat indisponible (detailPeriode = null) reste indisponible :
            // on ne retombe jamais silencieusement sur l'aperçu par défaut, qui serait trompeur.
            const enModeFiltre = estCalculee && !!periodeFiltre && !!occurrences && occurrences.length > 0;
            const detailPeriode = enModeFiltre
              ? detailChargeFixeSurPeriode(charge, occurrences!, charges, rentreesRegulieres, parseDateISO(periodeFiltre!.fin))
              : null;
            const montantAffiche = enModeFiltre ? (detailPeriode ? detailPeriode.montantCharge : null) : montantCalcule;
            return (
            <tr key={charge.id} className={charge.aCouper ? "row--litigieuse" : ""}>
              <td>
                <input
                  type="text"
                  value={charge.libelle}
                  onChange={(e) => onChange(charge.id, { libelle: e.target.value })}
                />
                {occurrences && occurrences.length > 0 && (
                  <p className="occurrences-periode">
                    Occurrences dans la période : {occurrences.map(formatDateCourte).join(", ")}
                  </p>
                )}
              </td>
              <td className={`col-montant ${estCalculee ? "col-montant--calcule" : ""}`}>
                <div className="mode-montant-toggle">
                  <button
                    type="button"
                    className={charge.modeMontant === "fixe" ? "actif" : ""}
                    onClick={() => onChange(charge.id, { modeMontant: "fixe" })}
                  >
                    Fixe
                  </button>
                  <button
                    type="button"
                    className={estCalculee ? "actif" : ""}
                    onClick={() => onChange(charge.id, { modeMontant: "calcule" })}
                  >
                    Calculé
                  </button>
                </div>
                {!estCalculee ? (
                  <input
                    type="number"
                    value={charge.montant}
                    onChange={(e) => onChange(charge.id, { montant: Number(e.target.value) })}
                  />
                ) : (
                  <div className="charge-calcul">
                    <div className="charge-calcul__regle">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        className="charge-calcul__taux"
                        placeholder="—"
                        value={charge.tauxCalcul ?? ""}
                        onChange={(e) => {
                          const valeur = e.target.value;
                          onChange(charge.id, { tauxCalcul: valeur === "" ? null : Number(valeur) });
                        }}
                      />
                      <span>% de</span>
                      <SourceCalculSelect
                        options={optionsSourceDisponibles(charge, charges, rentreesRegulieres)}
                        valeur={
                          charge.sourceCalculId && charge.sourceCalculType
                            ? { type: charge.sourceCalculType, id: charge.sourceCalculId }
                            : null
                        }
                        onChange={(type, id) => onChange(charge.id, { sourceCalculType: type, sourceCalculId: id })}
                      />
                    </div>
                    {montantAffiche === null ? (
                      <p className="charge-calcul__indisponible">
                        {messageMontantIndisponible(charge, charges, rentreesRegulieres)}
                      </p>
                    ) : (
                      <>
                        <p
                          className="charge-calcul__apercu"
                          title={
                            enModeFiltre
                              ? `Montant calculé : ${charge.tauxCalcul}% de ${sourceLibelle} (${formatMontant(
                                  detailPeriode!.montantSource
                                )} sur la période sélectionnée)`
                              : `Montant calculé : ${charge.tauxCalcul}% de ${sourceLibelle}`
                          }
                        >
                          = {formatMontant(montantAffiche)} <IconCalculatrice />
                        </p>
                        <p className="charge-calcul__hint">
                          {enModeFiltre
                            ? `Sur la période du ${formatDateCourte(periodeFiltre!.debut)} au ${formatDateCourte(periodeFiltre!.fin)}.`
                            : sourceSaisonnalisee
                              ? `Le montant varie chaque mois selon la saisonnalité de ${sourceLibelle}.`
                              : `Le montant se met à jour automatiquement lorsque ${sourceLibelle} change.`}
                        </p>
                      </>
                    )}
                  </div>
                )}
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
              <td className="col-checkbox">
                <input
                  type="checkbox"
                  checked={charge.aCouper}
                  title="Exclut cette dépense des projections sans supprimer la donnée."
                  onChange={(e) => onChange(charge.id, { aCouper: e.target.checked })}
                />
              </td>
              <td className="col-actions">
                <button type="button" className="btn-remove" onClick={() => onRemove(charge.id)}>
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
        + Ajouter une charge fixe
      </button>
    </div>
  );
}
