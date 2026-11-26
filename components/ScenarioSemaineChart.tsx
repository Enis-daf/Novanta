"use client";

import { CartesianGrid, Legend, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatDate, formatMontant } from "@/lib/format";
import { NEUTRES } from "@/lib/dataviz";
import { COURBE } from "./ImpactRisqueChart";

export interface TrajectoireSemaine {
  libelle: string;
  soldes: number[];
  role: "reference" | "simulee" | "corrigee" | "testee";
}

// Une vraie simulation rejouée (pas une médiane) : la trajectoire simulée en rose, la même simulation
// avec la facture encaissée à sa date de référence en gris, la référence en pointillé encre, un
// décalage testé en pointillé gris. Lissage visuel monotone : aucun creux inventé entre deux jours.
const STYLES: Record<TrajectoireSemaine["role"], { stroke: string; strokeDasharray?: string; strokeWidth: number; strokeOpacity?: number }> = {
  reference: { stroke: NEUTRES.encre, strokeDasharray: "5 4", strokeWidth: 1.5, strokeOpacity: 0.6 },
  corrigee: { stroke: NEUTRES.secondaire, strokeWidth: 1.5 },
  testee: { stroke: NEUTRES.autres, strokeDasharray: "2 3", strokeWidth: 2 },
  simulee: { stroke: "#f02894", strokeWidth: 2 },
};

export default function ScenarioSemaineChart({
  dates,
  trajectoires,
  semaine,
  reperes,
}: {
  dates: string[];
  trajectoires: TrajectoireSemaine[];
  semaine: { debut: string; fin: string };
  reperes: { date: string; libelle: string }[];
}) {
  const donnees = dates.map((date, j) => {
    const point: Record<string, number | string> = { date };
    trajectoires.forEach((t, i) => (point[`t${i}`] = t.soldes[j]));
    return point;
  });
  return (
    <div style={{ fontFamily: "var(--font-lexend), sans-serif" }}>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={donnees} margin={{ top: 18, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={NEUTRES.bordure} />
          <XAxis dataKey="date" tickFormatter={(v: string) => formatDate(v)} minTickGap={40} fontSize={11} tick={{ fill: NEUTRES.secondaire }} />
          <YAxis tickFormatter={(v: number) => formatMontant(v)} width={86} fontSize={11} tick={{ fill: NEUTRES.secondaire }} />
          <ReferenceArea x1={semaine.debut} x2={semaine.fin} fill={NEUTRES.encre} fillOpacity={0.06} stroke="none" ifOverflow="hidden" />
          <Tooltip
            labelFormatter={(v: string) => formatDate(v)}
            formatter={(v: number, nom: string) => [formatMontant(v), trajectoires[Number(nom.slice(1))]?.libelle ?? nom]}
            contentStyle={{ fontFamily: "var(--font-lexend), sans-serif", background: NEUTRES.fond, border: `1px solid ${NEUTRES.bordure}`, borderRadius: 10, fontSize: 12 }}
          />
          <Legend formatter={(nom: string) => trajectoires[Number(nom.slice(1))]?.libelle ?? nom} wrapperStyle={{ fontSize: 11 }} />
          <ReferenceLine y={0} stroke="#c10068" strokeDasharray="4 4" />
          {reperes
            .filter((r) => dates.includes(r.date))
            .map((r) => (
              <ReferenceLine
                key={`${r.libelle}-${r.date}`}
                x={r.date}
                stroke={NEUTRES.secondaire}
                strokeDasharray="2 2"
                label={{ value: r.libelle, position: "top", fontSize: 10, fill: NEUTRES.secondaire }}
              />
            ))}
          {trajectoires.map((t, i) => (
            <Line key={i} dataKey={`t${i}`} {...STYLES[t.role]} dot={false} isAnimationActive={false} type={COURBE} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
