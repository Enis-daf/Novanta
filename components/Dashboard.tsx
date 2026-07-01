"use client";

import { ResultatProjectionCash } from "@/lib/cash-engine";
import { formatDate, formatMontant } from "@/lib/format";
import KpiCard from "./KpiCard";
import CashCurveChart from "./CashCurveChart";

interface DashboardProps {
  soldeInitial: number;
  onChangeSoldeInitial: (valeur: number) => void;
  resultat: ResultatProjectionCash;
}

export default function Dashboard({ soldeInitial, onChangeSoldeInitial, resultat }: DashboardProps) {
  const { serie, soldeJ90, pointBas, dateDuPointBas, datePassageSousZero } = resultat;
  const enRupture = datePassageSousZero !== null;

  return (
    <section className="dashboard">
      <div className="solde-initial">
        <label htmlFor="solde-initial-input">Solde bancaire initial</label>
        <input
          id="solde-initial-input"
          type="number"
          value={soldeInitial}
          onChange={(e) => onChangeSoldeInitial(Number(e.target.value))}
        />
      </div>

      <div className="kpi-grid">
        <KpiCard
          label="Solde projeté à J+90"
          value={formatMontant(soldeJ90)}
          tone={soldeJ90 < 0 ? "danger" : "success"}
        />
        <KpiCard
          label="Point bas sur 90 jours"
          value={formatMontant(pointBas)}
          tone={pointBas < 0 ? "danger" : "neutral"}
          sublabel={`le ${formatDate(dateDuPointBas)}`}
        />
        <KpiCard
          label="Passage sous zéro"
          value={
            enRupture
              ? formatDate(datePassageSousZero as string)
              : "Pas de passage sous zéro sur les 90 prochains jours"
          }
          tone={enRupture ? "danger" : "success"}
          compact={!enRupture}
        />
      </div>

      <CashCurveChart serie={serie} />
    </section>
  );
}
