"use client";

import { ResultatProjectionCash } from "@/lib/cash-engine";
import { formatDate, formatMontant } from "@/lib/format";
import { HorizonJours } from "@/lib/types";
import KpiCard from "./KpiCard";
import CashCurveChart from "./CashCurveChart";
import DateField from "./DateField";

interface DashboardProps {
  soldeInitial: number;
  onChangeSoldeInitial: (valeur: number) => void;
  dateReleve: string;
  onChangeDateReleve: (valeur: string) => void;
  horizonJours: HorizonJours;
  onChangeHorizonJours: (valeur: HorizonJours) => void;
  resultat: ResultatProjectionCash;
}

export default function Dashboard({
  soldeInitial,
  onChangeSoldeInitial,
  dateReleve,
  onChangeDateReleve,
  horizonJours,
  onChangeHorizonJours,
  resultat,
}: DashboardProps) {
  const { serie, soldeJ90, pointBas, dateDuPointBas, datePassageSousZero } = resultat;
  const enRupture = datePassageSousZero !== null;

  return (
    <section className="dashboard">
      <div className="dashboard-parametres">
        <div className="solde-initial">
          <label htmlFor="solde-initial-input">Solde bancaire initial</label>
          <input
            id="solde-initial-input"
            type="number"
            value={soldeInitial}
            onChange={(e) => onChangeSoldeInitial(Number(e.target.value))}
          />
        </div>
        <div className="solde-initial">
          <label htmlFor="date-releve-input">Date du relevé</label>
          <DateField
            id="date-releve-input"
            value={dateReleve}
            onChange={onChangeDateReleve}
            effacable={false}
          />
        </div>
        <div className="solde-initial">
          <label htmlFor="horizon-input">Horizon</label>
          <select
            id="horizon-input"
            value={horizonJours}
            onChange={(e) => onChangeHorizonJours(Number(e.target.value) as HorizonJours)}
          >
            <option value={90}>90 jours</option>
            <option value={180}>180 jours</option>
          </select>
        </div>
      </div>

      <div className="kpi-grid">
        <KpiCard
          label={`Solde projeté à J+${horizonJours}`}
          value={formatMontant(soldeJ90)}
          tone={soldeJ90 < 0 ? "danger" : "success"}
        />
        <KpiCard
          label={`Point bas sur ${horizonJours} jours`}
          value={formatMontant(pointBas)}
          tone={pointBas < 0 ? "danger" : "neutral"}
          sublabel={`le ${formatDate(dateDuPointBas)}`}
        />
        <KpiCard
          label="Passage sous zéro"
          value={
            enRupture
              ? formatDate(datePassageSousZero as string)
              : `Pas de passage sous zéro sur les ${horizonJours} prochains jours`
          }
          tone={enRupture ? "danger" : "success"}
          compact={!enRupture}
        />
      </div>

      <CashCurveChart serie={serie} />
    </section>
  );
}
