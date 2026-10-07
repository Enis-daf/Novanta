"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { decimalesAxeK, libelleBarreauK, MAX_MOIS_AVEC_LIBELLES } from "./PasseEvolutionChart";
import { graduationsAxe, NEUTRES, OPACITE_ATTENUEE, TEINTE_SERIE_PRINCIPALE, TEINTE_SERIE_SECONDAIRE } from "@/lib/dataviz";
import { formatMontant, formatMontantK } from "@/lib/format";
import { libelleMois, libelleMoisCourt } from "@/lib/pastDetail";

type PointDecomposition = { mois: string; ebitda: number; extraPnl: number; cashFlow: number };

interface PasseDecompositionChartProps {
  titre: string;
  decomposition: PointDecomposition[];
  selection: string | null;
  onSelect: (mois: string) => void;
}

const SERIES = [
  { cle: "ebitda", libelle: "EBITDA", teinte: TEINTE_SERIE_PRINCIPALE },
  { cle: "extraPnl", libelle: "Extra P&L", teinte: TEINTE_SERIE_SECONDAIRE },
] as const;

function InfoBulle({ active, payload }: { active?: boolean; payload?: { payload: PointDecomposition }[] }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="passe-structure__infobulle">
      <strong>{libelleMois(point.mois)}</strong>
      <span>EBITDA : {formatMontant(point.ebitda)}</span>
      <span>Extra P&amp;L : {formatMontant(point.extraPnl)}</span>
      <span>Cash flow : {formatMontant(point.cashFlow)}</span>
    </div>
  );
}

// Décomposition mensuelle du Cash flow en ses deux composantes, côte à côte et signées : on lit
// laquelle porte le mois. Cliquer sur un mois le sélectionne comme filtre.
export default function PasseDecompositionChart({ titre, decomposition, selection, onSelect }: PasseDecompositionChartProps) {
  const plusieursAnnees = new Set(decomposition.map((d) => d.mois.slice(0, 4))).size > 1;
  const graduations = graduationsAxe(decomposition.flatMap((d) => [d.ebitda, d.extraPnl]));
  const decimales = decimalesAxeK(Math.max(...graduations.map(Math.abs)));

  return (
    <section className="passe-structure">
      <h3 className="passe-structure__titre">{titre}</h3>
      <ul className="passe-decomposition__legende">
        {SERIES.map((serie) => (
          <li key={serie.cle}>
            <span className="passe-structure__pastille" style={{ background: serie.teinte }} aria-hidden="true" />
            {serie.libelle}
          </li>
        ))}
      </ul>
      <div style={{ fontFamily: "var(--font-lexend), sans-serif", cursor: "pointer" }}>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart
            data={decomposition}
            margin={{ top: 20, right: 8, left: 0, bottom: 0 }}
            barGap={2}
            onClick={(etat) => {
              if (typeof etat?.activeLabel === "string") onSelect(etat.activeLabel);
            }}
          >
            <CartesianGrid vertical={false} stroke={NEUTRES.bordure} />
            <XAxis
              dataKey="mois"
              tickFormatter={(mois: string) => libelleMoisCourt(mois, plusieursAnnees)}
              fontSize={11}
              tick={{ fill: NEUTRES.secondaire }}
              axisLine={false}
              tickLine={false}
              minTickGap={4}
            />
            <YAxis
              tickFormatter={(valeur: number) => formatMontantK(valeur, decimales)}
              // Graduations rondes, zéro toujours dans le cadre : un barreau part de zéro, vers le
              // haut (positif) ou vers le bas (négatif).
              ticks={graduations}
              domain={[graduations[0], graduations[graduations.length - 1]]}
              width={72}
              fontSize={11}
              tick={{ fill: NEUTRES.secondaire }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<InfoBulle />} cursor={{ fill: NEUTRES.bordure, fillOpacity: 0.5 }} />
            <ReferenceLine y={0} stroke={NEUTRES.secondaire} />
            {SERIES.map((serie) => (
              <Bar key={serie.cle} dataKey={serie.cle} name={serie.libelle} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false}>
                {decomposition.map((d) => (
                  <Cell
                    key={d.mois}
                    fill={serie.teinte}
                    fillOpacity={selection !== null && selection !== d.mois ? OPACITE_ATTENUEE : 1}
                  />
                ))}
                {/* Deux barreaux par mois : libellés sans unité (rappelée dans le titre) pour tenir. */}
                {decomposition.length <= MAX_MOIS_AVEC_LIBELLES && (
                  <LabelList
                    dataKey={serie.cle}
                    position="top"
                    formatter={(valeur: unknown) => libelleBarreauK(valeur, false)}
                    fontSize={9}
                    fill={NEUTRES.encre}
                  />
                )}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
