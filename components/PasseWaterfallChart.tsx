"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { decimalesAxeK, libelleBarreauK } from "./PasseEvolutionChart";
import { graduationsAxe, NEUTRES, OPACITE_ATTENUEE, TEINTE_AMELIORATION, TEINTE_DEGRADATION, TEINTE_TOTAL } from "@/lib/dataviz";
import { avecMentionTTC, formatKiloEuros, formatMontant } from "@/lib/format";
import { EtagePnl } from "@/lib/pastCategoryMapping";
import { Comparaison, libelleVariation, phraseVariation, VariationPoste } from "@/lib/pastVariance";

interface PasseWaterfallChartProps {
  comparaison: Comparaison;
  libelleA: string;
  libelleB: string;
  selection: EtagePnl | null;
  onSelect: (etage: EtagePnl) => void;
}

interface Barreau {
  cle: string;
  nom: string;
  plage: [number, number]; // de… à…, en montant de Cash flow cumulé
  valeur: number; // total (extrémités) ou contribution (étages)
  etage: EtagePnl | null; // null pour les deux totaux, qui ne sont pas cliquables
  variation: VariationPoste | null; // ce que le poste a fait entre A et B ; null pour les totaux
}

function signe(montant: number, formater: (m: number) => string): string {
  return montant > 0 ? `+${formater(montant)}` : formater(montant);
}

const ARTICLES: Record<string, string> = { "Variation de trésorerie": "la" };

function InfoBulle({ active, payload, metrique }: { active?: boolean; payload?: { payload: Barreau }[]; metrique: string }) {
  if (!active || !payload?.length) return null;
  const barreau = payload[0].payload;
  return (
    <div className="passe-structure__infobulle">
      <strong>{barreau.nom}</strong>
      {barreau.variation ? (
        // Les deux notions, côte à côte : ce que le poste a fait, puis ce que cela change.
        <>
          <span>{phraseVariation(barreau.variation, formatMontant)}</span>
          <span>
            Impact sur {ARTICLES[metrique] ?? "le"} {metrique} : {avecMentionTTC(signe(barreau.valeur, formatMontant))}
          </span>
        </>
      ) : (
        <span>{formatMontant(barreau.valeur, { ttc: true })}</span>
      )}
    </div>
  );
}

// Waterfall : du Cash flow de A à celui de B, une marche par étage du P&L. Chaque marche est une
// CONTRIBUTION à l'écart (impact sur le Cash flow), pas le montant du poste. Cliquer sur une
// marche descend au niveau des catégories.
export default function PasseWaterfallChart({ comparaison, libelleA, libelleB, selection, onSelect }: PasseWaterfallChartProps) {
  let cumul = comparaison.cashFlowA;
  const barreaux: Barreau[] = [
    { cle: "a", nom: `${comparaison.metrique} ${libelleA}`, plage: [0, comparaison.cashFlowA], valeur: comparaison.cashFlowA, etage: null, variation: null },
    ...comparaison.etages.map((e) => {
      const depart = cumul;
      cumul += e.contribution;
      return { cle: e.etage, nom: e.libelle, plage: [depart, cumul] as [number, number], valeur: e.contribution, etage: e.etage, variation: e.variation };
    }),
    { cle: "b", nom: `${comparaison.metrique} ${libelleB}`, plage: [0, comparaison.cashFlowB], valeur: comparaison.cashFlowB, etage: null, variation: null },
  ];
  const graduations = graduationsAxe(barreaux.flatMap((b) => b.plage));
  const decimales = decimalesAxeK(Math.max(...graduations.map(Math.abs)));
  const teinte = (b: Barreau) => (b.etage === null ? TEINTE_TOTAL : b.valeur >= 0 ? TEINTE_AMELIORATION : TEINTE_DEGRADATION);

  return (
    <div style={{ fontFamily: "var(--font-lexend), sans-serif" }}>
      <ResponsiveContainer width="100%" height={320}>
        <BarChart
          data={barreaux}
          margin={{ top: 20, right: 8, left: 0, bottom: 0 }}
          onClick={(etat) => {
            const etage = (etat?.activePayload?.[0]?.payload as Barreau | undefined)?.etage;
            if (etage) onSelect(etage);
          }}
        >
          <CartesianGrid vertical={false} stroke={NEUTRES.bordure} />
          <XAxis
            dataKey="nom"
            interval={0}
            height={56}
            fontSize={11}
            tick={{ fill: NEUTRES.encre, width: 86 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tickFormatter={(valeur: number) => formatKiloEuros(valeur, decimales)}
            ticks={graduations}
            domain={[graduations[0], graduations[graduations.length - 1]]}
            width={72}
            fontSize={11}
            tick={{ fill: NEUTRES.secondaire }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip content={<InfoBulle metrique={comparaison.metrique} />} cursor={{ fill: NEUTRES.bordure, fillOpacity: 0.5 }} />
          <ReferenceLine y={0} stroke={NEUTRES.secondaire} />
          <Bar dataKey="plage" radius={2} maxBarSize={56} isAnimationActive={false}>
            {barreaux.map((b) => (
              <Cell
                key={b.cle}
                fill={teinte(b)}
                fillOpacity={selection !== null && b.etage !== selection ? OPACITE_ATTENUEE : 1}
                style={{ cursor: b.etage ? "pointer" : undefined }}
              />
            ))}
            <LabelList
              dataKey="valeur"
              position="top"
              content={({ x, y, width, height, index }) => {
                const b = barreaux[Number(index)];
                if (!b) return null;
                // Marche d'un étage : la variation du poste (↑ / ↓). Extrémités : le niveau, signé.
                const enK = (m: number) => libelleBarreauK(m) || "0 k€";
                const texte = b.variation ? libelleVariation(b.variation, enK) : enK(b.valeur);
                return (
                  // Toujours au-dessus du barreau, que la marche monte ou descende (hauteur négative).
                  <text
                    x={Number(x) + Number(width) / 2}
                    y={Math.min(Number(y), Number(y) + Number(height)) - 6}
                    textAnchor="middle"
                    fontSize={10}
                    fill={NEUTRES.encre}
                  >
                    {texte}
                  </text>
                );
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
