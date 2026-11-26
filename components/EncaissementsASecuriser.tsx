"use client";

import { useEffect, useRef, useState } from "react";
import ScenarioSemaineChart, { TrajectoireSemaine } from "./ScenarioSemaineChart";
import DateField from "./DateField";
import { formatDate, formatMontant } from "@/lib/format";
import { decalerDateISO, estDateValide } from "@/lib/dates";
import type { FactureAnalysee } from "@/lib/probaRisques";
import type { SemaineRisque } from "@/lib/probaIndicateurs";
import type { FactureASecuriser } from "@/lib/probaSemaine";
import type { ReponseSemaine, ReponseTestDecalage, RequeteRisques } from "@/lib/probaApi";
import {
  LIBELLES_AUTRE_FACTEUR,
  lignesRepartition,
  nomFactureSemaine,
  PHRASE_DEFINITION_RISQUE,
  phraseContribution,
  phraseDates,
  phrasePortee,
  phraseResultatTest,
  phraseRisqueSemaine,
  phrasesScenario,
  phraseVulnerabilite,
  pourcentSemaine,
  titreSemaine,
} from "@/lib/probaSemaineEcran";

export const FACTURES_AFFICHEES = 5;

export interface EtatSemaine {
  resultat: ReponseSemaine | null;
  enCours: boolean;
  erreur: string | null;
}

export type Testeur = (simulation: number, cleLigne: string, date: string) => Promise<ReponseTestDecalage>;

// ---------------------------------------------------------------------------------------------
// Vue (sans requête : testée seule)
// ---------------------------------------------------------------------------------------------

function TestDecalage({ facture, dates, testeur, onResultat }: { facture: FactureASecuriser; dates: string[]; testeur: Testeur; onResultat: (r: { date: string; soldes: number[] } | null) => void }) {
  const sc = facture.scenario!;
  const [date, setDate] = useState<string>("");
  const [etat, setEtat] = useState<{ enCours: boolean; erreur: string | null; resultat: (ReponseTestDecalage & { date: string }) | null }>({ enCours: false, erreur: null, resultat: null });
  const fin = dates[dates.length - 1];
  const choix = [
    { libelle: "À la date de référence", date: facture.dateReference },
    { libelle: "+7 jours", date: decalerDateISO(facture.dateReference, 7) },
    { libelle: "+14 jours", date: decalerDateISO(facture.dateReference, 14) },
  ].filter((c) => c.date <= fin);

  const lancer = (d: string) => {
    if (!estDateValide(d)) return;
    setDate(d);
    setEtat({ enCours: true, erreur: null, resultat: null });
    testeur(sc.simulation, facture.cleLigne, d)
      .then((r) => {
        setEtat({ enCours: false, erreur: null, resultat: { ...r, date: d } });
        onResultat({ date: d, soldes: r.soldes });
      })
      .catch((e: Error) => setEtat({ enCours: false, erreur: e.message, resultat: null }));
  };

  return (
    <div className="proba-semaine__test">
      <p className="proba-editeur__aide">
        Même scénario (n° {(sc.simulation + 1).toLocaleString("fr-FR")}), tout le reste identique ; seule la date d&apos;encaissement de cette facture change. Rien n&apos;est enregistré.
      </p>
      <div className="proba-risque__actions">
        {choix.map((c) => (
          <button key={c.libelle} type="button" className="btn-secondaire" aria-pressed={date === c.date} onClick={() => lancer(c.date)}>
            {c.libelle} ({formatDate(c.date)})
          </button>
        ))}
        <span className="proba-semaine__date-libre">
          <DateField value={date} onChange={(v) => lancer(v)} effacable={false} />
        </span>
      </div>
      {etat.enCours && <p className="proba-attente">Calcul du décalage…</p>}
      {etat.erreur && <p className="login-erreur">{etat.erreur}</p>}
      {etat.resultat && <p className="proba-risque__tension">{phraseResultatTest(etat.resultat, etat.resultat.date)}</p>}
    </div>
  );
}

function CarteFacture({
  facture,
  resultat,
  testeur,
  onVoirFacture,
}: {
  facture: FactureASecuriser;
  resultat: ReponseSemaine;
  testeur: Testeur;
  onVoirFacture: (terme: string) => void;
}) {
  const [ouvert, setOuvert] = useState<"scenario" | "test" | null>(null);
  const [teste, setTeste] = useState<{ date: string; soldes: number[] } | null>(null);
  const sc = facture.scenario;
  const basculer = (v: "scenario" | "test") => setOuvert(ouvert === v ? null : v);
  const trajectoires: TrajectoireSemaine[] = sc
    ? [
        { libelle: "Projection de référence", soldes: sc.trajectoires.reference, role: "reference" },
        { libelle: "Facture encaissée à sa date de référence", soldes: sc.trajectoires.corrigee, role: "corrigee" },
        ...(teste ? [{ libelle: `Encaissée le ${formatDate(teste.date)}`, soldes: teste.soldes, role: "testee" as const }] : []),
        { libelle: "Scénario simulé", soldes: sc.trajectoires.simulee, role: "simulee" },
      ]
    : [];
  const reperes = sc
    ? [
        { date: facture.dateReference, libelle: "Référence" },
        ...(sc.dateSimulee ? [{ date: sc.dateSimulee, libelle: "Simulée" }] : []),
        ...(teste ? [{ date: teste.date, libelle: "Testée" }] : []),
      ]
    : [];

  return (
    <article className="proba-risque" aria-label={nomFactureSemaine(facture)}>
      <p className="proba-risque__titre">{nomFactureSemaine(facture)}</p>
      <p className="proba-ligne__detail">{phraseDates(facture)}</p>
      {facture.dateReferenceEstimee && <p className="proba-editeur__aide">Facture en retard : date de référence estimée par l&apos;historique de paiement.</p>}
      <p className="proba-risque__declencheur">{phraseContribution(facture, resultat.analysees)}</p>
      {sc && (
        <div className="proba-semaine__scenario">
          {phrasesScenario(sc, facture).map((p, i) => (
            <p key={i} className={i === 0 ? "proba-risque__tension" : "proba-risque__declencheur"}>
              {p}
            </p>
          ))}
        </div>
      )}
      <div className="proba-risque__actions">
        <button type="button" className="btn-secondaire" onClick={() => onVoirFacture(facture.numero ?? facture.client)}>
          Voir la facture
        </button>
        {sc && (
          <button type="button" className="btn-secondaire" aria-expanded={ouvert === "scenario"} onClick={() => basculer("scenario")}>
            Voir le scénario
          </button>
        )}
        {sc && (
          <button type="button" className="btn-secondaire" aria-expanded={ouvert === "test"} onClick={() => basculer("test")}>
            Tester un décalage
          </button>
        )}
      </div>
      {ouvert === "test" && sc && <TestDecalage facture={facture} dates={resultat.dates} testeur={testeur} onResultat={setTeste} />}
      {(ouvert === "scenario" || (ouvert === "test" && teste)) && sc && (
        <div className="proba-risque__impact">
          <ScenarioSemaineChart dates={resultat.dates} trajectoires={trajectoires} semaine={resultat.semaine} reperes={reperes} />
          <p className="proba-editeur__aide">
            Trajectoires d&apos;un scénario réellement simulé, rejoué à l&apos;identique : ce n&apos;est ni la médiane ni la bande grise. La zone ombrée est la semaine analysée.
          </p>
        </div>
      )}
    </article>
  );
}

export function EncaissementsASecuriserVue({
  semaine,
  risque,
  nombreSimulations,
  etat,
  testeur,
  onVoirFacture,
  onSemainePrecedente,
  onSemaineSuivante,
  onFermer,
}: {
  semaine: { debut: string; fin: string };
  risque: SemaineRisque | null; // indicateurs de la prévision affichée : immédiat
  nombreSimulations: number;
  etat: EtatSemaine;
  testeur: Testeur;
  onVoirFacture: (terme: string) => void;
  onSemainePrecedente: (() => void) | null;
  onSemaineSuivante: (() => void) | null;
  onFermer: () => void;
}) {
  const [toutes, setToutes] = useState(false);
  const r = etat.resultat && etat.resultat.semaine.debut === semaine.debut ? etat.resultat : null;
  const negatives = r?.simulationsNegatives ?? risque?.simulationsNegatives ?? null;
  const total = r?.nombreSimulations ?? nombreSimulations;
  const proba = r?.probaNegatifSemaine ?? risque?.probaNegatif ?? null;
  const nomDe = new Map((r?.factures ?? []).map((f) => [f.cleLigne, nomFactureSemaine(f)]));
  const factures = r ? (toutes ? r.factures : r.factures.slice(0, FACTURES_AFFICHEES)) : [];
  const portee = r ? phrasePortee(r) : null;
  const repartition = r ? lignesRepartition(r) : [];

  return (
    <section className="proba-section proba-semaine" aria-label="Encaissements à sécuriser">
      <div className="proba-semaine__entete">
        <h4>Encaissements à sécuriser</h4>
        <div className="proba-risque__actions">
          <button type="button" className="btn-secondaire" disabled={!onSemainePrecedente} onClick={() => onSemainePrecedente?.()}>
            ‹ Semaine précédente
          </button>
          <button type="button" className="btn-secondaire" disabled={!onSemaineSuivante} onClick={() => onSemaineSuivante?.()}>
            Semaine suivante ›
          </button>
          <button type="button" className="etage-pnl-outils__lien" onClick={onFermer}>
            Fermer
          </button>
        </div>
      </div>
      <p className="proba-risques__sous-titre">{titreSemaine(semaine)}</p>

      <div className="pilotage__stats proba-semaine__chiffres">
        <div>
          <p className="pilotage__stat-label">Risque de passer sous 0 € dans la semaine</p>
          <p className={`pilotage__stat-valeur${proba !== null && proba >= 0.1 ? " pilotage__stat-valeur--danger" : ""}`}>{proba === null ? "—" : pourcentSemaine(proba)}</p>
          <p className="pilotage__stat-sous-valeur">{negatives === null ? "" : phraseRisqueSemaine(negatives, total)}</p>
        </div>
        <div>
          <p className="pilotage__stat-label">Scénarios négatifs analysés</p>
          <p className="pilotage__stat-valeur pilotage__stat-valeur--compact">{r ? r.analysees.toLocaleString("fr-FR") : "—"}</p>
          <p className="pilotage__stat-sous-valeur">{r && r.dejaNegativesALOuverture > 0 ? `dont ${r.dejaNegativesALOuverture.toLocaleString("fr-FR")} déjà sous zéro au lundi` : ""}</p>
        </div>
        <div>
          <p className="pilotage__stat-label">Factures concernées</p>
          <p className="pilotage__stat-valeur pilotage__stat-valeur--compact">{r ? r.factures.length.toLocaleString("fr-FR") : "—"}</p>
          <p className="pilotage__stat-sous-valeur">{r ? `dont l'encaissement à temps change le déficit, sur ${r.couverture.facturesCandidates} à encaisser` : ""}</p>
        </div>
      </div>
      <p className="proba-editeur__aide">{PHRASE_DEFINITION_RISQUE}</p>

      {etat.erreur && <p className="login-erreur">{etat.erreur} Aucun résultat : cela ne signifie pas une absence de risque.</p>}
      {!r && etat.enCours && <p className="proba-attente">Analyse des scénarios de la semaine en cours…</p>}

      {r && (
        <div className={`proba-risques__liste${etat.enCours ? " proba-risques__liste--perime" : ""}`}>
          {portee && <p className={r.couverture.arret ? "fiabilite-alerte" : "proba-editeur__aide"}>{portee}</p>}
          {repartition.length > 0 && (
            <ul className="proba-semaine__repartition" aria-label="Ce qui explique le passage sous zéro">
              {repartition.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}

          {r.factures.length > 0 && <p className="proba-risque__titre">Factures dont l&apos;encaissement à temps réduit le risque</p>}
          {factures.map((f) => (
            <CarteFacture key={f.cleLigne} facture={f} resultat={r} testeur={testeur} onVoirFacture={onVoirFacture} />
          ))}
          {r.factures.length > FACTURES_AFFICHEES && (
            <button type="button" className="btn-secondaire" onClick={() => setToutes(!toutes)}>
              {toutes ? "Voir moins de factures" : `Voir toutes les factures (${r.factures.length})`}
            </button>
          )}

          {r.duos.length > 0 && (
            <article className="proba-risque" aria-label="Factures dont les retards se combinent">
              <p className="proba-risque__titre">Factures dont les retards se combinent</p>
              <ul className="proba-semaine__liste">
                {r.duos.map((d) => (
                  <li key={d.factures.join("|") + d.nature}>
                    {nomDe.get(d.factures[0]) ?? d.factures[0]} et {nomDe.get(d.factures[1]) ?? d.factures[1]} :{" "}
                    {d.nature === "une_suffit" ? "en retard en même temps ; encaisser l'une des deux suffit" : "il faut encaisser les deux à temps"} (
                    {d.simulations.toLocaleString("fr-FR")} scénario{d.simulations > 1 ? "s" : ""}).
                  </li>
                ))}
              </ul>
            </article>
          )}

          {r.repartition.plusieurs > 0 && (
            <article className="proba-risque" aria-label="Plusieurs encaissements">
              <p className="proba-risque__titre">Plusieurs encaissements ou facteurs combinés</p>
              <p className="proba-risque__declencheur">
                Dans {r.repartition.plusieurs.toLocaleString("fr-FR")} scénario{r.repartition.plusieurs > 1 ? "s" : ""}, aucune facture ni aucune paire ne suffit : c&apos;est
                l&apos;accumulation de plusieurs retards qui crée le déficit. Corriger toutes les factures en retard l&apos;évite.
              </p>
            </article>
          )}

          {(r.autresFacteurs.length > 0 || r.couverture.simulationsNonExpliquees > 0) && (
            <article className="proba-risque proba-risque--aggravation" aria-label="Autres facteurs de tension">
              <p className="proba-risque__titre">Autres facteurs de tension</p>
              {r.autresFacteurs.length > 0 && (
                <ul className="proba-semaine__liste">
                  {r.autresFacteurs.map((a) => (
                    <li key={`${a.cleLigne}|${a.nature}`}>
                      {a.libelle} — {LIBELLES_AUTRE_FACTEUR[a.nature]} :{" "}
                      {[
                        a.evite > 0 ? `le rétablir évite le déficit dans ${a.evite.toLocaleString("fr-FR")} scénario${a.evite > 1 ? "s" : ""}` : null,
                        a.reduit > 0 ? `le réduit dans ${a.reduit.toLocaleString("fr-FR")}` : null,
                      ]
                        .filter(Boolean)
                        .join(", ")}{" "}
                      (constaté dans {a.constate.toLocaleString("fr-FR")}).
                    </li>
                  ))}
                </ul>
              )}
              {r.couverture.simulationsNonExpliquees > 0 && (
                <p className="proba-editeur__aide">
                  Dans {r.couverture.simulationsNonExpliquees.toLocaleString("fr-FR")} scénario{r.couverture.simulationsNonExpliquees > 1 ? "s" : ""}, aucun facteur rétabli seul
                  ne suffit : le déficit vient de leur combinaison.
                </p>
              )}
            </article>
          )}

          {r.vulnerabilites.length > 0 && (
            <article className="proba-risque proba-risque--aggravation" aria-label="Paiements certains à surveiller">
              <p className="proba-risque__titre">Paiements certains à surveiller</p>
              <p className="proba-editeur__aide">Ces factures sont saisies à date ferme : aucun scénario ne les retarde. Ce test est hypothétique.</p>
              <ul className="proba-semaine__liste">
                {r.vulnerabilites.map((v) => (
                  <li key={v.cleLigne}>
                    <strong>{nomFactureSemaine(v)}</strong> ({formatMontant(v.montantRestant)}, prévue le {formatDate(v.dateReference)}). {phraseVulnerabilite(v)}
                  </li>
                ))}
              </ul>
            </article>
          )}

          {r.simulationsNegatives === 0 && r.vulnerabilites.length === 0 && <p className="proba-vide">Aucun encaissement à sécuriser pour cette semaine.</p>}

          <details className="proba-risques__hypotheses">
            <summary>Méthode et couverture</summary>
            <ul>
              <li>
                Mêmes {r.nombreSimulations.toLocaleString("fr-FR")} scénarios que la prévision affichée. Chaque scénario négatif est rejoué à l&apos;identique, puis avec une
                seule facture encaissée à sa date de référence, tous les autres tirages inchangés : la contribution est mesurée, pas supposée.
              </li>
              <li>
                {r.couverture.facturesCandidates} facture{r.couverture.facturesCandidates > 1 ? "s" : ""} à encaisser testée{r.couverture.facturesCandidates > 1 ? "s" : ""}, quelle
                que soit leur échéance (y compris les factures en retard à date estimée).
              </li>
              <li>
                Paires : testées parmi les {r.couverture.facturesParPaires} factures qui réduisent le plus le déficit de chaque scénario ({r.couverture.pairesTestees.toLocaleString("fr-FR")}{" "}
                paire{r.couverture.pairesTestees > 1 ? "s" : ""} testée{r.couverture.pairesTestees > 1 ? "s" : ""}).
              </li>
              {r.couverture.facturesNonExploitables.length > 0 && (
                <li>
                  Non analysée{r.couverture.facturesNonExploitables.length > 1 ? "s" : ""} (date d&apos;encaissement à actualiser) :{" "}
                  {r.couverture.facturesNonExploitables.map((f) => nomFactureSemaine(f)).join(", ")}.
                </li>
              )}
              <li>Tension : solde de fin de journée strictement inférieur à 0 €. Le déficit est le montant le plus bas atteint dans la semaine, à couvrir dans ce scénario.</li>
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Conteneur : requête au serveur (offre Pilotage revérifiée), cache par jeu de données et semaine
// ---------------------------------------------------------------------------------------------

type Requete = Omit<RequeteRisques, "factures"> & { factures: FactureAnalysee[] };

async function appeler<T>(accessToken: string, corps: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch("/api/futur/probabiliste/semaine", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(corps),
    signal,
  });
  const reponse = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(reponse.error ?? "L'analyse de la semaine n'a pas pu être calculée.");
  return reponse as T;
}

export default function EncaissementsASecuriser({
  accessToken,
  requete,
  semaine,
  ...vue
}: {
  accessToken: string | null;
  requete: Requete | null;
  semaine: { debut: string; fin: string };
  risque: SemaineRisque | null;
  nombreSimulations: number;
  onVoirFacture: (terme: string) => void;
  onSemainePrecedente: (() => void) | null;
  onSemaineSuivante: (() => void) | null;
  onFermer: () => void;
}) {
  const [etat, setEtat] = useState<EtatSemaine>({ resultat: null, enCours: false, erreur: null });
  // Cache : une analyse par semaine pour le jeu de données courant (vidé dès que les données changent).
  const cache = useRef<{ requete: Requete | null; parSemaine: Map<string, ReponseSemaine> }>({ requete: null, parSemaine: new Map() });
  const numero = useRef(0);

  useEffect(() => {
    if (!accessToken || requete === null) return;
    if (cache.current.requete !== requete) cache.current = { requete, parSemaine: new Map() };
    const enCache = cache.current.parSemaine.get(semaine.debut);
    if (enCache) {
      setEtat({ resultat: enCache, enCours: false, erreur: null });
      return;
    }
    const ce = ++numero.current;
    const controleur = new AbortController();
    setEtat((e) => ({ ...e, enCours: true, erreur: null }));
    appeler<ReponseSemaine>(accessToken, { ...requete, semaine }, controleur.signal)
      .then((resultat) => {
        if (cache.current.requete === requete) cache.current.parSemaine.set(semaine.debut, resultat);
        if (ce === numero.current) setEtat({ resultat, enCours: false, erreur: null });
      })
      .catch((e: Error) => {
        if (e.name === "AbortError" || ce !== numero.current) return;
        setEtat((x) => ({ ...x, enCours: false, erreur: e.message }));
      });
    return () => controleur.abort();
  }, [accessToken, requete, semaine]);

  const testeur: Testeur = (simulation, cleLigne, date) => {
    if (!accessToken || requete === null) return Promise.reject(new Error("Session expirée : reconnectez-vous."));
    return appeler<ReponseTestDecalage>(accessToken, { ...requete, semaine, test: { simulation, cleLigne, date } });
  };

  return <EncaissementsASecuriserVue semaine={semaine} etat={etat} testeur={testeur} {...vue} />;
}
