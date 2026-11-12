"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PrevisionProbabilisteChart from "./PrevisionProbabilisteChart";
import HypothesesProbabilistes from "./HypothesesProbabilistes";
import DateField from "./DateField";
import { formatDate, formatMontant } from "@/lib/format";
import { listerFluxProjetes, ParametresProjectionCash, SourceFlux } from "@/lib/cash-engine";
import { classerDepense, CorrespondanceFutur, groupeDeClassement } from "@/lib/futurPnl";
import type { EtagePnl } from "@/lib/pastCategoryMapping";
import { cleLigne, construireEvenements, descendants, DIMENSIONS, HypotheseLigne, parentDeCondition, conditionVersMoteur } from "@/lib/probaEvenements";
import { CleGroupeHypotheses, completude, construireLignesHypotheses, HypotheseEffective, LigneHypothese, messageCompletude } from "@/lib/probaEcran";
import type { ReponseSimulation, RequeteSimulation, ResumeCalibration } from "@/lib/probaApi";
import type { SoldeJournalier } from "@/lib/types";

interface PrevisionProbabilisteProps {
  accessToken: string | null;
  actif: boolean;
  soldeInitial: number;
  projection: Omit<ParametresProjectionCash, "soldeInitial">;
  correspondance: CorrespondanceFutur;
  serieDeterministe: SoldeJournalier[];
}

const DELAI_CALCUL_MS = 500;
const pourcent = (x: number) => {
  const p = x * 100;
  if (p > 0 && p < 1) return "< 1 %";
  if (p < 100 && p > 99) return "> 99 %";
  return `${Math.round(p)} %`;
};

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
  const jours = Math.round(c.retardMedian);
  const median = jours <= 0 ? "à l'échéance" : `${jours} jour${jours > 1 ? "s" : ""} après l'échéance`;
  return `Vos clients paient en général ${median} ; ${pourcent(c.partALHeure)} des factures sont réglées à l'heure, ${pourcent(c.partPlus30)} avec plus de 30 jours de retard.`;
}

export default function PrevisionProbabiliste({ accessToken, actif, soldeInitial, projection, correspondance, serieDeterministe }: PrevisionProbabilisteProps) {
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

  // Classement P&L existant de Futur : encaissements, groupes d'étage des dépenses, « À classer ».
  const classement = useMemo(() => {
    const depenses = new Map<string, { etagePnlManuel?: unknown; categoriesPennylane?: unknown }>();
    for (const f of projection.facturesFournisseurs) depenses.set(cleLigne("facture_fournisseur", f.id), f);
    for (const c of projection.chargesFixes) depenses.set(cleLigne("charge_fixe", c.id), c);
    for (const d of projection.autresDepenses) depenses.set(cleLigne("autre_depense", d.id), d);
    const classer = (source: SourceFlux, sourceId: string) => {
      const depense = depenses.get(cleLigne(source, sourceId));
      return depense ? classerDepense(depense as Parameters<typeof classerDepense>[0], correspondance) : null;
    };
    return {
      groupeDe: (source: SourceFlux, sourceId: string): CleGroupeHypotheses => {
        if (source === "facture_client" || source === "rentree_reguliere") return "revenue";
        if (source === "financement") return "financing";
        const c = classer(source, sourceId);
        return (c && groupeDeClassement(c)) ?? "a_classer";
      },
      etageDe: (source: SourceFlux, sourceId: string): EtagePnl | null => {
        if (source === "facture_client" || source === "rentree_reguliere") return "revenue";
        if (source === "financement") return "financing";
        return classer(source, sourceId)?.etage ?? null;
      },
    };
  }, [projection, correspondance]);

  const flux = useMemo(() => listerFluxProjetes(projection), [projection]);
  const lignes = useMemo(() => (hypotheses === null ? [] : construireLignesHypotheses(flux, hypotheses, classement.groupeDe)), [flux, hypotheses, classement]);
  const etat = useMemo(() => completude(lignes), [lignes]);
  const construit = useMemo(
    () => (hypotheses === null ? null : construireEvenements(flux, projection, Array.from(hypotheses.values()), classement.etageDe)),
    [flux, projection, hypotheses, classement]
  );
  const montantsFixes = useMemo(
    () => new Map(projection.rentreesRegulieres.filter((r) => r.modeMontant === "fixe").map((r) => [cleLigne("rentree_reguliere", r.id), r.montant])),
    [projection.rentreesRegulieres]
  );
  const liens = useMemo(
    () => lignes.map((l) => ({ cle: l.cle, parentCle: parentDeCondition(conditionVersMoteur(l.hypothese.condition)) })),
    [lignes]
  );
  const descendantsDe = useCallback((cle: string) => descendants(liens, cle), [liens]);

  // Calcul serveur, relancé (avec un léger délai) à chaque changement — jamais quand une hypothèse
  // importante reste à renseigner (le serveur le refuserait aussi).
  useEffect(() => {
    if (!actif || !accessToken || construit === null || etat.bloquee) return;
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
  }, [actif, accessToken, construit, etat.bloquee, soldeInitial, projection.dateDepart, projection.horizonJours]);

  // Enregistre une hypothèse validée par l'utilisateur. L'état partagé (filtres, statut « À
  // renseigner », calcul) n'est mis à jour qu'APRÈS la réponse du serveur : un échec ne fait jamais
  // croire que la modification est enregistrée.
  const enregistrerHypothese = async (ligne: LigneHypothese, h: HypotheseEffective): Promise<void> => {
    const nouvelle: HypotheseLigne = {
      source: ligne.source,
      sourceId: ligne.sourceId,
      probabilite: h.probabilite,
      fiabiliteDate: h.fiabiliteDate,
      fiabiliteMontant: DIMENSIONS[ligne.source].montant ? h.fiabiliteMontant : null,
      montantCible: ligne.source === "rentree_reguliere" ? h.montantCible : null,
      condition: h.condition,
    };
    if (!accessToken) throw new Error("Session expirée : reconnectez-vous.");
    let reponse: Response;
    try {
      reponse = await fetch("/api/futur/probabiliste/hypotheses", {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(nouvelle),
      });
    } catch {
      throw new Error("L'hypothèse n'a pas pu être enregistrée. Vérifiez votre connexion.");
    }
    if (!reponse.ok) {
      const corps = await reponse.json().catch(() => ({}));
      throw new Error(corps.error ?? "L'hypothèse n'a pas pu être enregistrée.");
    }
    setHypotheses((actuelles) => {
      const suivantes = new Map(actuelles ?? []);
      suivantes.set(ligne.cle, nouvelle);
      return suivantes;
    });
  };

  if (hypotheses === null) return <p className="proba-attente">{actif ? "Chargement des hypothèses…" : null}</p>;

  const indicateurs = !etat.bloquee ? resultat?.indicateurs ?? null : null;
  const serie = indicateurs?.serie ?? [];
  const dernierJour = serie.length > 0 ? serie[serie.length - 1].date : null;
  const pointCible = serie.find((p) => p.date === dateCible) ?? (dernierJour ? serie[serie.length - 1] : null);
  const libelles = new Map(lignes.map((l) => [l.cle, l.libelle]));
  const tension = indicateurs?.periodesTension[0] ?? null;
  const message = messageCompletude(etat);

  return (
    <section className="proba" aria-label="Risque de trésorerie">
      {message && <p className={etat.bloquee ? "proba-bloquee" : "fiabilite-alerte"}>{message}</p>}
      {erreur && !etat.bloquee && <p className="fiabilite-alerte">{erreur}</p>}
      {!etat.bloquee && !indicateurs && !erreur && lignes.length > 0 && <p className="proba-attente">Calcul de la prévision en cours…</p>}

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
                    <p className="pilotage__stat-sous-valeur">trésorerie la plus basse attendue vers le {formatDate(indicateurs.dateMinimumP50)}</p>
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
        </>
      )}

      <div className="proba-section">
        <h4>Hypothèses de la prévision</h4>
        {erreurHypotheses && <p className="fiabilite-alerte">{erreurHypotheses}</p>}
        {resultat?.dependancesIgnorees.map((d) => (
          <p key={d.cle} className="fiabilite-alerte">
            « {libelles.get(d.cle) ?? d.cle} » est traité sans condition :{" "}
            {d.raison === "cycle" ? "ses conditions forment une boucle." : "la ligne dont il dépend n'a pas d'échéance dans l'horizon."}
          </p>
        ))}
        <HypothesesProbabilistes lignes={lignes} completude={etat} montantsFixes={montantsFixes} descendantsDe={descendantsDe} onEnregistrer={enregistrerHypothese} />
      </div>

      {indicateurs && resultat && (
        <>
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
        </>
      )}
    </section>
  );
}
