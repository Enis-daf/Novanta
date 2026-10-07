"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { formatMontant, formatPourcentage } from "@/lib/format";
import { CLE_AUTRES, PartStructure, Structure } from "@/lib/pastPnl";

interface PasseStructureChartProps {
  titre: string;
  structure: Structure;
  messageVide: string;
}

// Teintes des parts, attribuées dans cet ordre fixe (jamais recyclées : au-delà, les plus petites
// catégories sont regroupées dans "Autres", en gris). Jeu vérifié pour rester distinguable en
// vision des couleurs altérée ; deux teintes contrastent peu avec le fond, d'où la légende chiffrée
// toujours visible à côté du graphique.
const TEINTES = ["#f02894", "#2a78d6", "#eda100", "#1baf7a", "#4a3aa7"];
const TEINTE_AUTRES = "#9ca3af";

function teinte(part: PartStructure, index: number): string {
  return part.cle === CLE_AUTRES ? TEINTE_AUTRES : TEINTES[index % TEINTES.length];
}

function InfoBulle({ active, payload }: { active?: boolean; payload?: { payload: PartStructure }[] }) {
  if (!active || !payload?.length) return null;
  const part = payload[0].payload;
  return (
    <div className="passe-structure__infobulle">
      <strong>{part.nom}</strong>
      <span>{formatMontant(part.montant)}</span>
      <span>{formatPourcentage(part.part)} du total</span>
    </div>
  );
}

// Camembert purement descriptif : survol uniquement, aucun clic ni filtrage.
export default function PasseStructureChart({ titre, structure, messageVide }: PasseStructureChartProps) {
  const { parts, total, nombreNonRepresentees } = structure;
  // La taille d'une part est la valeur absolue de son montant ; le montant affiché reste signé.
  const donnees = parts.map((part) => ({ ...part, taille: Math.abs(part.montant) }));

  return (
    <section className="passe-structure">
      <h3 className="passe-structure__titre">{titre}</h3>
      {parts.length === 0 ? (
        <p className="passe-structure__vide">{messageVide}</p>
      ) : (
        <div className="passe-structure__corps">
          <div className="passe-structure__graphique">
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={donnees}
                  dataKey="taille"
                  nameKey="nom"
                  innerRadius={56}
                  outerRadius={92}
                  startAngle={90}
                  endAngle={-270}
                  stroke="#fffefa"
                  strokeWidth={2}
                  isAnimationActive={false}
                >
                  {donnees.map((part, index) => (
                    <Cell key={part.cle} fill={teinte(part, index)} />
                  ))}
                </Pie>
                <Tooltip content={<InfoBulle />} />
              </PieChart>
            </ResponsiveContainer>
            <p className="passe-structure__total">{formatMontant(total)}</p>
          </div>
          <ul className="passe-structure__legende">
            {parts.map((part, index) => (
              <li key={part.cle}>
                <span className="passe-structure__pastille" style={{ background: teinte(part, index) }} aria-hidden="true" />
                <span className="passe-structure__nom">{part.nom}</span>
                <span className="passe-structure__montant">{formatMontant(part.montant)}</span>
                <span className="passe-structure__part">{formatPourcentage(part.part)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {nombreNonRepresentees > 0 && (
        <p className="passe-structure__note">
          {nombreNonRepresentees > 1
            ? `${nombreNonRepresentees} catégories au montant nul ou de signe contraire ne sont pas représentées.`
            : "1 catégorie au montant nul ou de signe contraire n'est pas représentée."}
        </p>
      )}
    </section>
  );
}
