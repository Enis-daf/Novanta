"use client";

import { ResultatProjectionCash } from "@/lib/cash-engine";
import { formatDate, formatMontant } from "@/lib/format";
import { HorizonJours } from "@/lib/types";
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
  onPointClickCourbe?: (date: string) => void;
}

export default function Dashboard({
  soldeInitial,
  onChangeSoldeInitial,
  dateReleve,
  onChangeDateReleve,
  horizonJours,
  onChangeHorizonJours,
  resultat,
  onPointClickCourbe,
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

      <p className="pilotage__eyebrow">Projection de trésorerie</p>

      <div className="pilotage__headline">
        <p className="pilotage__headline-label">Solde projeté à J+{horizonJours}</p>
        <p
          className={`pilotage__headline-valeur${
            soldeJ90 < 0 ? " pilotage__headline-valeur--danger" : ""
          }`}
        >
          {formatMontant(soldeJ90)}
        </p>
      </div>

      <div className="pilotage__stats">
        <div>
          <p className="pilotage__stat-label">Point bas sur {horizonJours} jours</p>
          <p
            className={`pilotage__stat-valeur${pointBas < 0 ? " pilotage__stat-valeur--danger" : ""}`}
          >
            {formatMontant(pointBas)}
          </p>
          <p className="pilotage__stat-sous-valeur">le {formatDate(dateDuPointBas)}</p>
        </div>
        <div>
          <p className="pilotage__stat-label">Passage sous zéro</p>
          <p
            className={`pilotage__stat-valeur${
              enRupture ? " pilotage__stat-valeur--danger" : " pilotage__stat-valeur--compact"
            }`}
          >
            {enRupture
              ? formatDate(datePassageSousZero as string)
              : `Pas de passage sous zéro sur les ${horizonJours} prochains jours`}
          </p>
        </div>
      </div>

      <hr className="pilotage__separateur" />

      <div className="pilotage__chart">
        <CashCurveChart serie={serie} onPointClick={onPointClickCourbe} dark />
      </div>
    </section>
  );
}
