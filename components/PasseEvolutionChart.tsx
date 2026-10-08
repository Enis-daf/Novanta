"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { graduationsAxe, NEUTRES, OPACITE_ATTENUEE, TEINTE_SERIE_PRINCIPALE } from "@/lib/dataviz";
import { formatMontant, formatKiloEuros } from "@/lib/format";
import { libelleMois, libelleMoisCourt, PointEvolution } from "@/lib/pastDetail";

interface PasseEvolutionChartProps {
  titre: string;
  evolution: PointEvolution[];
  // Les barreaux montrent la valeur absolue des montants (catégorie sélectionnée) : l'infobulle
  // rappelle alors le montant réel.
  enValeurAbsolue?: boolean;
  selection: string | null;
  onSelect: (mois: string) => void;
}

function InfoBulle({
  active,
  payload,
  enValeurAbsolue,
}: {
  active?: boolean;
  payload?: { payload: PointEvolution }[];
  enValeurAbsolue: boolean;
}) {
  if (!active || !payload?.length) return null;
  const { mois, montant } = payload[0].payload;
  return (
    <div className="passe-structure__infobulle">
      <strong>{libelleMois(mois)}</strong>
      <span>{formatMontant(montant)}</span>
      {enValeurAbsolue && montant < 0 && <span className="passe-structure__note">Montant réel ; barreau en valeur absolue</span>}
    </div>
  );
}

// Au-delà, les barreaux sont trop serrés pour porter chacun son libellé : l'infobulle prend le relais.
export const MAX_MOIS_AVEC_LIBELLES = 12;

/** Libellé d'un barreau en k€ ; rien sur un barreau nul. */
export function libelleBarreauK(valeur: unknown, avecUnite = true): string {
  if (typeof valeur !== "number" || valeur === 0) return "";
  const texte = formatKiloEuros(valeur, Math.abs(valeur) < 10_000 ? 1 : 0);
  // Espace insécable avant l'unité : le libellé tient sur une ligne au-dessus de son barreau.
  return avecUnite ? texte.replace(" k€", "\u00a0k€") : texte.replace(" k€", "");
}

/** Décimales des graduations en k€ : davantage quand l'échelle est petite, pour ne pas les confondre. */
export function decimalesAxeK(amplitude: number): number {
  return amplitude < 2_000 ? 2 : 1;
}

// Histogramme mensuel : un barreau par mois de la période (y compris à zéro), en k€. Cliquer sur
// un mois (toute la colonne, pas seulement le barreau) le sélectionne comme filtre.
export default function PasseEvolutionChart({ titre, evolution, enValeurAbsolue = false, selection, onSelect }: PasseEvolutionChartProps) {
  const plusieursAnnees = new Set(evolution.map((e) => e.mois.slice(0, 4))).size > 1;
  const graduations = graduationsAxe(evolution.map((e) => e.valeur));
  const decimales = decimalesAxeK(Math.max(...graduations.map(Math.abs)));

  return (
    <section className="passe-structure">
      <h3 className="eyebrow eyebrow--encre">{titre}</h3>
      <div style={{ fontFamily: "var(--font-lexend), sans-serif", cursor: "pointer" }}>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart
            data={evolution}
            margin={{ top: 20, right: 8, left: 0, bottom: 0 }}
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
              tickFormatter={(valeur: number) => formatKiloEuros(valeur, decimales)}
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
            <Tooltip content={<InfoBulle enValeurAbsolue={enValeurAbsolue} />} cursor={{ fill: NEUTRES.bordure, fillOpacity: 0.5 }} />
            <ReferenceLine y={0} stroke={NEUTRES.secondaire} />
            <Bar dataKey="valeur" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false}>
              {evolution.map((e) => (
                <Cell
                  key={e.mois}
                  fill={TEINTE_SERIE_PRINCIPALE}
                  fillOpacity={selection !== null && selection !== e.mois ? OPACITE_ATTENUEE : 1}
                />
              ))}
              {evolution.length <= MAX_MOIS_AVEC_LIBELLES && (
                <LabelList
                  dataKey="valeur"
                  position="top"
                  formatter={(valeur: unknown) => libelleBarreauK(valeur)}
                  fontSize={10}
                  fill={NEUTRES.encre}
                />
              )}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
