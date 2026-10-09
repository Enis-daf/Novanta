"use client";

import DateField from "./DateField";
import { formatDateCourte } from "@/lib/dates";
import {
  CataloguePresets,
  ChoixPeriode,
  ConfigExercice,
  periodeDeLaSelection,
  periodeDuPreset,
  PRESETS_PERIODE,
  selectionApresChoix,
  selectionApresSaisie,
  SelectionPeriode,
} from "@/lib/fiscalPeriods";

interface PasseSelecteurPeriodeProps {
  id: string;
  libelle: string;
  selection: SelectionPeriode;
  onChange: (selection: SelectionPeriode) => void;
  aujourdhui: string;
  configExercice: ConfigExercice;
  // Presets proposés ; par défaut les périodes fiscales du module.
  catalogue?: CataloguePresets;
}

// Sélecteur de période du module Passé : une liste de presets (avec leurs dates exactes) et deux
// champs de date libres. Toutes les règles viennent de lib/fiscalPeriods.ts — ce composant
// n'en calcule aucune, il sert aussi bien la période du module que les deux périodes comparées.
export default function PasseSelecteurPeriode({
  id,
  libelle,
  selection,
  onChange,
  aujourdhui,
  configExercice,
  catalogue = PRESETS_PERIODE,
}: PasseSelecteurPeriodeProps) {
  const periode = periodeDeLaSelection(selection, aujourdhui, configExercice);
  const groupes = [...new Set(catalogue.map((preset) => preset.groupe))];
  const saisir = (patch: { debut?: string; fin?: string }) =>
    onChange(selectionApresSaisie({ ...periode, ...patch }, aujourdhui, configExercice, catalogue));

  return (
    <>
      <label className="passe-controle__label" htmlFor={id}>
        {libelle}
      </label>
      <select
        id={id}
        value={selection.choix}
        onChange={(e) => onChange(selectionApresChoix(e.target.value as ChoixPeriode, selection, aujourdhui, configExercice))}
      >
        {groupes.map((groupe) => (
          <optgroup key={groupe} label={groupe}>
            {catalogue
              .filter((preset) => preset.groupe === groupe)
              .map((preset) => {
                const dates = periodeDuPreset(preset.cle, aujourdhui, configExercice);
                return (
                  <option key={preset.cle} value={preset.cle}>
                    {preset.libelle} — {formatDateCourte(dates.debut)} → {formatDateCourte(dates.fin)}
                  </option>
                );
              })}
          </optgroup>
        ))}
        <option value="personnalise">Personnalisé</option>
      </select>
      <DateField value={periode.debut} onChange={(v) => saisir({ debut: v })} effacable={false} />
      <span className="passe-controle__separateur">→</span>
      <DateField value={periode.fin} onChange={(v) => saisir({ fin: v })} effacable={false} />
    </>
  );
}
