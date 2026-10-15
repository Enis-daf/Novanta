"use client";

import { MENTION_HT_ESTIME, MENTION_TTC } from "@/lib/format";
import { BaseMontants } from "@/lib/pastHtEstime";

const OPTIONS: { base: BaseMontants; libelle: string }[] = [
  { base: "ttc", libelle: MENTION_TTC },
  { base: "ht", libelle: MENTION_HT_ESTIME },
];

/**
 * Lecture des montants du reporting : TTC (les transactions telles quelles, par défaut) ou HT
 * estimé (lib/pastHtEstime.ts). Ne change que l'affichage : aucune donnée n'est modifiée, et la
 * trésorerie reste TTC dans les deux lectures.
 */
export default function PasseSelecteurBase({ base, onChange }: { base: BaseMontants; onChange: (base: BaseMontants) => void }) {
  return (
    <div className="passe-tri passe-selecteur-base" role="group" aria-label="Lecture des montants">
      {OPTIONS.map((option) => (
        <button
          key={option.base}
          type="button"
          className={`btn-secondaire${base === option.base ? " btn-module--actif" : ""}`}
          aria-pressed={base === option.base}
          onClick={() => onChange(option.base)}
        >
          {option.libelle}
        </button>
      ))}
    </div>
  );
}
