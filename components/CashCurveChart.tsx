"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SoldeJournalier } from "@/lib/types";
import { formatDate, formatMontant } from "@/lib/format";

interface CashCurveChartProps {
  serie: SoldeJournalier[];
  onPointClick?: (date: string) => void;
  /** Le graphe est intégré directement à la grande surface sombre du panneau de pilotage
   * (aucune card blanche autour) : ce drapeau adapte grille/axes/tooltip à ce fond, sans dupliquer
   * le composant. */
  dark?: boolean;
}

export default function CashCurveChart({ serie, onPointClick, dark = false }: CashCurveChartProps) {
  const gridColor = dark ? "rgba(255, 254, 250, 0.14)" : "#E5E7EB";
  const tickColor = dark ? "rgba(255, 254, 250, 0.6)" : "#6B7280";
  const tooltipBg = dark ? "#0D1626" : "#fffefa";
  const tooltipBorder = dark ? "rgba(255, 254, 250, 0.16)" : "#E5E7EB";
  const tooltipText = dark ? "#FFFEFA" : "#030A16";

  return (
    <div
      style={{ fontFamily: "var(--font-lexend), sans-serif", cursor: onPointClick ? "pointer" : undefined }}
    >
      <ResponsiveContainer width="100%" height={320}>
        <LineChart
          data={serie}
          margin={{ top: 10, right: 20, left: 10, bottom: 0 }}
          onClick={(state) => {
            const date = state?.activeLabel;
            if (onPointClick && typeof date === "string") onPointClick(date);
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
          <XAxis
            dataKey="date"
            tickFormatter={(value: string) => formatDate(value)}
            minTickGap={40}
            fontSize={12}
            tick={{ fill: tickColor }}
            axisLine={{ stroke: gridColor }}
            tickLine={{ stroke: gridColor }}
            style={{ fontFamily: "var(--font-lexend), sans-serif" }}
          />
          <YAxis
            tickFormatter={(value: number) => formatMontant(value)}
            width={90}
            fontSize={12}
            tick={{ fill: tickColor }}
            axisLine={{ stroke: gridColor }}
            tickLine={{ stroke: gridColor }}
            style={{ fontFamily: "var(--font-lexend), sans-serif" }}
          />
          <Tooltip
            labelFormatter={(value: string) => formatDate(value)}
            formatter={(value: number) => [formatMontant(value), "Solde"]}
            contentStyle={{
              fontFamily: "var(--font-lexend), sans-serif",
              background: tooltipBg,
              border: `1px solid ${tooltipBorder}`,
              borderRadius: 10,
              fontSize: 13,
            }}
            labelStyle={{ color: tooltipText, fontWeight: 600 }}
            itemStyle={{ color: tooltipText }}
          />
          <ReferenceLine y={0} stroke="#c10068" strokeDasharray="4 4" />
          <Line
            type="monotone"
            dataKey="solde"
            stroke="#f02894"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5, fill: "#f02894", stroke: dark ? "#030A16" : "#fffefa", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
