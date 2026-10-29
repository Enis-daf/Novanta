"use client";

import MentionTTC from "./MentionTTC";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { NEUTRES, TEINTE_SERIE_PRINCIPALE } from "@/lib/dataviz";
import { formatMontant } from "@/lib/format";
import { LIBELLE_ENCAISSEMENTS, NATURES_REVENU, NatureRevenu } from "@/lib/pastCategoryMapping";
import { libelleMois, libelleMoisCourt } from "@/lib/pastDetail";
import { MoisRecurrence, RaisonPartIndisponible, RecurrenceRevenu } from "@/lib/pastRecurrence";
import { MAX_MOIS_AVEC_LIBELLES } from "./PasseEvolutionChart";

interface PasseRecurrenceProps {
  recurrence: RecurrenceRevenu;
  // Mention des montants : « TTC » ou « HT estimé », comme l'écran Encaissements.
  mention: string;
  // Paramétrage indisponible (colonne de nature absente en base) : rien ne peut être classé.
  parametrageIndisponible: boolean;
  onClasser: () => void;
}

const LIBELLE_NATURE: Record<NatureRevenu, string> = Object.fromEntries(NATURES_REVENU.map((n) => [n.cle, n.court])) as Record<NatureRevenu, string>;

const RAISONS: Record<RaisonPartIndisponible, string> = {
  aucun_encaissement: "Aucun encaissement sur la période.",
  aucun_classe: "Aucun encaissement de la période n'est encore classé en revenu récurrent ou ponctuel.",
  base_non_positive: "Part non calculable : les remboursements dépassent les encaissements classés sur la période.",
};

// Part entière (« 42 % ») : une décimale de plus ne dirait rien de la récurrence.
const formatPart = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 0 });
const pourcent = (part: number) => formatPart.format(part);

function InfoBulle({ active, payload, mention }: { active?: boolean; payload?: { payload: MoisRecurrence }[]; mention: string }) {
  if (!active || !payload?.length) return null;
  const { mois, recurrent, ponctuel, aClasser, part } = payload[0].payload;
  return (
    <div className="passe-structure__infobulle">
      <strong>{libelleMois(mois)}</strong>
      <span>Part du revenu récurrent : {part === null ? "non disponible" : pourcent(part)}</span>
      <span className="passe-structure__note">{`Revenu récurrent : ${formatMontant(recurrent)} ${mention}`}</span>
      <span className="passe-structure__note">{`Revenu ponctuel : ${formatMontant(ponctuel)} ${mention}`}</span>
      {aClasser !== 0 && <span className="passe-structure__note">{`À classer : ${formatMontant(aClasser)} ${mention}, hors de la part`}</span>}
    </div>
  );
}

// Écran « Revenu récurrent » (offre Pilotage) : quelle part des Encaissements de la période provient
// d'un revenu récurrent, pour quel montant, et comment cette part évolue de mois en mois. Lecture
// seule : les montants viennent des parts de l'écran Encaissements (lib/pastRecurrence.ts).
export default function PasseRecurrence({ recurrence, mention, parametrageIndisponible, onClasser }: PasseRecurrenceProps) {
  const { part, raison } = recurrence;
  const plusieursAnnees = new Set(recurrence.mois.map((m) => m.mois.slice(0, 4))).size > 1;
  const moisAvecPart = recurrence.mois.filter((m) => m.part !== null).length;

  if (parametrageIndisponible) {
    return (
      <div className="passe-etat">
        <p>La nature du revenu n&apos;est pas encore disponible pour votre organisation.</p>
        <p>Elle sera proposée dans la correspondance P&amp;L dès son activation.</p>
      </div>
    );
  }

  return (
    <div className="passe-detail">
      <div className="passe-detail__gauche">
        <section className="passe-kpi">
          <p className="eyebrow eyebrow--grand">Part du revenu récurrent</p>
          {part === null ? (
            <p className="passe-kpi__montant passe-kpi__montant--incomplet">Non disponible</p>
          ) : (
            <p className="passe-kpi__montant">{pourcent(part)}</p>
          )}
          <p className="passe-kpi__ratio">
            {part === null && raison ? RAISONS[raison] : "Revenu récurrent / encaissements classés en revenu récurrent ou ponctuel"}
          </p>
          {/* Catégories d'Encaissements sans nature : hors de la part, jamais comptées comme ponctuelles. */}
          {recurrence.categoriesAClasser > 0 && (
            <p className="passe-reserve">
              {recurrence.categoriesAClasser > 1
                ? `${recurrence.categoriesAClasser} catégories d'encaissement restent à classer`
                : "1 catégorie d'encaissement reste à classer"}{" "}
              ({formatMontant(recurrence.aClasser)} {mention} sur la période) : ni récurrentes ni ponctuelles, elles sont hors de la part.{" "}
              <button type="button" className="passe-lien-ligne" onClick={onClasser}>
                Classer dans la correspondance P&amp;L →
              </button>
            </p>
          )}
        </section>

        <section className="passe-ecarts__kpi">
          <div>
            <p className="passe-ecarts__kpi-libelle">Revenu récurrent</p>
            <p className="passe-ecarts__kpi-valeur">
              {formatMontant(recurrence.recurrent)}
              <MentionTTC libelle={mention} />
            </p>
          </div>
          <div>
            <p className="passe-ecarts__kpi-libelle">Revenu ponctuel</p>
            <p className="passe-ecarts__kpi-valeur">
              {formatMontant(recurrence.ponctuel)}
              <MentionTTC libelle={mention} />
            </p>
          </div>
        </section>
        <p className="passe-message">
          {LIBELLE_ENCAISSEMENTS} de la période : {formatMontant(recurrence.encaissements)} {mention}
          {recurrence.aClasser !== 0 && ` dont ${formatMontant(recurrence.aClasser)} à classer`}
          {recurrence.ajustements !== 0 && `${recurrence.aClasser !== 0 ? " et" : " dont"} ${formatMontant(recurrence.ajustements)} d'ajustements de gestion (sans nature de revenu)`}.
        </p>

        <section className="passe-structure">
          <h3 className="eyebrow eyebrow--encre">Part du revenu récurrent par mois</h3>
          {moisAvecPart === 0 ? (
            <p className="passe-structure__vide">Aucun mois de la période n&apos;a d&apos;encaissement classé.</p>
          ) : (
            <div style={{ fontFamily: "var(--font-lexend), sans-serif" }}>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={recurrence.mois} margin={{ top: 20, right: 8, left: 0, bottom: 0 }}>
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
                    domain={[0, 1]}
                    ticks={[0, 0.25, 0.5, 0.75, 1]}
                    tickFormatter={(v: number) => pourcent(v)}
                    width={48}
                    fontSize={11}
                    tick={{ fill: NEUTRES.secondaire }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip content={<InfoBulle mention={mention} />} cursor={{ fill: NEUTRES.bordure, fillOpacity: 0.5 }} />
                  {/* Un mois sans encaissement classé n'a pas de barreau : jamais 0 % par défaut. */}
                  <Bar dataKey="part" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false}>
                    {recurrence.mois.map((m) => (
                      <Cell key={m.mois} fill={TEINTE_SERIE_PRINCIPALE} />
                    ))}
                    {recurrence.mois.length <= MAX_MOIS_AVEC_LIBELLES && (
                      <LabelList
                        dataKey="part"
                        position="top"
                        formatter={(v: unknown) => (typeof v === "number" ? pourcent(v) : "")}
                        fontSize={10}
                        fill={NEUTRES.encre}
                      />
                    )}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {moisAvecPart > 0 && moisAvecPart < recurrence.mois.length && (
            <p className="passe-reserve">Pas de barreau : aucun encaissement classé ce mois-là (jamais compté 0 %).</p>
          )}
        </section>
      </div>

      <section className="passe-detail__droite">
        <h3 className="eyebrow eyebrow--encre">
          Catégories d&apos;encaissement
          <span className="passe-detail__compte"> {recurrence.categories.length}</span>
        </h3>
        {recurrence.categories.length === 0 ? (
          <p className="passe-structure__vide">Aucune catégorie d&apos;encaissement active sur la période.</p>
        ) : (
          <div className="table-wrapper">
            <table className="passe-table">
              <thead>
                <tr>
                  <th>Catégorie</th>
                  <th>Nature du revenu</th>
                  <th className="col-montant">
                    Montant
                    <MentionTTC libelle={mention} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {recurrence.categories.map((c) => (
                  <tr key={c.sourceCategoryId}>
                    <td className="passe-table__libelle">{c.nom}</td>
                    <td>
                      {c.nature === null ? (
                        <span className="passe-statut passe-statut--a-mapper">À classer</span>
                      ) : (
                        <span className="passe-statut">{LIBELLE_NATURE[c.nature]}</span>
                      )}
                    </td>
                    <td className="col-montant passe-table__montant">{formatMontant(c.montant)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="passe-message">La nature d&apos;une catégorie se choisit dans la correspondance P&amp;L ; elle s&apos;applique à tout son historique.</p>
      </section>
    </div>
  );
}
