"use client";

import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatDate, formatMontant } from "@/lib/format";
import { NEUTRES } from "@/lib/dataviz";
import type { Situation } from "@/lib/probaRisques";

// Référence en pointillé encre, scénario testé (dernière situation) en rose, situations
// intermédiaires d'un duo (A seule, B seule) en gris : même vocabulaire que la courbe Futur.
const STYLES = [
  { stroke: NEUTRES.encre, strokeDasharray: "5 4", strokeOpacity: 0.6 },
  { stroke: NEUTRES.secondaire, strokeDasharray: "2 3", strokeOpacity: 0.9 },
  { stroke: NEUTRES.autres, strokeDasharray: "8 3", strokeOpacity: 0.9 },
];

export default function ImpactRisqueChart({ dates, situations }: { dates: string[]; situations: Situation[] }) {
  const donnees = dates.map((date, j) => {
    const point: Record<string, number | string> = { date };
    situations.forEach((s, i) => (point[`s${i}`] = s.soldes[j]));
    return point;
  });
  const derniere = situations.length - 1;
  return (
    <div style={{ fontFamily: "var(--font-lexend), sans-serif" }}>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={donnees} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={NEUTRES.bordure} />
          <XAxis dataKey="date" tickFormatter={(v: string) => formatDate(v)} minTickGap={40} fontSize={11} tick={{ fill: NEUTRES.secondaire }} />
          <YAxis tickFormatter={(v: number) => formatMontant(v)} width={86} fontSize={11} tick={{ fill: NEUTRES.secondaire }} />
          <Tooltip
            labelFormatter={(v: string) => formatDate(v)}
            formatter={(v: number, nom: string) => [formatMontant(v), situations[Number(nom.slice(1))]?.libelle ?? nom]}
            contentStyle={{ fontFamily: "var(--font-lexend), sans-serif", background: NEUTRES.fond, border: `1px solid ${NEUTRES.bordure}`, borderRadius: 10, fontSize: 12 }}
          />
          <Legend formatter={(nom: string) => situations[Number(nom.slice(1))]?.libelle ?? nom} wrapperStyle={{ fontSize: 11 }} />
          <ReferenceLine y={0} stroke="#c10068" strokeDasharray="4 4" />
          {situations.map((s, i) =>
            i === derniere && i > 0 ? (
              <Line key={i} dataKey={`s${i}`} stroke="#f02894" strokeWidth={2} dot={false} isAnimationActive={false} type="stepAfter" />
            ) : (
              <Line key={i} dataKey={`s${i}`} {...STYLES[Math.min(i, STYLES.length - 1)]} strokeWidth={1.5} dot={false} isAnimationActive={false} type="stepAfter" />
            )
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
