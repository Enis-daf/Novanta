"use client";

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  CarteKpi,
  formatJourCourt,
  formatValeurKpi,
  libelleAtteinte,
  libelleEcartReference,
  LibellesReference,
  PointSerie,
  StatutMois,
  SuiviKpi,
} from "@/lib/actionChantier";
import { graduationsAxe, NEUTRES, TEINTE_SERIE_PRINCIPALE } from "@/lib/dataviz";
import { libelleMois, libelleMoisCourt } from "@/lib/pastDetail";

// Convention du module Passé (onglet BFR) : barreau plein = définitif, clair = provisoire.
const OPACITE_PROVISOIRE = 0.4;
// Au-delà, les barreaux d'une carte sont trop serrés pour porter chacun leur libellé.
const MAX_MOIS_AVEC_LIBELLES = 6;

const LIBELLES_STATUT: Record<StatutMois, string> = { clos: "Mois clos", en_cours: "En cours — provisoire", a_venir: "À venir" };

interface ActionKpiCarteProps {
  carte: CarteKpi;
  // Fiche d'un chantier clôturé : photographie de la clôture, aucune saisie.
  figee?: boolean;
  // Indicateur personnalisé : mois saisissables et enregistrement d'une valeur.
  saisie?: {
    mois: string[];
    enregistrer: (mois: string, valeur: number) => Promise<void>;
  };
}

function nomMois(mois: string): string {
  return libelleMois(mois).split(" ")[0];
}

export default function ActionKpiCarte({ carte, figee = false, saisie }: ActionKpiCarteProps) {
  const { suivi, mention, reference: libelles } = carte;
  const { kpi, actuelle, nature } = suivi;
  const uniteLibre = kpi.unitePersonnalisee;
  const format = (valeur: number) => formatValeurKpi(valeur, suivi.unite, uniteLibre);
  const reference = kpi.reference;

  return (
    <article className="action-kpi" aria-label={suivi.libelle}>
      <header className="action-kpi__entete">
        <h3 className="eyebrow eyebrow--encre">{suivi.libelle}</h3>
        <span className="action-kpi__mention">{mention}</span>
      </header>

      <p className={`action-kpi__valeur${actuelle ? "" : " action-kpi__valeur--absente"}`}>
        {actuelle ? format(actuelle.valeur) : suivi.etat === "a_venir" ? "À venir" : "Indisponible"}
      </p>
      <p className="action-kpi__cible">
        {nature === "cumulatif" ? "Objectif sur la période" : "Objectif"} : <strong>{format(kpi.cible)}</strong>
      </p>

      <Jauge suivi={suivi} />

      <p className={`action-kpi__evolution${evolutionDefavorable(suivi) ? " action-kpi__evolution--recul" : ""}`}>{libelleEvolution(suivi, format, libelles)}</p>

      <p className="action-kpi__reference">
        {reference.valeur !== null ? (
          <>
            Référence : {format(reference.valeur)} — {libelles.detail}
            {reference.origine === "indicative" && <span className="action-badge">Indicative</span>}
          </>
        ) : (
          "Aucune référence : historique insuffisant au lancement."
        )}
      </p>

      <p className="action-kpi__donnee">
        <StatutDonnee suivi={suivi} figee={figee} />
      </p>

      {suivi.messages.length > 0 && (
        <ul className={`action-kpi__messages${suivi.etat === "partiel" ? " action-kpi__messages--alerte" : ""}`}>
          {suivi.messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}

      <GraphiqueMensuel suivi={suivi} format={format} />

      {saisie && !figee && <SaisieManuelle suivi={suivi} saisie={saisie} />}
    </article>
  );
}

function Jauge({ suivi }: { suivi: SuiviKpi }) {
  const { atteinte } = suivi;
  // La jauge se remplit au plus à 100 % : un dépassement se lit dans le texte, pas dans la jauge.
  const remplissage = atteinte.etat === "calcule" ? atteinte.jauge : atteinte.etat === "maintien" && atteinte.atteint ? 1 : 0;
  const { texte, recul } = libelleAtteinte(atteinte, suivi.etat);
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
      <p className={`action-jauge__texte${recul ? " action-jauge__texte--recul" : ""}`}>{texte}</p>
    </div>
  );
}

function evolutionDefavorable(suivi: SuiviKpi): boolean {
  const { actuelle, kpi, nature } = suivi;
  if (!actuelle || kpi.reference.valeur === null || nature === "cumulatif") return false;
  const ecart = actuelle.valeur - kpi.reference.valeur;
  return kpi.sens === "up" ? ecart < 0 : ecart > 0;
}

function libelleEvolution(suivi: SuiviKpi, format: (v: number) => string, libelles: LibellesReference): string {
  const { actuelle, kpi, nature } = suivi;
  if (!actuelle) return "Évolution non mesurable pour le moment.";
  if (nature === "cumulatif") {
    // Un cumul repart de zéro : on dit ce qu'il reste à faire, pas un écart à une période entière.
    const reste = kpi.cible - actuelle.valeur;
    if (format(Math.abs(reste)) === format(0)) return "Montant visé atteint";
    return reste > 0 ? `Reste ${format(reste)} à réaliser d'ici la fin du chantier` : `${format(-reste)} au-delà du montant visé`;
  }
  if (kpi.reference.valeur === null) return "Évolution non mesurable : aucune référence.";
  return libelleEcartReference(actuelle.valeur - kpi.reference.valeur, suivi.unite, kpi.unitePersonnalisee, libelles) ?? "Évolution non mesurable : aucune référence.";
}

function StatutDonnee({ suivi, figee }: { suivi: SuiviKpi; figee: boolean }) {
  const { actuelle } = suivi;
  if (!actuelle) return <span className="action-statut">{suivi.etat === "a_venir" ? "Pas encore commencé" : "Aucune donnée"}</span>;
  if (actuelle.source === "manuel") {
    return <span className="action-statut action-statut--manuel">Saisie manuelle — {nomMois(actuelle.mois)}</span>;
  }
  if (actuelle.source === "en_cours") {
    return (
      <>
        <span className="action-statut action-statut--en-cours">{nomMois(actuelle.mois)} — en cours{figee ? " à la clôture" : ""}</span>
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
              // Jusqu'à 6 mois, chaque mois est nommé ; au-delà, Recharts saute des mois plutôt que de
              // les superposer sur une carte étroite (téléphone, chantier annuel).
              interval={points.length > MAX_MOIS_AVEC_LIBELLES ? "preserveStartEnd" : 0}
              minTickGap={6}
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
