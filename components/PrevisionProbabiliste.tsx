"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import PrevisionProbabilisteChart from "./PrevisionProbabilisteChart";
import SectionRepliable from "./SectionRepliable";
import DateField from "./DateField";
import { formatDate, formatMontant } from "@/lib/format";
import { listerFluxProjetes, ParametresProjectionCash, SourceFlux } from "@/lib/cash-engine";
import {
  cleLigne,
  construireEvenements,
  descendants,
  FIABILITES,
  FiabiliteDate,
  hypotheseParDefaut,
  HypotheseLigne,
  LIBELLES_FIABILITE,
  LIBELLES_PROBABILITE,
  PROBABILITES,
  ProbabiliteSaisie,
} from "@/lib/probaEvenements";
import type { ReponseSimulation, RequeteSimulation, ResumeCalibration } from "@/lib/probaApi";
import type { SoldeJournalier } from "@/lib/types";

interface PrevisionProbabilisteProps {
  accessToken: string | null;
  actif: boolean;
  soldeInitial: number;
  projection: Omit<ParametresProjectionCash, "soldeInitial">;
  serieDeterministe: SoldeJournalier[];
}

const DELAI_CALCUL_MS = 500;
const pourcent = (x: number) => {
  const p = x * 100;
  if (p > 0 && p < 1) return "< 1 %";
  if (p < 100 && p > 99) return "> 99 %";
  return `${Math.round(p)} %`;
};

const LIBELLES_SOURCE: Record<SourceFlux, string> = {
  facture_client: "Facture client",
  facture_fournisseur: "Facture fournisseur",
  financement: "Financement",
  charge_fixe: "Charge fixe",
  autre_depense: "Autre dépense",
  rentree_reguliere: "Rentrée régulière",
};

interface LigneAffichee {
  cle: string;
  source: SourceFlux;
  sourceId: string;
  libelle: string;
  encaissement: boolean;
  total: number;
  premiereDate: string;
  echeances: number;
}

function phraseCalibration(c: ResumeCalibration): string {
  const n = c.nombreFactures;
  const factures = `${n} facture${n > 1 ? "s" : ""} client${n > 1 ? "s" : ""} réglée${n > 1 ? "s" : ""}`;
  if (c.confiance.niveau === "peu_calibre") {
    return n === 0
      ? "Modèle encore peu calibré : aucune facture client réglée n'est encore exploitable. Les retards de paiement suivent pour l'instant des hypothèses prudentes ; ils s'adapteront à vos clients à mesure que vos encaissements seront rapprochés."
      : `Modèle encore peu calibré : ${factures} analysée${n > 1 ? "s" : ""}. Les retards de paiement mêlent encore votre historique et des hypothèses prudentes ; ils s'affineront à mesure que vos encaissements seront rapprochés.`;
  }
  if (c.confiance.niveau === "en_cours") return `Modèle en cours de calibration : retards de paiement appris sur ${factures}.`;
  return `Retards de paiement appris sur ${factures} de votre historique.`;
}

function phraseComportement(c: ResumeCalibration): string | null {
  if (c.nombreFactures === 0 || c.retardMedian === null || c.partALHeure === null || c.partPlus30 === null) return null;
  const median = c.retardMedian <= 0 ? "à l'échéance" : `${Math.round(c.retardMedian)} jour${Math.round(c.retardMedian) > 1 ? "s" : ""} après l'échéance`;
  return `Vos clients paient en général ${median} ; ${pourcent(c.partALHeure)} des factures sont réglées à l'heure, ${pourcent(c.partPlus30)} avec plus de 30 jours de retard.`;
}

export default function PrevisionProbabiliste({ accessToken, actif, soldeInitial, projection, serieDeterministe }: PrevisionProbabilisteProps) {
  const [hypotheses, setHypotheses] = useState<Map<string, HypotheseLigne> | null>(null);
  const [erreurHypotheses, setErreurHypotheses] = useState<string | null>(null);
  const [resultat, setResultat] = useState<ReponseSimulation | null>(null);
  const [calculEnCours, setCalculEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [dateCible, setDateCible] = useState("");
  const requeteEnCours = useRef<AbortController | null>(null);

  // Hypothèses : lues une fois, à la première ouverture de l'onglet.
  useEffect(() => {
    if (!actif || hypotheses !== null || !accessToken) return;
    let annule = false;
    fetch("/api/futur/probabiliste/hypotheses", { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" })
      .then(async (r) => {
        const corps = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(corps.error ?? "Hypothèses illisibles.");
        return corps.hypotheses as HypotheseLigne[];
      })
      .then((liste) => {
        if (!annule) setHypotheses(new Map(liste.map((h) => [cleLigne(h.source, h.sourceId), h])));
      })
      .catch((e: Error) => {
        if (annule) return;
        setErreurHypotheses(e.message);
        setHypotheses(new Map());
      });
    return () => {
      annule = true;
    };
  }, [actif, hypotheses, accessToken]);

  const flux = useMemo(() => listerFluxProjetes(projection), [projection]);
  const construit = useMemo(
    () => (hypotheses === null ? null : construireEvenements(flux, projection, Array.from(hypotheses.values()))),
    [flux, projection, hypotheses]
  );

  const lignesAffichees = useMemo<LigneAffichee[]>(() => {
    const parCle = new Map<string, LigneAffichee>();
    for (const f of flux) {
      if (f.montant === 0) continue;
      const cle = cleLigne(f.source, f.sourceId);
      const ligne = parCle.get(cle);
      if (ligne) {
        ligne.total += f.montant;
        ligne.echeances++;
        if (f.date < ligne.premiereDate) ligne.premiereDate = f.date;
      } else {
        parCle.set(cle, { cle, source: f.source, sourceId: f.sourceId, libelle: f.libelle, encaissement: f.montant > 0, total: f.montant, premiereDate: f.date, echeances: 1 });
      }
    }
    return Array.from(parCle.values()).sort((a, b) => a.premiereDate.localeCompare(b.premiereDate) || a.libelle.localeCompare(b.libelle));
  }, [flux]);

  // Calcul serveur, relancé (avec un léger délai) à chaque changement de données ou d'hypothèse.
  useEffect(() => {
    if (!actif || !accessToken || construit === null) return;
    const minuteur = setTimeout(() => {
      requeteEnCours.current?.abort();
      const controleur = new AbortController();
      requeteEnCours.current = controleur;
      const requete: RequeteSimulation = {
        soldeInitial,
        dateDepart: projection.dateDepart,
        horizonJours: projection.horizonJours ?? 90,
        lignes: construit.lignes,
        evenements: construit.evenements,
      };
      setCalculEnCours(true);
      fetch("/api/futur/probabiliste", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(requete),
        signal: controleur.signal,
      })
        .then(async (r) => {
          const corps = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(corps.error ?? "La prévision n'a pas pu être calculée.");
          return corps as ReponseSimulation;
        })
        .then((reponse) => {
          setResultat(reponse);
          setErreur(null);
        })
        .catch((e: Error) => {
          if (e.name !== "AbortError") setErreur(e.message);
        })
        .finally(() => {
          if (requeteEnCours.current === controleur) setCalculEnCours(false);
        });
    }, DELAI_CALCUL_MS);
    return () => clearTimeout(minuteur);
  }, [actif, accessToken, construit, soldeInitial, projection.dateDepart, projection.horizonJours]);

  const modifierHypothese = (ligne: LigneAffichee, changement: Partial<Pick<HypotheseLigne, "probabilite" | "fiabiliteDate" | "parentSource" | "parentSourceId">>) => {
    if (!hypotheses) return;
    const actuelle = hypotheses.get(ligne.cle) ?? { source: ligne.source, sourceId: ligne.sourceId, ...hypotheseParDefaut(ligne.source), parentSource: null, parentSourceId: null };
    const nouvelle: HypotheseLigne = { ...actuelle, ...changement };
    const suivantes = new Map(hypotheses);
    suivantes.set(ligne.cle, nouvelle);
    setHypotheses(suivantes);
    if (!accessToken) return;
    fetch("/api/futur/probabiliste/hypotheses", {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(nouvelle),
    })
      .then(async (r) => {
        if (r.ok) return setErreurHypotheses(null);
        const corps = await r.json().catch(() => ({}));
        setErreurHypotheses(corps.error ?? "L'hypothèse n'a pas pu être enregistrée.");
      })
      .catch(() => setErreurHypotheses("L'hypothèse n'a pas pu être enregistrée."));
  };

  const indicateurs = resultat?.indicateurs ?? null;
  const serie = indicateurs?.serie ?? [];
  const dernierJour = serie.length > 0 ? serie[serie.length - 1].date : null;
  const pointCible = serie.find((p) => p.date === dateCible) ?? (dernierJour ? serie[serie.length - 1] : null);
  const libelles = useMemo(() => new Map(lignesAffichees.map((l) => [l.cle, l.libelle])), [lignesAffichees]);
  const lignesPourDependance = useMemo(() => (construit ? construit.lignes : []), [construit]);

  if (!indicateurs && !erreur) {
    return <p className="proba-attente">{actif ? "Calcul de la prévision en cours…" : null}</p>;
  }

  const tension = indicateurs?.periodesTension[0] ?? null;

  return (
    <section className="proba" aria-label="Risque de trésorerie">
      {erreur && <p className="fiabilite-alerte">{erreur}</p>}
      {indicateurs && resultat && (
        <>
          <div className="pilotage__vue-ensemble">
            <div className="pilotage__headline">
              <p className="pilotage__headline-label">Risque de passer sous 0 €</p>
              <p className={`pilotage__headline-valeur${indicateurs.probaNegatifHorizon >= 0.1 ? " pilotage__headline-valeur--danger" : ""}`}>
                {pourcent(indicateurs.probaNegatifHorizon)}
              </p>
              <p className="pilotage__stat-sous-valeur">avant le {formatDate(dernierJour!)}</p>
            </div>
            <div className="pilotage__stats">
              <div>
                <p className="pilotage__stat-label">Point bas probable</p>
                <p className={`pilotage__stat-valeur${indicateurs.minimum.p50 < 0 ? " pilotage__stat-valeur--danger" : ""}`}>{formatMontant(indicateurs.minimum.p50)}</p>
                <p className="pilotage__stat-sous-valeur">
                  8 cas sur 10 entre {formatMontant(indicateurs.minimum.p10)} et {formatMontant(indicateurs.minimum.p90)}
                </p>
              </div>
              <div>
                <p className="pilotage__stat-label">Période de tension</p>
                {tension ? (
                  <>
                    <p className="pilotage__stat-valeur pilotage__stat-valeur--compact">
                      {tension.debut === tension.fin ? `Le ${formatDate(tension.debut)}` : `Du ${formatDate(tension.debut)} au ${formatDate(tension.fin)}`}
                    </p>
                    <p className="pilotage__stat-sous-valeur">
                      jusqu&apos;à {pourcent(tension.probaMax)} de risque d&apos;être sous 0 € le {formatDate(tension.dateProbaMax)}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="pilotage__stat-valeur pilotage__stat-valeur--compact">Aucune période de tension</p>
                    <p className="pilotage__stat-sous-valeur">
                      trésorerie la plus basse attendue vers le {formatDate(indicateurs.dateMinimumP50)}
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>

          <hr className="pilotage__separateur" />

          <div className="pilotage__chart">
            <PrevisionProbabilisteChart serie={serie} deterministe={serieDeterministe} />
            <p className="fiabilite-note">
              La bande grise montre, jour par jour, la fourchette où se trouve votre trésorerie dans 8 cas sur 10. Ses bords ne forment pas un scénario : chaque jour se lit
              séparément. Calcul sur {resultat.parametres.nombreSimulations.toLocaleString("fr-FR")} scénarios
              {calculEnCours ? " — mise à jour…" : "."}
            </p>
          </div>

          <div className="proba-financement">
            <h4>Besoin de financement</h4>
            <div className="fiabilite-controles">
              <label htmlFor="proba-date-cible">Pour rester au-dessus de 0 € jusqu&apos;au</label>
              <DateField id="proba-date-cible" value={pointCible?.date ?? ""} onChange={setDateCible} effacable={false} />
            </div>
            {pointCible && (
              <>
                {dateCible && !serie.some((p) => p.date === dateCible) && <p className="fiabilite-note">Date hors de l&apos;horizon : fin d&apos;horizon retenue.</p>}
                <p className="proba-financement__risque">
                  Sans financement, risque de passer sous 0 € d&apos;ici le {formatDate(pointCible.date)} : <strong>{pourcent(pointCible.probaNegatifAvant)}</strong>
                </p>
                <table className="invoice-table proba-financement__table">
                  <thead>
                    <tr>
                      <th>Certitude de rester au-dessus de 0 €</th>
                      <th>Trésorerie supplémentaire à prévoir</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ["90 %", pointCible.besoin90],
                        ["95 %", pointCible.besoin95],
                        ["99 %", pointCible.besoin99],
                      ] as const
                    ).map(([niveau, besoin]) => (
                      <tr key={niveau}>
                        <td>{niveau}</td>
                        <td>{besoin > 0 ? formatMontant(besoin) : "Aucune"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>

          <div className="proba-calibration">
            <p>{phraseCalibration(resultat.calibration.client)}</p>
            {phraseComportement(resultat.calibration.client) && <p>{phraseComportement(resultat.calibration.client)}</p>}
          </div>

          {resultat.dependancesIgnorees.map((d) => (
            <p key={d.cle} className="fiabilite-alerte">
              « {libelles.get(d.cle) ?? d.cle} » est traité comme indépendant :{" "}
              {d.raison === "cycle" ? "ses dépendances forment une boucle." : "la ligne dont il dépend n'a pas d'échéance dans l'horizon."}
            </p>
          ))}
        </>
      )}

      <SectionRepliable titre="Hypothèses par ligne" ouvertParDefaut>
        <p className="fiabilite-note">
          Probabilité : la ligne a-t-elle des chances de se réaliser ? Fiabilité de la date : faut-il s&apos;attendre à un décalage, selon les habitudes de paiement observées
          chez vous ? Une ligne qui dépend d&apos;une autre ne se réalise que si l&apos;autre se réalise.
        </p>
        {erreurHypotheses && <p className="fiabilite-alerte">{erreurHypotheses}</p>}
        <div className="proba-hypotheses">
          <table className="invoice-table proba-hypotheses__table">
            <thead>
              <tr>
                <th>Ligne</th>
                <th>Montant</th>
                <th>Date prévue</th>
                <th>Probabilité</th>
                <th>Fiabilité de la date</th>
                <th>Dépend de</th>
              </tr>
            </thead>
            <tbody>
              {lignesAffichees.map((ligne) => {
                const h = hypotheses?.get(ligne.cle);
                const defaut = hypotheseParDefaut(ligne.source);
                const probabilite = h?.probabilite ?? defaut.probabilite;
                const fiabilite = h?.fiabiliteDate ?? defaut.fiabiliteDate;
                const parent = h?.parentSource && h.parentSourceId ? cleLigne(h.parentSource, h.parentSourceId) : "";
                const exclus = descendants(lignesPourDependance, ligne.cle);
                return (
                  <tr key={ligne.cle}>
                    <td className="fiabilite-table__libelle">
                      {ligne.libelle}
                      <span className="proba-hypotheses__source">{LIBELLES_SOURCE[ligne.source]}</span>
                    </td>
                    <td className={ligne.encaissement ? "proba-montant--entree" : undefined}>{formatMontant(ligne.total)}</td>
                    <td>
                      {formatDate(ligne.premiereDate)}
                      {ligne.echeances > 1 && <span className="proba-hypotheses__source">{ligne.echeances} échéances</span>}
                    </td>
                    <td>
                      <select
                        aria-label={`Probabilité — ${ligne.libelle}`}
                        value={probabilite}
                        disabled={hypotheses === null}
                        onChange={(e) => modifierHypothese(ligne, { probabilite: Number(e.target.value) as ProbabiliteSaisie })}
                      >
                        {PROBABILITES.map((p) => (
                          <option key={p} value={p}>
                            {LIBELLES_PROBABILITE[p]} ({p} %)
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        aria-label={`Fiabilité de la date — ${ligne.libelle}`}
                        value={fiabilite}
                        disabled={hypotheses === null}
                        onChange={(e) => modifierHypothese(ligne, { fiabiliteDate: Number(e.target.value) as FiabiliteDate })}
                      >
                        {FIABILITES.map((f) => (
                          <option key={f} value={f}>
                            {LIBELLES_FIABILITE[f]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        aria-label={`Dépend de — ${ligne.libelle}`}
                        value={parent}
                        disabled={hypotheses === null}
                        onChange={(e) => {
                          const cible = lignesAffichees.find((l) => l.cle === e.target.value);
                          modifierHypothese(ligne, { parentSource: cible?.source ?? null, parentSourceId: cible?.sourceId ?? null });
                        }}
                      >
                        <option value="">Aucune ligne</option>
                        {lignesAffichees
                          .filter((l) => l.cle !== ligne.cle && !exclus.has(l.cle))
                          .map((l) => (
                            <option key={l.cle} value={l.cle}>
                              {l.libelle}
                            </option>
                          ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionRepliable>
    </section>
  );
}
