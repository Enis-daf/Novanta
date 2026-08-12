"use client";

import { Fragment, useMemo } from "react";
import { RentreeReguliere, TriMode } from "@/lib/types";
import { formatDateCourte, trierParDate, trierParMontant } from "@/lib/dates";
import { filtrerRentreesRegulieres } from "@/lib/recherche";
import { OccurrencesParId } from "@/lib/periodeFiltre";
import {
  etatTotalPonderations,
  montantMoisBrut,
  montantOccurrenceRentreeReguliere,
  profilDepuisMontants,
  repartitionUniforme,
  totalPonderations,
} from "@/lib/saisonnalite";
import DateField from "./DateField";

interface RentreesRegulieresTableProps {
  rentrees: RentreeReguliere[];
  onChange: (id: string, patch: Partial<RentreeReguliere>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  recherche: string;
  tri: TriMode;
  filtrePeriode?: OccurrencesParId | null;
}

const NOMS_MOIS_COURTS = [
  "Janv.",
  "Févr.",
  "Mars",
  "Avr.",
  "Mai",
  "Juin",
  "Juil.",
  "Août",
  "Sept.",
  "Oct.",
  "Nov.",
  "Déc.",
];

function arrondirPourcentageAffiche(p: number): number {
  return Math.round(p * 100) / 100;
}

/** Montant "représentatif" d'une rentrée pour le tri et la conversion : le mois calendaire courant. */
function montantRepresentatif(rentree: RentreeReguliere): number | null {
  return montantOccurrenceRentreeReguliere(rentree, new Date());
}

export default function RentreesRegulieresTable({
  rentrees,
  onChange,
  onAdd,
  onRemove,
  recherche,
  tri,
  filtrePeriode,
}: RentreesRegulieresTableProps) {
  const rentreesTriees = useMemo(() => {
    const dansPeriode = filtrePeriode ? rentrees.filter((r) => filtrePeriode.has(r.id)) : rentrees;
    const filtrees = filtrerRentreesRegulieres(dansPeriode, recherche);
    return tri === "montant"
      ? trierParMontant(filtrees, (r) => montantRepresentatif(r) ?? Number.NaN)
      : trierParDate(filtrees, (r) => r.dateDebut);
  }, [rentrees, recherche, tri, filtrePeriode]);

  const filtreActif = !!recherche || !!filtrePeriode;

  return (
    <div className="table-wrapper">
      <h3>Rentrées régulières</h3>
      {filtreActif && rentreesTriees.length === 0 ? (
        <p className="recherche-vide">Aucun résultat dans cette section</p>
      ) : (
      <table className="invoice-table">
        <thead>
          <tr>
            <th>Libellé</th>
            <th className="col-montant">Montant</th>
            <th>Date de début</th>
            <th>Fréquence</th>
            <th>Date de fin</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rentreesTriees.map((rentree) => {
            const occurrences = filtrePeriode?.get(rentree.id);
            const estSaisonnalisee = rentree.modeMontant === "saisonnalise";
            const profil = rentree.profilSaisonnalite;
            const total = profil ? totalPonderations(profil.ponderationsMensuelles) : 0;
            const etatTotal = profil ? etatTotalPonderations(total) : "invalide";
            return (
            <Fragment key={rentree.id}>
            <tr>
              <td>
                <input
                  type="text"
                  value={rentree.libelle}
                  onChange={(e) => onChange(rentree.id, { libelle: e.target.value })}
                />
                {occurrences && occurrences.length > 0 && (
                  <p className="occurrences-periode">
                    Occurrences dans la période : {occurrences.map(formatDateCourte).join(", ")}
                  </p>
                )}
              </td>
              <td className={`col-montant ${estSaisonnalisee ? "col-montant--calcule" : ""}`}>
                <div className="mode-montant-toggle">
                  <button
                    type="button"
                    className={!estSaisonnalisee ? "actif" : ""}
                    onClick={() => onChange(rentree.id, { modeMontant: "fixe" })}
                  >
                    Fixe
                  </button>
                  <button
                    type="button"
                    className={estSaisonnalisee ? "actif" : ""}
                    onClick={() => onChange(rentree.id, { modeMontant: "saisonnalise" })}
                  >
                    Saisonnalisé
                  </button>
                </div>
                {!estSaisonnalisee || !profil ? (
                  <input
                    type="number"
                    min="0"
                    value={rentree.montant}
                    onChange={(e) => onChange(rentree.id, { montant: Math.abs(Number(e.target.value) || 0) })}
                  />
                ) : (
                  <div className="rentree-saisonnalite">
                    <div className="rentree-saisonnalite__annuel">
                      <label>Montant annuel</label>
                      <input
                        type="number"
                        min="0"
                        value={profil.montantAnnuel}
                        onChange={(e) =>
                          onChange(rentree.id, {
                            profilSaisonnalite: { ...profil, montantAnnuel: Math.abs(Number(e.target.value) || 0) },
                          })
                        }
                      />
                    </div>
                    <div className="rentree-saisonnalite__entetes">
                      <span>Mois</span>
                      <span>%</span>
                      <span>Montant</span>
                    </div>
                    <div className="rentree-saisonnalite__grille">
                      {NOMS_MOIS_COURTS.map((nomMois, index) => (
                        <div className="rentree-saisonnalite__ligne" key={nomMois}>
                          <span className="rentree-saisonnalite__mois">{nomMois}</span>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            className="rentree-saisonnalite__poids"
                            value={arrondirPourcentageAffiche(profil.ponderationsMensuelles[index])}
                            onChange={(e) => {
                              const valeur = Math.max(0, Number(e.target.value) || 0);
                              const ponderations = profil.ponderationsMensuelles.map((p, i) =>
                                i === index ? valeur : p
                              );
                              onChange(rentree.id, {
                                profilSaisonnalite: { ...profil, ponderationsMensuelles: ponderations },
                              });
                            }}
                          />
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            className="rentree-saisonnalite__montant"
                            value={montantMoisBrut(profil, index)}
                            onChange={(e) => {
                              const nouveauMontant = Math.abs(Number(e.target.value) || 0);
                              const montantsMensuels = NOMS_MOIS_COURTS.map((_, i) =>
                                i === index ? nouveauMontant : montantMoisBrut(profil, i)
                              );
                              onChange(rentree.id, { profilSaisonnalite: profilDepuisMontants(montantsMensuels) });
                            }}
                          />
                        </div>
                      ))}
                    </div>
                    <p
                      className={`rentree-saisonnalite__total ${
                        etatTotal === "invalide" ? "rentree-saisonnalite__total--invalide" : ""
                      }`}
                    >
                      Total : {arrondirPourcentageAffiche(total)} %
                      {etatTotal === "invalide" &&
                        (total < 100
                          ? ` — Il manque ${arrondirPourcentageAffiche(100 - total)} %`
                          : ` — Dépassement de ${arrondirPourcentageAffiche(total - 100)} %`)}
                    </p>
                    {etatTotal === "invalide" && (
                      <p className="charge-calcul__indisponible">
                        Le total des pondérations doit être égal à 100 %.
                      </p>
                    )}
                    {etatTotal === "normalisable" && (
                      <p className="charge-calcul__hint">
                        Répartition ajustée automatiquement pour atteindre 100 %.
                      </p>
                    )}
                    <button
                      type="button"
                      className="btn-secondaire rentree-saisonnalite__uniforme"
                      onClick={() =>
                        onChange(rentree.id, {
                          profilSaisonnalite: { ...profil, ponderationsMensuelles: repartitionUniforme() },
                        })
                      }
                    >
                      Répartition uniforme
                    </button>
                  </div>
                )}
              </td>
              <td>
                <DateField
                  value={rentree.dateDebut}
                  onChange={(valeur) => onChange(rentree.id, { dateDebut: valeur })}
                />
              </td>
              <td>
                <select
                  value={rentree.frequence}
                  onChange={(e) =>
                    onChange(rentree.id, { frequence: e.target.value as RentreeReguliere["frequence"] })
                  }
                >
                  <option value="ponctuel">Ponctuel</option>
                  <option value="quotidien">Quotidien</option>
                  <option value="hebdomadaire">Hebdomadaire</option>
                  <option value="mensuel">Mensuel</option>
                </select>
              </td>
              <td>
                <DateField
                  value={rentree.dateFin ?? ""}
                  onChange={(valeur) => onChange(rentree.id, { dateFin: valeur || null })}
                />
              </td>
              <td className="col-actions">
                <button type="button" className="btn-remove" onClick={() => onRemove(rentree.id)}>
                  ×
                </button>
              </td>
            </tr>
            {estSaisonnalisee && profil && (
              <tr className="rentree-saisonnalite__ligne-aide">
                <td></td>
                <td></td>
                <td colSpan={3} className="rentree-saisonnalite__aide-cellule">
                  <p className="rentree-saisonnalite__aide">
                    Ajoutez le montant annuel, répartissez le pourcentage par mois, puis ajustez directement un
                    montant si besoin. Le total et les pourcentages se recalculent automatiquement.
                  </p>
                </td>
                <td></td>
              </tr>
            )}
            </Fragment>
            );
          })}
        </tbody>
      </table>
      )}
      <button type="button" className="btn-add" onClick={onAdd}>
        + Ajouter une rentrée régulière
      </button>
    </div>
  );
}
