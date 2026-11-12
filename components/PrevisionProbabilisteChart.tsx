"use client";

import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatDate, formatMontant } from "@/lib/format";
import { NEUTRES } from "@/lib/dataviz";
import type { PointProbabiliste } from "@/lib/probaIndicateurs";
import type { SoldeJournalier } from "@/lib/types";

interface PrevisionProbabilisteChartProps {
  serie: PointProbabiliste[];
  deterministe: SoldeJournalier[];
}

interface Point {
  date: string;
  plage: [number, number];
  p50: number;
  p10: number;
  p90: number;
  probaNegatif: number;
  projection: number | null;
}

const pourcent = (x: number) => `${Math.round(x * 100)} %`;

function Infobulle({ active, payload }: { active?: boolean; payload?: { payload: Point }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="proba-infobulle">
      <p className="proba-infobulle__date">{formatDate(p.date)}</p>
      <p>
        Trésorerie médiane : <strong>{formatMontant(p.p50)}</strong>
      </p>
      <p>
        8 cas sur 10 entre {formatMontant(p.p10)} et {formatMontant(p.p90)}
      </p>
      {p.projection !== null && <p>Projection actuelle : {formatMontant(p.projection)}</p>}
      {p.probaNegatif > 0 && <p>Risque d&apos;être sous 0 € ce jour : {pourcent(p.probaNegatif)}</p>}
    </div>
  );
}

// Courbe médiane (rose) et fourchette de 8 cas sur 10 (bande neutre), projection actuelle en
// pointillé. La bande n'est pas un scénario : chaque jour est lu séparément.
export default function PrevisionProbabilisteChart({ serie, deterministe }: PrevisionProbabilisteChartProps) {
  const projection = new Map(deterministe.map((p) => [p.date, p.solde]));
  const donnees: Point[] = serie.map((p) => ({
    date: p.date,
    plage: [p.p10, p.p90],
    p50: p.p50,
    p10: p.p10,
    p90: p.p90,
    probaNegatif: p.probaNegatif,
    projection: projection.get(p.date) ?? null,
  }));
  return (
    <div style={{ fontFamily: "var(--font-lexend), sans-serif" }}>
      <ResponsiveContainer width="100%" height={340}>
        <ComposedChart data={donnees} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={NEUTRES.bordure} />
          <XAxis
            dataKey="date"
            tickFormatter={(v: string) => formatDate(v)}
            minTickGap={40}
            fontSize={12}
            tick={{ fill: NEUTRES.secondaire }}
            axisLine={{ stroke: NEUTRES.bordure }}
            tickLine={{ stroke: NEUTRES.bordure }}
          />
          <YAxis
            tickFormatter={(v: number) => formatMontant(v)}
            width={90}
            fontSize={12}
            tick={{ fill: NEUTRES.secondaire }}
            axisLine={{ stroke: NEUTRES.bordure }}
            tickLine={{ stroke: NEUTRES.bordure }}
          />
          <Tooltip content={<Infobulle />} />
          <ReferenceLine y={0} stroke="#c10068" strokeDasharray="4 4" />
          <Area dataKey="plage" stroke="none" fill={NEUTRES.secondaire} fillOpacity={0.16} isAnimationActive={false} activeDot={false} />
          <Line dataKey="projection" stroke={NEUTRES.encre} strokeOpacity={0.55} strokeDasharray="5 4" strokeWidth={1.5} dot={false} activeDot={false} isAnimationActive={false} />
          <Line
            dataKey="p50"
            stroke="#f02894"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5, fill: "#f02894", stroke: "#fffefa", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <ul className="proba-legende" aria-label="Légende">
        <li>
          <span className="proba-legende__trait proba-legende__trait--mediane" /> Trésorerie médiane
        </li>
        <li>
          <span className="proba-legende__trait proba-legende__trait--bande" /> Fourchette de 8 cas sur 10
        </li>
        <li>
          <span className="proba-legende__trait proba-legende__trait--projection" /> Projection actuelle
        </li>
      </ul>
    </div>
  );
}
