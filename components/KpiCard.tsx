interface KpiCardProps {
  label: string;
  value: string;
  tone?: "neutral" | "danger" | "success";
  sublabel?: string;
  compact?: boolean;
}

export default function KpiCard({ label, value, tone = "neutral", sublabel, compact = false }: KpiCardProps) {
  return (
    <div className={`kpi-card kpi-card--${tone}`}>
      <div className="kpi-card__label">{label}</div>
      <div className={`kpi-card__value${compact ? " kpi-card__value--compact" : ""}`}>{value}</div>
      {sublabel && <div className="kpi-card__sublabel">{sublabel}</div>}
    </div>
  );
}
