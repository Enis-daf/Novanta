"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatKiloEuros, formatMontant } from "@/lib/format";
import { NEUTRES, TEINTE_SERIE_PRINCIPALE, TEINTE_TOTAL } from "@/lib/dataviz";
import {
  annonceDemarrage,
  CleGroupe,
  dateArrete,
  dateLongue,
  intervalleDates,
  libellePeriode,
  phraseEcart,
  Precision,
  TypePeriode,
} from "@/lib/fiabiliteProjection";
import type { SourceFlux } from "@/lib/cash-engine";
import type { DetailFiabilite, PointFiabilite, ReponseFiabilite } from "@/lib/fiabiliteApi";

const LIBELLES_SOURCE: Record<SourceFlux, string> = {
  facture_client: "Facture client",
  facture_fournisseur: "Facture fournisseur",
  financement: "Financement prévu",
  charge_fixe: "Charge fixe",
  autre_depense: "Autre dépense",
  rentree_reguliere: "Rentrée régulière",
};

const INFOBULLE_GLOBALE =
  "La précision globale tient compte des écarts par étage, sans compenser les hausses et les baisses de dépenses.";

type Serie = "globale" | "encaissements" | "decaissements";
const SERIES: { cle: Serie; libelle: string }[] = [
  { cle: "globale", libelle: "Global" },
  { cle: "encaissements", libelle: "Encaissements" },
  { cle: "decaissements", libelle: "Décaissements" },
];

type Selection = CleGroupe | "encaissements";

function textePrecision(p: Precision | null): string {
  if (!p) return "—";
  if (p.statut === "flux_non_prevu") return "Flux non prévu";
  if (p.statut === "aucun_flux") return "Aucun flux";
  return `${p.valeur.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`;
}

const instantLong = (iso: string) =>
  new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Paris" }).format(new Date(iso));

/** Waterfall : décaissements prévus → écart de chaque groupe → décaissements réalisés. */
function WaterfallDecaissements({
  detail,
  selection,
  onSelect,
}: {
  detail: DetailFiabilite;
  selection: Selection | null;
  onSelect: (cle: CleGroupe) => void;
}) {
  const c = detail.comparaison!;
  let cumul = c.decaissements.prevu;
  const barreaux = [
    { cle: "prevu", nom: "Décaissements prévus", plage: [0, c.decaissements.prevu] as [number, number], valeur: c.decaissements.prevu, groupe: null as CleGroupe | null },
    ...c.groupes
      .filter((g) => Math.abs(g.ecart) >= 0.005)
      .map((g) => {
        const debut = cumul;
        cumul += g.ecart;
        return { cle: g.cle, nom: g.libelle, plage: [debut, cumul] as [number, number], valeur: g.ecart, groupe: g.cle as CleGroupe | null };
      }),
    { cle: "realise", nom: "Décaissements réalisés", plage: [0, c.decaissements.realise] as [number, number], valeur: c.decaissements.realise, groupe: null },
  ];
  return (
    <div className="fiabilite-waterfall" aria-label="Écarts de décaissements par étage">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={barreaux} margin={{ top: 12, right: 8, bottom: 8, left: 8 }}>
          <CartesianGrid vertical={false} stroke={NEUTRES.bordure} />
          <XAxis dataKey="nom" tick={{ fontSize: 10 }} interval={0} tickLine={false} />
          <YAxis tickFormatter={(v: number) => formatKiloEuros(v, 0)} tick={{ fontSize: 10 }} width={56} />
          <Tooltip
            cursor={{ fill: "rgba(3,10,22,0.04)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const b = payload[0].payload as (typeof barreaux)[number];
              return (
                <div className="passe-structure__infobulle">
                  <strong>{b.nom}</strong>
                  <span>{b.groupe ? phraseEcart(b.valeur, formatMontant) : formatMontant(b.valeur)}</span>
                </div>
              );
            }}
          />
          <Bar dataKey="plage" isAnimationActive={false} onClick={(d: { groupe?: CleGroupe | null }) => d.groupe && onSelect(d.groupe)}>
            {barreaux.map((b) => (
              <Cell
                key={b.cle}
                cursor={b.groupe ? "pointer" : "default"}
                fill={b.groupe ? TEINTE_SERIE_PRINCIPALE : TEINTE_TOTAL}
                fillOpacity={selection && b.groupe && selection !== b.groupe ? 0.35 : 1}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Lignes prévues et flux constatés d'un groupe (ou des encaissements). Aucun lien inventé entre les deux. */
function DetailSelection({ detail, selection }: { detail: DetailFiabilite; selection: Selection }) {
  const prevues = (detail.reference?.lignes ?? []).filter((l) => (selection === "encaissements" ? l.groupe === null : l.groupe === selection));
  const constatees = detail.realise.lignes.filter((l) => (selection === "encaissements" ? l.groupe === null : l.groupe === selection));
  const somme = (lignes: { montant: number }[]) => Math.abs(lignes.reduce((s, l) => s + l.montant, 0));
  const titre = selection === "encaissements" ? "Encaissements" : detail.comparaison?.groupes.find((g) => g.cle === selection)?.libelle ?? "À classer";
  return (
    <div className="fiabilite-detail">
      <h4>{titre}</h4>
      <p className="fiabilite-note">
        Lignes prévues et flux bancaires constatés, côte à côte. Aucun rapprochement ligne à ligne n&apos;est établi entre une
        prévision et une transaction.
      </p>
      <h5>
        Prévu — {formatMontant(somme(prevues))} <span className="fiabilite-note">({prevues.length} ligne{prevues.length > 1 ? "s" : ""})</span>
      </h5>
      {prevues.length === 0 ? (
        <p className="fiabilite-note">Aucune ligne prévue.</p>
      ) : (
        <table className="invoice-table fiabilite-table">
          <tbody>
            {prevues.map((l, i) => (
              <tr key={`${l.source}:${l.sourceId}:${l.date}:${i}`}>
                <td>{dateLongue(l.date)}</td>
                <td className="fiabilite-table__libelle">{l.libelle || "Sans libellé"}</td>
                <td>{LIBELLES_SOURCE[l.source]}</td>
                <td className="col-montant">{formatMontant(Math.abs(l.montant))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h5>
        Constaté — {formatMontant(somme(constatees))} <span className="fiabilite-note">({constatees.length} flux)</span>
      </h5>
      {constatees.length === 0 ? (
        <p className="fiabilite-note">Aucun flux bancaire constaté.</p>
      ) : (
        <table className="invoice-table fiabilite-table">
          <tbody>
            {constatees.map((l, i) => (
              <tr key={`${l.transactionId}:${l.groupe}:${i}`}>
                <td>{dateLongue(l.date)}</td>
                <td className="fiabilite-table__libelle">{l.libelle || "Sans libellé"}</td>
                <td>Transaction bancaire</td>
                <td className="col-montant">{formatMontant(Math.abs(l.montant))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {selection === "a_classer" && (
        <p className="fiabilite-note">
          Sorties sans étage de dépense : à classer dans la <a href="/passe">correspondance P&amp;L de Passé</a> (réalisé) ou
          dans les tableaux de Futur (prévu).
        </p>
      )}
    </div>
  );
}

/** Évolution de la précision : un point par période publiable, jamais de valeur inventée. */
function HistoriquePrecision({ points, serie, onSerie, onSelect, selection }: {
  points: PointFiabilite[];
  serie: Serie;
  onSerie: (s: Serie) => void;
  onSelect: (debut: string) => void;
  selection: string;
}) {
  const donnees = [...points].reverse().map((p) => {
    const precisionSerie = p.publiable ? p[serie] : null;
    return {
      debut: p.periode.debut,
      nom: p.periode.type === "month" ? libellePeriode(p.periode).slice(0, 3) + " " + p.periode.debut.slice(2, 4) : `T ${p.periode.debut.slice(5, 7)}/${p.periode.debut.slice(2, 4)}`,
      valeur: precisionSerie?.statut === "score" ? Math.round(precisionSerie.valeur * 10) / 10 : null,
    };
  });
  const aucunPoint = donnees.every((d) => d.valeur === null);
  return (
    <div className="fiabilite-historique">
      <div className="fiabilite-historique__entete">
        <h4>Évolution de la précision</h4>
        <span className="selecteur" role="group" aria-label="Série affichée">
          {SERIES.map((s) => (
            <button key={s.cle} type="button" className={`btn-secondaire${serie === s.cle ? " btn-module--actif" : ""}`} aria-pressed={serie === s.cle} onClick={() => onSerie(s.cle)}>
              {s.libelle}
            </button>
          ))}
        </span>
      </div>
      {aucunPoint ? (
        <p className="fiabilite-note">Aucune période notée pour l&apos;instant : il faut une prévision de référence et un réalisé complet.</p>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={donnees} margin={{ top: 12, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid vertical={false} stroke={NEUTRES.bordure} />
            <XAxis dataKey="nom" tick={{ fontSize: 10 }} tickLine={false} />
            <YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v} %`} tick={{ fontSize: 10 }} width={44} />
            <Tooltip formatter={(v: number) => [`${v.toLocaleString("fr-FR")} %`, SERIES.find((s) => s.cle === serie)!.libelle]} />
            <Line
              type="linear"
              dataKey="valeur"
              stroke={TEINTE_SERIE_PRINCIPALE}
              strokeWidth={2}
              connectNulls={false}
              isAnimationActive={false}
              dot={(props: { cx?: number; cy?: number; payload?: { debut: string; valeur: number | null } }) =>
                props.payload?.valeur === null || props.cx === undefined ? (
                  <g key={props.payload?.debut} />
                ) : (
                  <circle
                    key={props.payload!.debut}
                    cx={props.cx}
                    cy={props.cy}
                    r={props.payload!.debut === selection ? 6 : 4}
                    fill={props.payload!.debut === selection ? TEINTE_SERIE_PRINCIPALE : "#fff"}
                    stroke={TEINTE_SERIE_PRINCIPALE}
                    strokeWidth={2}
                    style={{ cursor: "pointer" }}
                    onClick={() => onSelect(props.payload!.debut)}
                  />
                )
              }
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

export default function FiabiliteProjection({ accessToken, actif }: { accessToken: string | null; actif: boolean }) {
  const [type, setType] = useState<TypePeriode>("month");
  const [debut, setDebut] = useState<string | null>(null);
  const [reponse, setReponse] = useState<ReponseFiabilite | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [serie, setSerie] = useState<Serie>("globale");

  const charger = useCallback(async () => {
    if (!accessToken) return;
    setChargement(true);
    setErreur(null);
    try {
      const params = new URLSearchParams({ type, ...(debut ? { debut } : {}) });
      const res = await fetch(`/api/futur/fiabilite?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const data = await res.json();
      if (!res.ok) {
        setErreur(data.error ?? "Comparaison indisponible pour le moment.");
        return;
      }
      setReponse(data as ReponseFiabilite);
    } catch {
      setErreur("Comparaison indisponible pour le moment.");
    } finally {
      setChargement(false);
    }
  }, [accessToken, type, debut]);

  // Chargé à la première ouverture de l'onglet, puis à chaque changement de période.
  useEffect(() => {
    if (actif) void charger();
  }, [actif, charger]);

  const detail = reponse?.detail ?? null;
  // Sélection par défaut : le groupe dont l'écart est le plus fort.
  const selectionEffective = useMemo<Selection | null>(() => {
    if (selection) return selection;
    const groupes = detail?.comparaison?.groupes ?? [];
    return groupes.length > 0 ? [...groupes].sort((a, b) => Math.abs(b.ecart) - Math.abs(a.ecart))[0].cle : null;
  }, [selection, detail]);

  if (!accessToken) return <p className="fiabilite-note">Connectez-vous pour consulter la fiabilité de la projection.</p>;
  if (erreur) return <p className="login-erreur">{erreur}</p>;
  if (!reponse || !detail) return <p className="fiabilite-note">{chargement ? "Chargement…" : ""}</p>;

  const point = reponse.points.find((p) => p.periode.debut === detail.periode.debut)!;
  const c = detail.comparaison;
  const statut = detail.statutRealise;
  const scorePublie = point.publiable;
  // Date de Paris fournie par le serveur : le bandeau disparaît seul au 1er janvier 2027.
  const annonce = annonceDemarrage(reponse.aujourdhui);

  return (
    <div className="fiabilite" aria-busy={chargement}>
      {annonce && <p className="fiabilite-annonce">{annonce}</p>}
      <div className="fiabilite-controles">
        <span className="selecteur" role="group" aria-label="Type de période">
          {(["month", "quarter"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`btn-secondaire${type === t ? " btn-module--actif" : ""}`}
              aria-pressed={type === t}
              onClick={() => {
                setType(t);
                setDebut(null);
                setSelection(null);
              }}
            >
              {t === "month" ? "Mois" : "Trimestre"}
            </button>
          ))}
        </span>
        <label className="fiabilite-controles__periode">
          <span className="etage-pnl-outils__label">Période terminée</span>
          <select
            className="etage-pnl"
            value={detail.periode.debut}
            onChange={(e) => {
              setDebut(e.target.value);
              setSelection(null);
            }}
          >
            {reponse.points.map((p) => (
              <option key={p.periode.debut} value={p.periode.debut}>
                {libellePeriode(p.periode)}
                {p.referenceDisponible ? "" : " — référence indisponible"}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="fiabilite-entete">
        <h3>{libellePeriode(detail.periode)}</h3>
        <p>
          {detail.reference ? (
            <>
              Prévision arrêtée au {dateArrete(detail.periode)}
              <span className="fiabilite-note">
                {" "}
                · calculée le {instantLong(detail.reference.captureeLe)}
                {detail.reference.modeCapture === "after_close_unchanged" ? " (données inchangées depuis la clôture)" : ""}
              </span>
            </>
          ) : (
            <strong>Prévision de référence indisponible</strong>
          )}
        </p>
        <p>
          Réalisé bancaire {intervalleDates(detail.periode.debut, detail.periode.fin)} — TTC
          <span className="fiabilite-note">
            {" "}
            · {statut.synchroniseLe ? `synchronisé le ${instantLong(statut.synchroniseLe)}` : reponse.derniereSynchronisation ? `dernière synchronisation le ${instantLong(reponse.derniereSynchronisation)}` : "aucune synchronisation enregistrée"}
          </span>
        </p>
        {!detail.reference && (
          <p className="fiabilite-note">
            Aucune projection enregistrée à la clôture du {dateArrete(detail.periode)} : pas de score pour cette période. Les références sont
            enregistrées automatiquement chaque veille de période.
          </p>
        )}
        {statut.statut !== "complet" && (
          <p className="fiabilite-alerte">
            {statut.statut === "incomplet" ? "Réalisé incomplet" : "Réalisé non vérifiable"} : {statut.motif} Aucun score n&apos;est publié.
            {statut.statut === "incomplet" ? " Synchronisez les transactions de la période dans Passé." : ""}
          </p>
        )}
        {point.revision !== null && point.revision > 1 && (
          <p className="fiabilite-note">
            Résultat actualisé le {instantLong(detail.revisions[0].calculeLe)} (révision {point.revision}) : le réalisé a changé depuis le calcul
            précédent. La prévision de référence, elle, n&apos;a pas changé.
          </p>
        )}
        {detail.reference && detail.reference.couverture.occurrencesIndisponibles.length > 0 && (
          <p className="fiabilite-alerte">
            {detail.reference.couverture.occurrencesIndisponibles.length} occurrence(s) sans montant calculable à la capture (charge calculée ou
            saisonnalité incomplète) : non comptées dans la prévision.
          </p>
        )}
      </div>

      {c && (
        <>
          <div className="fiabilite-synthese">
            <div className="fiabilite-globale" title={INFOBULLE_GLOBALE}>
              <span className="fiabilite-globale__libelle">Précision globale</span>
              <strong>{scorePublie ? textePrecision(c.globale) : "—"}</strong>
              <span className="fiabilite-note">{INFOBULLE_GLOBALE}</span>
            </div>
            <table className="invoice-table fiabilite-comparaisons">
              <thead>
                <tr>
                  <th></th>
                  <th className="col-montant">Prévu</th>
                  <th className="col-montant">Réalisé</th>
                  <th>Écart</th>
                  <th className="col-montant">Précision</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { cle: "encaissements" as const, nom: "Encaissements", v: c.encaissements, p: c.encaissements.precision },
                  { cle: "decaissements" as const, nom: "Décaissements", v: c.decaissements, p: c.decaissements.precision },
                  { cle: "net" as const, nom: "Cash net", v: c.cashNet, p: null },
                ].map((ligne) => (
                  <tr key={ligne.cle}>
                    <th scope="row">
                      {ligne.cle === "encaissements" ? (
                        <button type="button" className="fiabilite-lien" onClick={() => setSelection("encaissements")}>
                          {ligne.nom}
                        </button>
                      ) : (
                        ligne.nom
                      )}
                    </th>
                    <td className="col-montant">{formatMontant(ligne.v.prevu)}</td>
                    <td className="col-montant">{formatMontant(ligne.v.realise)}</td>
                    <td>{phraseEcart(ligne.v.ecart, formatMontant)}</td>
                    <td className="col-montant">{ligne.p ? (scorePublie ? textePrecision(ligne.p) : "—") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="fiabilite-corps">
            <div className="fiabilite-corps__gauche">
              <h4>Décaissements : de la prévision au réalisé</h4>
              <WaterfallDecaissements detail={detail} selection={selectionEffective} onSelect={setSelection} />
              <table className="invoice-table fiabilite-contributions">
                <thead>
                  <tr>
                    <th>Étage</th>
                    <th className="col-montant">Prévu</th>
                    <th className="col-montant">Réalisé</th>
                    <th>Écart</th>
                  </tr>
                </thead>
                <tbody>
                  {c.groupes.map((g) => (
                    <tr key={g.cle} className={selectionEffective === g.cle ? "fiabilite-contributions--actif" : undefined}>
                      <th scope="row">
                        <button type="button" className="fiabilite-lien" onClick={() => setSelection(g.cle)}>
                          {g.libelle}
                        </button>
                      </th>
                      <td className="col-montant">{formatMontant(g.prevu)}</td>
                      <td className="col-montant">{formatMontant(g.realise)}</td>
                      <td>{phraseEcart(g.ecart, formatMontant)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="fiabilite-corps__droite">
              {selectionEffective ? <DetailSelection detail={detail} selection={selectionEffective} /> : <p className="fiabilite-note">Aucun flux sur la période.</p>}
            </div>
          </div>
        </>
      )}

      <HistoriquePrecision
        points={reponse.points}
        serie={serie}
        onSerie={setSerie}
        selection={detail.periode.debut}
        onSelect={(d) => {
          setDebut(d);
          setSelection(null);
        }}
      />
    </div>
  );
}
