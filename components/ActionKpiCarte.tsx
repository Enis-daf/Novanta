"use client";

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  CATALOGUE_KPI,
  CLE_PERSONNALISE,
  formatEcartKpi,
  formatFraction,
  formatJourCourt,
  formatValeurKpi,
  PointSerie,
  StatutMois,
  SuiviKpi,
} from "@/lib/actionChantier";
import { graduationsAxe, NEUTRES, TEINTE_SERIE_PRINCIPALE } from "@/lib/dataviz";
import { MENTION_HT_ESTIME, MENTION_TTC } from "@/lib/format";
import { libelleMois, libelleMoisCourt } from "@/lib/pastDetail";

// Convention du module Passé (onglet BFR) : barreau plein = définitif, clair = provisoire.
const OPACITE_PROVISOIRE = 0.4;
// Au-delà, les barreaux d'une carte sont trop serrés pour porter chacun leur libellé.
const MAX_MOIS_AVEC_LIBELLES = 6;

const LIBELLES_STATUT: Record<StatutMois, string> = { clos: "Mois clos", en_cours: "En cours — provisoire", a_venir: "À venir" };

interface ActionKpiCarteProps {
  suivi: SuiviKpi;
  // Indicateur personnalisé : mois saisissables et enregistrement d'une valeur.
  saisie?: {
    mois: string[];
    enregistrer: (mois: string, valeur: number) => Promise<void>;
  };
}

function mentionDe(suivi: SuiviKpi): string | null {
  const { kpi } = suivi;
  if (kpi.cle === CLE_PERSONNALISE) return "Saisie manuelle";
  if (kpi.cle === "bfr") return "HT · situations validées";
  return CATALOGUE_KPI[kpi.cle].base === "ttc" ? MENTION_TTC : MENTION_HT_ESTIME;
}

function nomMois(mois: string): string {
  return libelleMois(mois).split(" ")[0];
}

export default function ActionKpiCarte({ suivi, saisie }: ActionKpiCarteProps) {
  const { kpi, actuelle, atteinte, nature } = suivi;
  const uniteLibre = kpi.unitePersonnalisee;
  const format = (valeur: number) => formatValeurKpi(valeur, suivi.unite, uniteLibre);
  const reference = kpi.reference;

  return (
    <article className="action-kpi" aria-label={suivi.libelle}>
      <header className="action-kpi__entete">
        <h3 className="eyebrow eyebrow--encre">{suivi.libelle}</h3>
        {mentionDe(suivi) && <span className="action-kpi__mention">{mentionDe(suivi)}</span>}
      </header>

      <p className={`action-kpi__valeur${actuelle ? "" : " action-kpi__valeur--absente"}`}>
        {actuelle ? format(actuelle.valeur) : suivi.etat === "a_venir" ? "À venir" : "Indisponible"}
      </p>
      <p className="action-kpi__cible">
        {nature === "cumulatif" ? "Objectif sur la période" : "Objectif"} : <strong>{format(kpi.cible)}</strong>
      </p>

      <Jauge suivi={suivi} />

      <p className={`action-kpi__evolution${evolutionDefavorable(suivi) ? " action-kpi__evolution--recul" : ""}`}>{libelleEvolution(suivi, format)}</p>

      <p className="action-kpi__reference">
        {reference.valeur !== null ? (
          <>
            Référence : {format(reference.valeur)} — {reference.libelle}
            {reference.origine === "indicative" && <span className="action-badge">Indicative</span>}
          </>
        ) : (
          "Aucune référence : historique insuffisant au lancement."
        )}
      </p>

      <p className="action-kpi__donnee">
        <StatutDonnee suivi={suivi} />
      </p>

      {suivi.messages.length > 0 && (
        <ul className={`action-kpi__messages${suivi.etat === "partiel" ? " action-kpi__messages--alerte" : ""}`}>
          {suivi.messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}

      <GraphiqueMensuel suivi={suivi} format={format} />

      {saisie && <SaisieManuelle suivi={suivi} saisie={saisie} />}
    </article>
  );
}

function Jauge({ suivi }: { suivi: SuiviKpi }) {
  const { atteinte } = suivi;
  const remplissage = atteinte.etat === "calcule" ? atteinte.jauge : atteinte.etat === "maintien" && atteinte.atteint ? 1 : 0;
  let texte: string;
  switch (atteinte.etat) {
    case "calcule":
      texte = atteinte.recul
        ? `${formatFraction(atteinte.fraction)} : recul par rapport au point de départ`
        : `${formatFraction(atteinte.fraction)} de l'objectif atteint`;
      break;
    case "maintien":
      texte = atteinte.atteint ? "Objectif de maintien : tenu" : "Objectif de maintien : pas tenu";
      break;
    case "sans_reference":
      texte = "Atteinte non calculable : aucune référence";
      break;
    case "sans_valeur":
      texte = suivi.etat === "a_venir" ? "Le suivi commence avec le chantier" : "Atteinte non calculable : aucune valeur";
      break;
  }
  const mesurable = atteinte.etat === "calcule" || atteinte.etat === "maintien";
  return (
    <div className="action-jauge">
      <div
        className={`action-jauge__piste${mesurable ? "" : " action-jauge__piste--inactive"}`}
        role="meter"
        aria-label={`Atteinte de l'objectif — ${suivi.libelle}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(remplissage * 100)}
        aria-valuetext={texte}
      >
        <div className="action-jauge__remplissage" style={{ width: `${remplissage * 100}%` }} />
      </div>
      <p className={`action-jauge__texte${atteinte.etat === "calcule" && atteinte.recul ? " action-jauge__texte--recul" : ""}`}>{texte}</p>
    </div>
  );
}

function evolutionDefavorable(suivi: SuiviKpi): boolean {
  const { actuelle, kpi, nature } = suivi;
  if (!actuelle || kpi.reference.valeur === null || nature === "cumulatif") return false;
  const ecart = actuelle.valeur - kpi.reference.valeur;
  return kpi.sens === "up" ? ecart < 0 : ecart > 0;
}

function libelleEvolution(suivi: SuiviKpi, format: (v: number) => string): string {
  const { actuelle, kpi, nature } = suivi;
  if (!actuelle) return "Évolution non mesurable pour le moment.";
  if (nature === "cumulatif") {
    // Un cumul repart de zéro : on dit ce qu'il reste à faire, pas un écart à une période entière.
    const reste = kpi.cible - actuelle.valeur;
    return reste > 0 ? `Reste ${format(reste)} à réaliser d'ici la fin du chantier` : `Objectif dépassé de ${format(-reste)}`;
  }
  if (kpi.reference.valeur === null) return "Évolution non mesurable : aucune référence.";
  const ecart = actuelle.valeur - kpi.reference.valeur;
  if (ecart === 0) return "Stable depuis la référence";
  return `${formatEcartKpi(ecart, suivi.unite, kpi.unitePersonnalisee)} depuis la référence`;
}

function StatutDonnee({ suivi }: { suivi: SuiviKpi }) {
  const { actuelle } = suivi;
  if (!actuelle) return <span className="action-statut">{suivi.etat === "a_venir" ? "Pas encore commencé" : "Aucune donnée"}</span>;
  if (actuelle.source === "manuel") {
    return <span className="action-statut action-statut--manuel">Saisie manuelle — {nomMois(actuelle.mois)}</span>;
  }
  if (actuelle.source === "en_cours") {
    return (
      <>
        <span className="action-statut action-statut--en-cours">{nomMois(actuelle.mois)} — en cours</span>
        <span>
          {actuelle.derniereOperation
            ? ` · provisoire, dernière opération le ${formatJourCourt(actuelle.derniereOperation)}`
            : " · provisoire, aucune opération ce mois-ci pour l'instant"}
        </span>
      </>
    );
  }
  return <span className="action-statut action-statut--clos">{nomMois(actuelle.mois)} — mois clos</span>;
}

interface PointGraphique extends PointSerie {
  hauteur: number | null;
}

function InfoBulle({ active, payload, format }: { active?: boolean; payload?: { payload: PointGraphique }[]; format: (v: number) => string }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="passe-structure__infobulle">
      <strong>{libelleMois(point.mois)}</strong>
      <span>{point.valeur !== null ? format(point.valeur) : (point.raison ?? "Pas de valeur")}</span>
      <span className="passe-structure__note">{LIBELLES_STATUT[point.statut]}</span>
      {point.avertissements.map((a) => (
        <span key={a} className="passe-structure__note">
          {a}
        </span>
      ))}
    </div>
  );
}

function GraduationMois({ x, y, payload, points, plusieursAnnees }: { x?: number; y?: number; payload?: { value: string }; points: PointSerie[]; plusieursAnnees: boolean }) {
  const mois = payload?.value ?? "";
  const statut = points.find((p) => p.mois === mois)?.statut;
  return (
    <g transform={`translate(${x},${y})`}>
      <text dy={12} textAnchor="middle" fontSize={11} fill={statut === "a_venir" ? NEUTRES.autres : NEUTRES.secondaire}>
        {libelleMoisCourt(mois, plusieursAnnees)}
      </text>
      {statut === "en_cours" && (
        <text dy={25} textAnchor="middle" fontSize={10} fontWeight={600} fill={NEUTRES.encre}>
          en cours
        </text>
      )}
    </g>
  );
}

function GraphiqueMensuel({ suivi, format }: { suivi: SuiviKpi; format: (v: number) => string }) {
  const { points, kpi, nature } = suivi;
  const donnees: PointGraphique[] = points.map((p) => ({ ...p, hauteur: p.valeur }));
  const valeurs = points.flatMap((p) => (p.valeur === null ? [] : [p.valeur]));
  const graduations = graduationsAxe([...valeurs, kpi.cible]);
  const plusieursAnnees = new Set(points.map((p) => p.mois.slice(0, 4))).size > 1;
  // Axe : l'unité libre (« jours ») est dans le titre du graphique, pas sur chaque graduation.
  const formatAxe = (v: number) => (suivi.unite === "libre" ? formatValeurKpi(v, "libre") : format(v));
  const titre =
    nature === "cumulatif"
      ? "Cumul depuis le début du chantier"
      : nature === "taux"
        ? "Taux depuis le début du chantier"
        : nature === "situation"
          ? "Situation en fin de mois"
          : `Valeur saisie par mois${kpi.unitePersonnalisee ? ` (${kpi.unitePersonnalisee})` : ""}`;

  return (
    <section className="action-graphique" aria-label={`${titre} — ${suivi.libelle}`}>
      <p className="action-graphique__titre">{titre}</p>
      <div style={{ fontFamily: "var(--font-lexend), sans-serif" }}>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={donnees} margin={{ top: 22, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid vertical={false} stroke={NEUTRES.bordure} />
            <XAxis
              dataKey="mois"
              tick={<GraduationMois points={points} plusieursAnnees={plusieursAnnees} />}
              height={34}
              interval={0}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={formatAxe}
              ticks={graduations}
              domain={[graduations[0], graduations[graduations.length - 1]]}
              width={64}
              fontSize={11}
              tick={{ fill: NEUTRES.secondaire }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<InfoBulle format={format} />} cursor={{ fill: NEUTRES.bordure, fillOpacity: 0.5 }} />
            <ReferenceLine y={0} stroke={NEUTRES.secondaire} />
            {/* Cible fixe : une ligne horizontale constante sur toute la période, jamais une trajectoire. */}
            <ReferenceLine
              y={kpi.cible}
              stroke={NEUTRES.encre}
              strokeWidth={1.5}
              ifOverflow="extendDomain"
              label={{ value: `Objectif ${format(kpi.cible)}`, position: "insideTopRight", fill: NEUTRES.encre, fontSize: 11, fontWeight: 600, dy: -16 }}
            />
            <Bar dataKey="hauteur" radius={[3, 3, 0, 0]} maxBarSize={32} isAnimationActive={false}>
              {donnees.map((p) => (
                <Cell key={p.mois} fill={TEINTE_SERIE_PRINCIPALE} fillOpacity={p.statut === "en_cours" ? OPACITE_PROVISOIRE : 1} />
              ))}
              {donnees.length <= MAX_MOIS_AVEC_LIBELLES && (
                <LabelList
                  dataKey="hauteur"
                  position="top"
                  formatter={(v: unknown) => (typeof v === "number" ? format(v) : "")}
                  fontSize={10}
                  fill={NEUTRES.encre}
                />
              )}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="passe-message">Plein : mois clos · clair : mois en cours, provisoire · trait : objectif. Aucun mois à venir n'est estimé.</p>
    </section>
  );
}

function lireNombre(saisie: string): number | null {
  const nettoye = saisie.replace(/[\s  ]/g, "").replace(",", ".");
  if (nettoye === "" || !/^-?\d+(\.\d+)?$/.test(nettoye)) return null;
  return Number(nettoye);
}

function SaisieManuelle({ suivi, saisie }: { suivi: SuiviKpi; saisie: NonNullable<ActionKpiCarteProps["saisie"]> }) {
  const [mois, setMois] = useState(saisie.mois[saisie.mois.length - 1] ?? "");
  const existante = (m: string) => suivi.points.find((p) => p.mois === m)?.valeur ?? null;
  const [valeur, setValeur] = useState(() => {
    const v = existante(mois);
    return v === null ? "" : String(v).replace(".", ",");
  });
  const [etat, setEtat] = useState<{ enCours: boolean; erreur: string | null; ok: boolean }>({ enCours: false, erreur: null, ok: false });

  if (saisie.mois.length === 0) return null;

  const choisirMois = (m: string) => {
    setMois(m);
    const v = existante(m);
    setValeur(v === null ? "" : String(v).replace(".", ","));
    setEtat({ enCours: false, erreur: null, ok: false });
  };

  const enregistrer = async () => {
    const nombre = lireNombre(valeur);
    if (nombre === null) {
      setEtat({ enCours: false, erreur: "Saisissez un nombre.", ok: false });
      return;
    }
    setEtat({ enCours: true, erreur: null, ok: false });
    try {
      await saisie.enregistrer(mois, nombre);
      setEtat({ enCours: false, erreur: null, ok: true });
    } catch {
      setEtat({ enCours: false, erreur: "Enregistrement impossible pour le moment.", ok: false });
    }
  };

  return (
    <form
      className="action-saisie"
      onSubmit={(e) => {
        e.preventDefault();
        void enregistrer();
      }}
    >
      <p className="action-graphique__titre">Valeur observée</p>
      <div className="action-saisie__ligne">
        <select aria-label="Mois de la valeur" value={mois} onChange={(e) => choisirMois(e.target.value)}>
          {saisie.mois.map((m) => (
            <option key={m} value={m}>
              {libelleMois(m)}
            </option>
          ))}
        </select>
        <span className="action-champ-unite">
          <input
            type="text"
            inputMode="decimal"
            aria-label={`Valeur de ${libelleMois(mois)}`}
            value={valeur}
            onChange={(e) => {
              setValeur(e.target.value);
              setEtat({ enCours: false, erreur: null, ok: false });
            }}
          />
          <span>{suivi.kpi.unitePersonnalisee}</span>
        </span>
        <button type="submit" className="btn-secondaire" disabled={etat.enCours}>
          {etat.enCours ? "Enregistrement…" : "Enregistrer"}
        </button>
      </div>
      {etat.erreur && <p className="login-erreur">{etat.erreur}</p>}
      {etat.ok && <p className="passe-message">Valeur enregistrée.</p>}
    </form>
  );
}
