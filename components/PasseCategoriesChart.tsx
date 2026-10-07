"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { decimalesAxeK, libelleBarreauK } from "./PasseEvolutionChart";
import { graduationsAxe, NEUTRES, OPACITE_ATTENUEE, TEINTE_SERIE_PRINCIPALE } from "@/lib/dataviz";
import { formatMontant, formatMontantK } from "@/lib/format";

type BarreCategorie = { cle: string; nom: string; montant: number };

interface PasseCategoriesChartProps {
  titre: string;
  categories: BarreCategorie[];
  messageVide: string;
  selection: string | null;
  onSelect: (cle: string) => void;
}

function InfoBulle({ active, payload }: { active?: boolean; payload?: { payload: BarreCategorie }[] }) {
  if (!active || !payload?.length) return null;
  const { nom, montant } = payload[0].payload;
  return (
    <div className="passe-structure__infobulle">
      <strong>{nom}</strong>
      <span>{formatMontant(montant)}</span>
    </div>
  );
}

const HAUTEUR_PAR_CATEGORIE = 36;

// Histogramme par catégorie, pour un étage aux montants de signes mêlés (Extra P&L) qu'un
// camembert ne sait pas représenter : un barreau horizontal par catégorie, à gauche de zéro pour
// un décaissement, à droite pour un encaissement. Horizontal pour que les noms de catégories
// restent lisibles quel que soit leur nombre. Cliquer sur une catégorie la sélectionne comme filtre.
export default function PasseCategoriesChart({ titre, categories, messageVide, selection, onSelect }: PasseCategoriesChartProps) {
  const graduations = graduationsAxe(categories.map((c) => c.montant));
  const decimales = decimalesAxeK(Math.max(...graduations.map(Math.abs)));

  return (
    <section className="passe-structure">
      <h3 className="eyebrow eyebrow--encre">{titre}</h3>
      {categories.length === 0 ? (
        <p className="passe-structure__vide">{messageVide}</p>
      ) : (
        <div style={{ fontFamily: "var(--font-lexend), sans-serif", cursor: "pointer" }}>
          <ResponsiveContainer width="100%" height={categories.length * HAUTEUR_PAR_CATEGORIE + 40}>
            <BarChart
              data={categories}
              layout="vertical"
              margin={{ top: 0, right: 48, left: 0, bottom: 0 }}
              onClick={(etat) => {
                const cle = (etat?.activePayload?.[0]?.payload as BarreCategorie | undefined)?.cle;
                if (cle) onSelect(cle);
              }}
            >
              <CartesianGrid horizontal={false} stroke={NEUTRES.bordure} />
              <XAxis
                type="number"
                ticks={graduations}
                domain={[graduations[0], graduations[graduations.length - 1]]}
                tickFormatter={(valeur: number) => formatMontantK(valeur, decimales)}
                fontSize={11}
                tick={{ fill: NEUTRES.secondaire }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="nom"
                width={150}
                fontSize={12}
                tick={{ fill: NEUTRES.encre }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<InfoBulle />} cursor={{ fill: NEUTRES.bordure, fillOpacity: 0.5 }} />
              <ReferenceLine x={0} stroke={NEUTRES.secondaire} />
              <Bar dataKey="montant" radius={[0, 4, 4, 0]} maxBarSize={20} isAnimationActive={false}>
                {categories.map((c) => (
                  <Cell
                    key={c.cle}
                    fill={TEINTE_SERIE_PRINCIPALE}
                    fillOpacity={selection !== null && selection !== c.cle ? OPACITE_ATTENUEE : 1}
                  />
                ))}
                <LabelList
                  dataKey="montant"
                  position="right"
                  formatter={(valeur: unknown) => libelleBarreauK(valeur)}
                  fontSize={10}
                  fill={NEUTRES.encre}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
