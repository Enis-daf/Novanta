"use client";

import { formatDate, formatMontantK } from "@/lib/format";
import { ResumePeriode } from "@/lib/periodeFiltre";

interface BandeauPeriodeFiltreProps {
  dateClic: string;
  debut: string;
  fin: string;
  resume: ResumePeriode;
  onRevenir: () => void;
}

function formatMontantSigneK(montant: number): string {
  const base = formatMontantK(montant);
  return montant > 0 ? `+${base}` : base;
}

export default function BandeauPeriodeFiltre({
  dateClic,
  debut,
  fin,
  resume,
  onRevenir,
}: BandeauPeriodeFiltreProps) {
  return (
    <div className="bandeau-periode-filtre">
      <div className="bandeau-periode-filtre__texte">
        <p className="bandeau-periode-filtre__titre">Vue filtrée : mouvements autour du {formatDate(dateClic)}</p>
        <p className="bandeau-periode-filtre__sous-titre">
          Période : {formatDate(debut)} → {formatDate(fin)}
        </p>
        <p className="bandeau-periode-filtre__resume">
          Entrées : {formatMontantSigneK(resume.entrees)} · Sorties : {formatMontantSigneK(resume.sorties)} · Net :{" "}
          {formatMontantSigneK(resume.net)}
        </p>
      </div>
      <button type="button" className="btn-secondaire" onClick={onRevenir}>
        Revenir à la vue générale
      </button>
    </div>
  );
}
