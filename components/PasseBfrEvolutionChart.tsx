"use client";

import { useState } from "react";
import { Bar, CartesianGrid, Cell, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { FAMILLE_BLEU_VERT, graduationsAxe, NEUTRES } from "@/lib/dataviz";
import { formatKiloEuros } from "@/lib/format";
import { LIBELLES_STATUT_BFR, libelleFinDeMois } from "@/lib/pastBfr";
import { libelleEcartEcheance } from "@/lib/pastBfrDelais";
import { DelaiDuPoint, PointBfr } from "@/lib/pastBfrLecture";

const enK = (montant: number) => `${formatKiloEuros(montant, Math.abs(montant) < 10_000 ? 1 : 0)} HT`;

// Séries de l'évolution, dans la famille bleue de la DA (jamais vert / rouge : un délai qui monte
// n'est ni bon ni mauvais sans contexte). BFR en barres sombres (axe k€) ; les deux délais en courbes
// plus claires de la même teinte (axe jours), distinguées par le trait : plein / tirets.
export const COULEUR_BFR = FAMILLE_BLEU_VERT[0];
export const COULEUR_DELAIS = FAMILLE_BLEU_VERT[2];
export const TIRETS_FOURNISSEURS = "6 4";
// Format des dates de l'axe selon la largeur du graphique, sans jamais retirer de mois : « 30/09/2026 »,
// puis « 30/09 » avec l'année sur une seconde ligne, puis « 30/09/26 » incliné sur téléphone.
export type FormatDates = "complet" | "deux_lignes" | "incline";
const LARGEUR_DATES_COMPLETES = 760;
const LARGEUR_DATES_DEUX_LIGNES = 520;

function LigneDelaiInfoBulle({ titre, d }: { titre: string; d: DelaiDuPoint }) {
  return (
    <>
      <span>
        {titre} : <strong>{d.moyen === null ? "Non disponible" : `${Math.round(d.moyen)} j`}</strong>
        {d.reglees > 0 && <span className="passe-structure__note"> ({d.reglees} réglée{d.reglees > 1 ? "s" : ""})</span>}
      </span>
      {d.moyen !== null && d.ecartEcheance !== null && <span className="passe-structure__note">{libelleEcartEcheance(d.ecartEcheance)}</span>}
      {d.moyen !== null && d.provisoire && (
        <span className="passe-structure__note">
          Provisoire
          {d.ouvertes > 0 ? ` — ${d.ouvertes} facture${d.ouvertes > 1 ? "s" : ""} encore ouverte${d.ouvertes > 1 ? "s" : ""}` : ""}
        </span>
      )}
    </>
  );
}

function InfoBulleBfr({ active, payload }: { active?: boolean; payload?: { payload: PointBfr }[] }) {
  if (!active || !payload?.length) return null;
  const { mois, totaux, statut, clients, fournisseurs } = payload[0].payload;
  return (
    <div className="passe-structure__infobulle">
      <strong>{libelleFinDeMois(mois)}</strong>
      {totaux === null ? (
        <>
          <span>
            BFR HT : <strong>Non disponible</strong>
          </span>
          <span className="passe-structure__note">BFR incomplet : données manquantes ou non fiables</span>
        </>
      ) : (
        <>
          <span>
            BFR HT : <strong>{enK(totaux.bfr)}</strong>
          </span>
          <span className="passe-structure__note">
            Créances {enK(totaux.creances)} · Stocks {enK(totaux.stock)} · Dettes {enK(totaux.dettes)}
          </span>
          <span className="passe-structure__note">{LIBELLES_STATUT_BFR[statut]}</span>
        </>
      )}
      <LigneDelaiInfoBulle titre="Délai clients" d={clients} />
      <LigneDelaiInfoBulle titre="Délai fournisseurs" d={fournisseurs} />
    </div>
  );
}

// Date de fin de mois sur l'axe (dernier jour calendaire du mois, jamais une date technique).
function GraduationFinDeMois({ x, y, payload, format }: { x?: number; y?: number; payload?: { value: string }; format: FormatDates }) {
  if (x === undefined || y === undefined || !payload) return null;
  const mois = payload.value;
  if (format === "incline") {
    const date = libelleFinDeMois(mois);
    return (
      <text x={x} y={y + 8} textAnchor="end" fontSize={10} fill={NEUTRES.secondaire} transform={`rotate(-50 ${x} ${y + 8})`}>
        {`${date.slice(0, 6)}${date.slice(8)}`}
      </text>
    );
  }
  return (
    <text x={x} y={y + 12} textAnchor="middle" fontSize={format === "complet" ? 11 : 10} fill={NEUTRES.secondaire}>
      {format === "complet" ? (
        libelleFinDeMois(mois)
      ) : (
        <>
          <tspan x={x}>{libelleFinDeMois(mois, true)}</tspan>
          <tspan x={x} dy={12}>
            {mois.slice(0, 4)}
          </tspan>
        </>
      )}
    </text>
  );
}

// Légende fidèle aux marques : carré plein (BFR), trait plein (clients), tirets (fournisseurs).
export function LegendeEvolution({ bfrAffiche }: { bfrAffiche: boolean }) {
  const trait = (tirets?: string) => (
    <svg width={22} height={10} aria-hidden="true">
      <line x1={1} y1={5} x2={21} y2={5} stroke={COULEUR_DELAIS} strokeWidth={2.5} strokeDasharray={tirets} />
    </svg>
  );
  return (
    <div className="passe-bfr__legende">
      {bfrAffiche && (
        <span>
          <svg width={12} height={12} aria-hidden="true">
            <rect width={12} height={12} rx={2} fill={COULEUR_BFR} />
          </svg>
          BFR HT (k€)
        </span>
      )}
      <span>
        {trait()}
        Délai clients (j)
      </span>
      <span>
        {trait(TIRETS_FOURNISSEURS)}
        Délai fournisseurs (j)
      </span>
    </div>
  );
}

/** BFR affiché sur l'évolution : au moins un mois a une situation complète. */
export function bfrAfficheDe(evolution: PointBfr[]): boolean {
  return evolution.some((p) => p.valeur !== null);
}

// Évolution sur 12 mois : BFR HT en barres (axe k€), délais clients / fournisseurs en courbes lissées
// (axe jours). Partagé par l'onglet BFR et par l'export PDF (rendu hors écran).
export default function PasseBfrEvolutionChart({
  evolution,
  courant,
  onSelect,
  formatImpose,
}: {
  evolution: PointBfr[];
  courant: string | null;
  onSelect?: (mois: string) => void;
  // Format des dates fixé d'avance (export PDF, rendu hors écran) plutôt que déduit de la largeur mesurée.
  formatImpose?: FormatDates;
}) {
  const [largeurEvolution, setLargeurEvolution] = useState(LARGEUR_DATES_COMPLETES);
  const valeurs = evolution.map((p) => p.valeur).filter((v): v is number => v !== null);
  const bfrAffiche = valeurs.length > 0;
  const delaisAffiches = evolution.some((p) => p.delaiClients !== null || p.delaiFournisseurs !== null);
  const graduations = graduationsAxe(valeurs.length > 0 ? valeurs : [0]);
  const formatDates: FormatDates =
    formatImpose ??
    (largeurEvolution >= LARGEUR_DATES_COMPLETES ? "complet" : largeurEvolution >= LARGEUR_DATES_DEUX_LIGNES ? "deux_lignes" : "incline");
  return (
    <div style={{ fontFamily: "var(--font-lexend), sans-serif", cursor: onSelect ? "pointer" : "default" }}>
      <ResponsiveContainer width="100%" height={260} onResize={(largeur) => setLargeurEvolution(largeur)}>
        <ComposedChart
          data={evolution}
          margin={{ top: 12, right: 8, left: bfrAffiche ? 0 : 24, bottom: formatDates === "complet" ? 0 : formatDates === "deux_lignes" ? 12 : 26 }}
          barCategoryGap="28%"
          onClick={(etat) => {
            if (onSelect && typeof etat?.activeLabel === "string") onSelect(etat.activeLabel);
          }}
        >
          <CartesianGrid vertical={false} stroke={NEUTRES.bordure} />
          <XAxis
            dataKey="mois"
            tick={<GraduationFinDeMois format={formatDates} />}
            axisLine={false}
            tickLine={false}
            interval={0}
          />
          <YAxis
            yAxisId="k"
            hide={!bfrAffiche}
            tickFormatter={(v: number) => formatKiloEuros(v, 0)}
            ticks={graduations}
            domain={[graduations[0], graduations[graduations.length - 1]]}
            width={formatDates === "complet" ? 72 : 56}
            fontSize={11}
            tick={{ fill: NEUTRES.secondaire }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            yAxisId="j"
            orientation="right"
            hide={!delaisAffiches}
            tickFormatter={(v: number) => `${v} j`}
            domain={[0, "auto"]}
            allowDecimals={false}
            width={44}
            fontSize={11}
            tick={{ fill: NEUTRES.secondaire }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip content={<InfoBulleBfr />} cursor={{ fill: NEUTRES.bordure, fillOpacity: 0.45 }} />
          {/* Barre pleine : situation validée ; atténuée : provisoire ; absente : mois incomplet. */}
          <Bar yAxisId="k" dataKey="valeur" name="BFR HT (k€)" maxBarSize={40} radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {evolution.map((p) => (
              <Cell
                key={p.mois}
                fill={COULEUR_BFR}
                fillOpacity={p.statut === "validee" ? 1 : 0.78}
                stroke={p.mois === courant ? NEUTRES.encre : "none"}
                strokeWidth={p.mois === courant ? 1.5 : 0}
              />
            ))}
          </Bar>
          {/* Lissage purement graphique (monotone) : les points restent les valeurs mensuelles réelles,
              un mois sans valeur coupe la courbe (connectNulls à false), rien n'est interpolé. */}
          <Line
            type="monotone"
            dataKey="delaiClients"
            name="Délai clients (j)"
            yAxisId="j"
            stroke={COULEUR_DELAIS}
            strokeWidth={2.5}
            connectNulls={false}
            isAnimationActive={false}
            dot={{ r: 3.5, fill: COULEUR_DELAIS, stroke: "#ffffff", strokeWidth: 1.5 }}
            activeDot={false}
          />
          <Line
            type="monotone"
            dataKey="delaiFournisseurs"
            name="Délai fournisseurs (j)"
            yAxisId="j"
            stroke={COULEUR_DELAIS}
            strokeWidth={2.5}
            strokeDasharray={TIRETS_FOURNISSEURS}
            connectNulls={false}
            isAnimationActive={false}
            dot={{ r: 3.5, fill: "#ffffff", stroke: COULEUR_DELAIS, strokeWidth: 2 }}
            activeDot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
