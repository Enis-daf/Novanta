"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { NEUTRES, OPACITE_ATTENUEE, teintesDesParts } from "@/lib/dataviz";
import { formatMontant, formatMontantK, formatPourcentage } from "@/lib/format";
import { CLE_AUTRES, PartStructure, Structure } from "@/lib/pastPnl";

interface PasseStructureChartProps {
  titre: string;
  structure: Structure;
  messageVide: string;
  // Interaction facultative (écrans de détail) : sans onSelect, le camembert est purement
  // descriptif — survol uniquement, aucun clic (onglet Général).
  selection?: string | null;
  onSelect?: (cle: string) => void;
  // Teinte attitrée de chaque catégorie (lib/dataviz.ts), pour qu'elle garde sa couleur quand un
  // filtre change la composition du camembert, et d'un écran à l'autre. À défaut : ordre des parts.
  teintes?: ReadonlyMap<string, string>;
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

export default function PasseStructureChart({
  titre,
  structure,
  messageVide,
  selection = null,
  onSelect,
  teintes,
}: PasseStructureChartProps) {
  const { parts, total, nombreNonRepresentees } = structure;
  // La taille d'une part est la valeur absolue de son montant ; le montant affiché reste signé.
  const donnees = parts.map((part) => ({ ...part, taille: Math.abs(part.montant) }));
  const couleurs = teintesDesParts(parts, teintes);
  // "Autres" regroupe plusieurs catégories : ce n'est pas un filtre.
  const cliquable = (part: PartStructure) => Boolean(onSelect) && part.cle !== CLE_AUTRES;
  const attenuee = (part: PartStructure) => selection !== null && part.cle !== selection;

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
                  stroke={NEUTRES.fond}
                  strokeWidth={2}
                  isAnimationActive={false}
                  onClick={onSelect ? (part: PartStructure) => cliquable(part) && onSelect(part.cle) : undefined}
                >
                  {donnees.map((part, index) => (
                    <Cell
                      key={part.cle}
                      fill={couleurs[index]}
                      fillOpacity={attenuee(part) ? OPACITE_ATTENUEE : 1}
                      style={{ cursor: cliquable(part) ? "pointer" : undefined, outline: "none" }}
                    />
                  ))}
                </Pie>
                <Tooltip content={<InfoBulle />} />
              </PieChart>
            </ResponsiveContainer>
            <p className="passe-structure__total">{formatMontantK(total)}</p>
          </div>
          <ul className="passe-structure__legende">
            {parts.map((part, index) => {
              const contenu = (
                <>
                  <span className="passe-structure__pastille" style={{ background: couleurs[index] }} aria-hidden="true" />
                  <span className="passe-structure__nom">{part.nom}</span>
                  <span className="passe-structure__montant">{formatMontantK(part.montant)}</span>
                  <span className="passe-structure__part">{formatPourcentage(part.part)}</span>
                </>
              );
              const classes = [
                "passe-structure__ligne",
                attenuee(part) ? "passe-structure__ligne--attenuee" : "",
                selection === part.cle ? "passe-structure__ligne--selection" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <li key={part.cle}>
                  {cliquable(part) ? (
                    <button
                      type="button"
                      className={`${classes} passe-structure__ligne--cliquable`}
                      aria-pressed={selection === part.cle}
                      onClick={() => onSelect!(part.cle)}
                    >
                      {contenu}
                    </button>
                  ) : (
                    <div className={classes}>{contenu}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {nombreNonRepresentees > 0 && (
        <p className="passe-structure__note">
          {nombreNonRepresentees > 1
            ? `${nombreNonRepresentees} catégories au montant nul ou de signe inhabituel ne sont pas représentées ; elles restent comptées dans les montants.`
            : "1 catégorie au montant nul ou de signe inhabituel n'est pas représentée ; elle reste comptée dans les montants."}
        </p>
      )}
    </section>
  );
}
