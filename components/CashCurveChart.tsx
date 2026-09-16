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
}

export default function CashCurveChart({ serie, onPointClick }: CashCurveChartProps) {
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
          <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
          <XAxis
            dataKey="date"
            tickFormatter={(value: string) => formatDate(value)}
            minTickGap={40}
            fontSize={12}
            tick={{ fill: "#6B7280" }}
            axisLine={{ stroke: "#E5E7EB" }}
            tickLine={{ stroke: "#E5E7EB" }}
            style={{ fontFamily: "var(--font-lexend), sans-serif" }}
          />
          <YAxis
            tickFormatter={(value: number) => formatMontant(value)}
            width={90}
            fontSize={12}
            tick={{ fill: "#6B7280" }}
            axisLine={{ stroke: "#E5E7EB" }}
            tickLine={{ stroke: "#E5E7EB" }}
            style={{ fontFamily: "var(--font-lexend), sans-serif" }}
          />
          <Tooltip
            labelFormatter={(value: string) => formatDate(value)}
            formatter={(value: number) => [formatMontant(value), "Solde"]}
            contentStyle={{
              fontFamily: "var(--font-lexend), sans-serif",
              background: "#fffefa",
              border: "1px solid #E5E7EB",
              borderRadius: 10,
              fontSize: 13,
            }}
            labelStyle={{ color: "#030A16", fontWeight: 600 }}
            itemStyle={{ color: "#030A16" }}
          />
          <ReferenceLine y={0} stroke="#c10068" strokeDasharray="4 4" />
          <Line
            type="monotone"
            dataKey="solde"
            stroke="#f02894"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5, fill: "#f02894", stroke: "#fffefa", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
