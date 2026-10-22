"use client";

import { useState } from "react";
import {
  ClassementDepense,
  ETAGES_DEPENSE,
  EtageDepense,
  estEtageDepense,
  estFiltreEtage,
  FiltreEtage,
  infobulleClassement,
  LIBELLE_A_CLASSER,
  LIBELLE_AFFECTER_ETAGE,
  LIBELLE_REPRENDRE_AUTOMATIQUE,
} from "@/lib/futurPnl";

const REPRENDRE_AUTOMATIQUE = "__reprendre_automatique__";

/**
 * Cellule « Étage P&L » d'une dépense : sélecteur compact, modifiable directement dans le tableau.
 * La provenance (correspondance P&L ou choix fait dans Futur) n'est donnée que par l'infobulle :
 * aucun badge par ligne. « Reprendre le classement automatique » n'apparaît que sur un choix manuel.
 */
export function SelecteurEtagePnl({
  classement,
  libelleLigne,
  onChange,
}: {
  classement: ClassementDepense;
  libelleLigne: string;
  onChange: (etage: EtageDepense | null) => void;
}) {
  return (
    <select
      className={`etage-pnl${classement.etage === null ? " etage-pnl--a-classer" : ""}`}
      aria-label={`Étage P&L de ${libelleLigne || "cette ligne"}`}
      title={infobulleClassement(classement)}
      value={classement.etage ?? ""}
      onChange={(e) => {
        const valeur = e.target.value;
        if (valeur === REPRENDRE_AUTOMATIQUE) onChange(null);
        else if (estEtageDepense(valeur)) onChange(valeur);
      }}
    >
      {classement.etage === null && <option value="">{LIBELLE_A_CLASSER}</option>}
      {ETAGES_DEPENSE.map((etage) => (
        <option key={etage.cle} value={etage.cle}>
          {etage.libelle}
        </option>
      ))}
      {classement.provenance === "manuel" && <option value={REPRENDRE_AUTOMATIQUE}>{LIBELLE_REPRENDRE_AUTOMATIQUE}</option>}
    </select>
  );
}

/** Case de sélection d'une ligne, pour « Affecter un étage P&L ». */
export function CaseSelectionLigne({
  coche,
  libelleLigne,
  onChange,
}: {
  coche: boolean;
  libelleLigne: string;
  onChange: (coche: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      checked={coche}
      aria-label={`Sélectionner ${libelleLigne || "cette ligne"}`}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/**
 * Au-dessus d'un tableau de dépenses : filtre par étage (affichage seulement : la projection de
 * trésorerie n'en dépend pas) et, quand des lignes sont cochées, « Affecter un étage P&L ».
 */
export function OutilsEtagePnl({
  idSection,
  filtre,
  onChangeFiltre,
  nombreSelectionnees,
  onAffecter,
  onDeselectionner,
}: {
  idSection: string;
  filtre: FiltreEtage;
  onChangeFiltre: (filtre: FiltreEtage) => void;
  nombreSelectionnees: number;
  onAffecter: (etage: EtageDepense) => void;
  onDeselectionner: () => void;
}) {
  const [etageAAffecter, setEtageAAffecter] = useState<EtageDepense | "">("");
  return (
    <div className="etage-pnl-outils">
      <label className="etage-pnl-outils__label" htmlFor={`${idSection}-filtre-etage`}>
        Étage P&amp;L
      </label>
      <select
        id={`${idSection}-filtre-etage`}
        className="etage-pnl"
        value={filtre}
        onChange={(e) => estFiltreEtage(e.target.value) && onChangeFiltre(e.target.value)}
      >
        <option value="tous">Tous les étages</option>
        <option value="a_classer">{LIBELLE_A_CLASSER}</option>
        {ETAGES_DEPENSE.map((etage) => (
          <option key={etage.cle} value={etage.cle}>
            {etage.libelle}
          </option>
        ))}
      </select>
      {nombreSelectionnees > 0 && (
        <span className="etage-pnl-outils__lot">
          <span>
            {nombreSelectionnees} ligne{nombreSelectionnees > 1 ? "s" : ""} sélectionnée{nombreSelectionnees > 1 ? "s" : ""}
          </span>
          <select
            className="etage-pnl"
            aria-label={LIBELLE_AFFECTER_ETAGE}
            value={etageAAffecter}
            onChange={(e) => setEtageAAffecter(estEtageDepense(e.target.value) ? e.target.value : "")}
          >
            <option value="">{LIBELLE_AFFECTER_ETAGE}…</option>
            {ETAGES_DEPENSE.map((etage) => (
              <option key={etage.cle} value={etage.cle}>
                {etage.libelle}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-secondaire"
            disabled={etageAAffecter === ""}
            onClick={() => {
              if (etageAAffecter === "") return;
              onAffecter(etageAAffecter);
              setEtageAAffecter("");
            }}
          >
            Affecter
          </button>
          <button type="button" className="etage-pnl-outils__lien" onClick={onDeselectionner}>
            Désélectionner
          </button>
        </span>
      )}
    </div>
  );
}

/** Sélection de lignes d'un tableau (ids), remise à zéro à la demande. */
export function useSelectionLignes() {
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const basculer = (id: string, coche: boolean) =>
    setSelection((prev) => {
      const suivant = new Set(prev);
      if (coche) suivant.add(id);
      else suivant.delete(id);
      return suivant;
    });
  const basculerTout = (ids: readonly string[], coche: boolean) =>
    setSelection((prev) => {
      const suivant = new Set(prev);
      for (const id of ids) {
        if (coche) suivant.add(id);
        else suivant.delete(id);
      }
      return suivant;
    });
  return { selection, basculer, basculerTout, vider: () => setSelection(new Set()) };
}
