"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import PasseCorrespondanceComptable from "./PasseCorrespondanceComptable";
import PasseStructureChart from "./PasseStructureChart";
import { teintesParCategorie } from "@/lib/dataviz";
import { formatMontantComptable, formatPourcentage } from "@/lib/format";
import { chargerCompta, DemandeSynchroCompta, envoyerImportFec, modifierCompta, ReponseCompta, synchroniserCompta } from "@/lib/comptaClient";
import type { ResultatImportFec } from "@/lib/comptaRepository";
import type { ImportFecPrepare } from "@/lib/fecParseur";
import PasseAjustementsComptables from "./PasseAjustementsComptables";
import PasseComparaisonComptable from "./PasseComparaisonComptable";
import PasseImportFec from "./PasseImportFec";
import { etatExercice } from "@/lib/comptaExercices";
import type { BilanSynchro } from "@/lib/comptaSynchro";
import { RegleCorrespondance } from "@/lib/comptaCorrespondance";
import { comptesNouveaux, lignesDuRapport, structuresDuRapport, TEXTE_DEUX_PNL, TITRE_PNL_COMPTABLE } from "@/lib/comptaLecture";
import { SourceStock } from "@/lib/comptaPnl";
import { libellePerimetreMois, MENTION_BALANCE, periodePartielle, resumeSources, resumeSynchro, TEXTE_PROVISOIRE, TEXTE_STATUT_AMBIGU, TITRE_PROVISOIRE } from "@/lib/comptaLecture";
import { formatDateCourte, todayISO, toISODate } from "@/lib/dates";
import { Periode } from "@/lib/pastTransactions";

type Onglet = "pnl" | "comparaison" | "correspondance" | "import" | "ajustements";

/** Données et actions de l'écran : en vrai par les routes, en démonstration sur des données simulées. */
export interface ServicesCompta {
  charger: (periode: Periode) => Promise<ReponseCompta>;
  modifier: (action: Parameters<typeof modifierCompta>[1]) => Promise<void>;
  synchroniser: (demande: DemandeSynchroCompta) => Promise<BilanSynchro>;
  importerFec: (preparation: ImportFecPrepare, remplacer: boolean) => Promise<ResultatImportFec>;
}

export function servicesCompta(accessToken: string): ServicesCompta {
  return {
    charger: (periode) => chargerCompta(accessToken, periode),
    modifier: (action) => modifierCompta(accessToken, action),
    synchroniser: (demande) => synchroniserCompta(accessToken, demande),
    importerFec: (preparation, remplacer) => envoyerImportFec(accessToken, preparation, remplacer),
  };
}

interface PasseComptaProps {
  periode: Periode;
  services: ServicesCompta;
  // Ouvre l'écran de saisie des stocks du module Passé.
  onOuvrirStocks?: () => void;
}

function LignesRapport({ reponse }: { reponse: ReponseCompta }) {
  const { pnl } = reponse;
  const [ouvertes, setOuvertes] = useState<ReadonlySet<string>>(new Set());
  const basculer = (cle: string) =>
    setOuvertes((actuelles) => {
      const suivantes = new Set(actuelles);
      if (suivantes.has(cle)) suivantes.delete(cle);
      else suivantes.add(cle);
      return suivantes;
    });
  return (
    <>
      {lignesDuRapport(pnl).map((bloc) => (
        <div key={bloc[0].cle} className="passe-pnl__bloc">
          {bloc.map((ligne) => {
            // Comptes significatifs sans affectation ou illisibles : pas de sous-total présenté comme acquis.
            const masque = ligne.niveau !== undefined && (pnl.nonAffectes.significatif || pnl.comptesIllisibles > 0 || reponse.conflitsSource.length > 0);
            const details = ligne.categories ?? [];
            const depliable = details.length > 0;
            return (
              <div key={ligne.cle}>
                <div className={`passe-pnl__ligne${ligne.niveau ? ` passe-pnl__ligne--${ligne.niveau}` : ""}`}>
                  <span className="passe-pnl__libelle">
                    {depliable ? (
                      <button type="button" className="compta-depli" aria-expanded={ouvertes.has(ligne.cle)} onClick={() => basculer(ligne.cle)}>
                        {ligne.libelle} <span aria-hidden="true">{ouvertes.has(ligne.cle) ? "▴" : "▾"}</span>
                      </button>
                    ) : (
                      ligne.libelle
                    )}
                  </span>
                  <span className="passe-pnl__montant">{masque ? <span className="passe-pnl__incomplet">Incomplet</span> : formatMontantComptable(ligne.montant)}</span>
                  <span className="passe-pnl__ratio">{ligne.ratio === undefined || masque ? "" : formatPourcentage(ligne.ratio)}</span>
                </div>
                {ouvertes.has(ligne.cle) &&
                  details.map((categorie) => (
                    <div key={categorie.nom} className="passe-pnl__ligne compta-categorie">
                      <span className="passe-pnl__libelle">{categorie.nom}</span>
                      <span className="passe-pnl__montant">{formatMontantComptable(categorie.montant)}</span>
                      <span className="passe-pnl__ratio" />
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

// Le P&L comptable et sa correspondance, dans l'offre Pilotage. Chiffres calculés côté serveur sur les
// écritures de Pennylane : aucune réconciliation avec le P&L cash estimé, volontairement.
export default function PasseCompta({ periode: periodeDuModule, services, onOuvrirStocks }: PasseComptaProps) {
  const [onglet, setOnglet] = useState<Onglet>("pnl");
  // Un exercice choisi ici, le temps de lire un historique ; sinon la période du module.
  const [exerciceChoisi, setExerciceChoisi] = useState<Periode | null>(null);
  const periode = exerciceChoisi ?? periodeDuModule;
  const [reponse, setReponse] = useState<ReponseCompta | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [erreurModification, setErreurModification] = useState<string | null>(null);
  const [synchro, setSynchro] = useState<{ enCours: boolean; message: string | null; erreur: string | null }>({ enCours: false, message: null, erreur: null });
  const [rechargement, setRechargement] = useState(0);
  // Resynchroniser un exercice clôturé demande une seconde action explicite.
  const [exerciceAConfirmer, setExerciceAConfirmer] = useState<string | null>(null);
  const { charger, modifier, synchroniser, importerFec } = services;

  useEffect(() => {
    let annule = false;
    setErreur(null);
    charger(periode)
      .then((r) => {
        if (!annule) setReponse(r);
      })
      .catch((e: Error) => {
        if (annule) return;
        setReponse(null);
        setErreur(e.message);
      });
    return () => {
      annule = true;
    };
  }, [charger, periode, rechargement]);

  const appliquer = useCallback(
    (action: Parameters<typeof modifier>[0]) => {
      setErreurModification(null);
      modifier(action)
        .then(() => setRechargement((n) => n + 1))
        .catch((e: Error) => setErreurModification(e.message));
    },
    [modifier]
  );

  const lancerSynchro = async (demande: DemandeSynchroCompta) => {
    setSynchro({ enCours: true, message: null, erreur: null });
    setExerciceAConfirmer(null);
    try {
      const bilan = await synchroniser(demande);
      setSynchro({ enCours: false, erreur: null, message: resumeSynchro(bilan) });
      setRechargement((n) => n + 1);
    } catch (e) {
      setSynchro({ enCours: false, message: null, erreur: (e as Error).message });
    }
  };

  const structures = useMemo(() => (reponse ? structuresDuRapport(reponse.pnl) : null), [reponse]);
  const teintes = useMemo(() => teintesParCategorie(structures?.categories ?? []), [structures]);
  const nouveaux = useMemo(() => comptesNouveaux(reponse?.comptes ?? [], reponse?.derniereSynchroReussie?.termineeLe ?? null), [reponse]);

  if (erreur) {
    return (
      <div className="passe-etat">
        <p>{erreur}</p>
        <button type="button" className="btn-secondaire" onClick={() => setRechargement((n) => n + 1)}>
          Réessayer
        </button>
      </div>
    );
  }
  if (!reponse || !structures) return <div className="passe-etat">Chargement du P&amp;L comptable…</div>;

  const { pnl } = reponse;
  const choisirSourceStock = (perimetre: { debut: string; fin: string }, source: SourceStock | null) => appliquer({ action: "source_stock", debut: perimetre.debut, fin: perimetre.fin, source });
  const derniere = reponse.derniereSynchroReussie;
  // Seuls les exercices de Pennylane se resynchronisent ; ceux des FEC se remplacent par un nouvel import.
  const exercicesClotures = reponse.exercices.filter((e) => etatExercice(e.statut) === "cloture" && !e.idSource.startsWith("fec:"));
  const sources = resumeSources(reponse.sourceParMois);
  const ongletBouton = (cle: Onglet, libelle: string, pastille?: number) => (
    <button key={cle} type="button" className={`btn-secondaire${onglet === cle ? " btn-module--actif" : ""}`} aria-pressed={onglet === cle} onClick={() => setOnglet(cle)}>
      {libelle}
      {pastille ? <span className="passe-onglet__pastille">{pastille}</span> : null}
    </button>
  );

  return (
    <>
      <div className="passe-controles">
        <div className="passe-tri selecteur" role="group" aria-label="Écran du P&L comptable">
          {ongletBouton("pnl", TITRE_PNL_COMPTABLE)}
          {ongletBouton("comparaison", "Comparer")}
          {ongletBouton("correspondance", "Correspondance comptable", pnl.nonAffectes.comptes.length)}
          {ongletBouton("import", "Import FEC")}
          {ongletBouton("ajustements", "Ajustements")}
        </div>
        {reponse.synchroDisponible && (
          <div className="passe-controles__actions">
            <button type="button" className="btn-add" onClick={() => lancerSynchro({ type: "manuel" })} disabled={synchro.enCours}>
              {synchro.enCours ? "Actualisation…" : "Actualiser la comptabilité"}
            </button>
          </div>
        )}
      </div>
      {synchro.erreur && <p className="login-erreur">{synchro.erreur}</p>}
      {synchro.message && <p className="passe-message">{synchro.message}</p>}
      {erreurModification && onglet !== "correspondance" && <p className="login-erreur">{erreurModification}</p>}

      {reponse.exercices.length > 0 && onglet === "pnl" && (
        <div className="passe-controle passe-axe">
          <label className="passe-controle__label" htmlFor="compta-exercice">
            Période lue
          </label>
          <select
            id="compta-exercice"
            value={exerciceChoisi ? `${exerciceChoisi.debut}|${exerciceChoisi.fin}` : ""}
            onChange={(e) => {
              const [debut, fin] = e.target.value.split("|");
              setExerciceChoisi(debut ? { debut, fin } : null);
            }}
          >
            <option value="">Période du module</option>
            {reponse.exercices
              .filter((e) => e.debut <= todayISO())
              .map((e) => (
                <option key={e.idSource} value={`${e.debut}|${e.fin}`}>
                  Exercice du {formatDateCourte(e.debut)} au {formatDateCourte(e.fin)}
                </option>
              ))}
          </select>
        </div>
      )}
      {sources && <p className="passe-message">Sources de la période · {sources}.</p>}
      {reponse.conflitsSource.map((c) => (
        <div key={c.debut} className="passe-message passe-flux-hors-pnl" role="alert">
          <p>
            Du {formatDateCourte(c.debut)} au {formatDateCourte(c.fin)}, le FEC{c.fichier ? ` « ${c.fichier} »` : ""} et Pennylane couvrent les mêmes mois ({c.mois.length}). Ils ne s&apos;additionnent jamais : ces mois restent hors du calcul tant qu&apos;aucune source n&apos;est choisie. Aucune n&apos;est plus fiable par principe : retenez celle qui fait foi pour cette période.
          </p>
          <div className="passe-tri selecteur" role="group" aria-label="Source de la période">
            <button type="button" className="btn-secondaire" onClick={() => appliquer({ action: "source_periode", debut: c.debut, fin: c.fin, source: "fec" })}>
              Retenir le FEC
            </button>
            <button type="button" className="btn-secondaire" onClick={() => appliquer({ action: "source_periode", debut: c.debut, fin: c.fin, source: "pennylane" })}>
              Retenir Pennylane
            </button>
          </div>
        </div>
      ))}

      {(reponse.provisoire.provisoire || derniere) && (
        <div className="passe-message compta-provisoire" role="status">
          {reponse.provisoire.provisoire && <p className="compta-provisoire__titre">{TITRE_PROVISOIRE}</p>}
          {derniere?.termineeLe && <p>Dernière synchronisation : {formatDateCourte(toISODate(new Date(derniere.termineeLe)))}.</p>}
          {reponse.provisoire.provisoire && <p>{TEXTE_PROVISOIRE}</p>}
          {reponse.provisoire.ambigu && <p>{TEXTE_STATUT_AMBIGU}</p>}
        </div>
      )}

      {pnl.nonAffectes.comptes.length > 0 && (
        <p className={`passe-non-categorise passe-non-categorise--alerte`} role="status">
          <span aria-hidden="true">⚠ </span>
          {pnl.nonAffectes.comptes.length} compte{pnl.nonAffectes.comptes.length > 1 ? "s" : ""} sans correspondance ({formatMontantComptable(pnl.nonAffectes.montant)}), hors du résultat.{" "}
          <button type="button" className="passe-lien-ligne" onClick={() => setOnglet("correspondance")}>
            Les affecter
          </button>
        </p>
      )}

      {periodePartielle(periode) && (
        <p className="passe-message" role="status">
          La balance est mensuelle : ce P&amp;L couvre les mois entiers, du {formatDateCourte(reponse.moisEntiers.debut)} au {formatDateCourte(reponse.moisEntiers.fin)}.
        </p>
      )}

      {pnl.comptesIllisibles > 0 && (
        <p className="passe-non-categorise passe-non-categorise--alerte" role="status">
          <span aria-hidden="true">⚠ </span>
          {pnl.comptesIllisibles} numéro{pnl.comptesIllisibles > 1 ? "s" : ""} de compte illisible{pnl.comptesIllisibles > 1 ? "s" : ""}, hors du calcul.
        </p>
      )}

      {reponse.decisionsStock.filter((d) => d.conflit).map((d) => (
        <div key={d.perimetre.cle} className="passe-message passe-flux-hors-pnl" role="alert">
          <p>
            Variation de stocks, exercice du {formatDateCourte(d.perimetre.debut)} au {formatDateCourte(d.perimetre.fin)} : la comptabilité contient des écritures ({formatMontantComptable(d.montantPennylane)}, {libellePerimetreMois(d.moisPennylane)}) et des stocks sont saisis dans Novanta ({formatMontantComptable(d.montantNovanta)}, {libellePerimetreMois(d.moisNovanta)}). Novanta ne peut pas savoir si elles couvrent le même périmètre, et les additionner risquerait de compter deux fois la même variation. Quelle source retenir pour cet exercice ?
          </p>
          <div className="passe-tri selecteur" role="group" aria-label="Source de la variation de stocks">
            <button type="button" className="btn-secondaire" onClick={() => choisirSourceStock(d.perimetre, "pennylane")}>
              Écritures comptables
            </button>
            <button type="button" className="btn-secondaire" onClick={() => choisirSourceStock(d.perimetre, "novanta")}>
              Stocks saisis dans Novanta
            </button>
          </div>
        </div>
      ))}
      {reponse.decisionsStock.filter((d) => d.choix?.source && !d.conflit && d.moisPennylane.length > 0 && d.moisNovanta.length > 0).map((d) => (
        <p key={d.perimetre.cle} className="passe-message">
          Variation de stocks de l&apos;exercice du {formatDateCourte(d.perimetre.debut)} : {d.source === "novanta" ? "stocks saisis dans Novanta" : "écritures comptables"}, selon votre arbitrage.
          {d.sourceModifieeDepuisChoix && " Une source a changé depuis ce choix."}{" "}
          <button type="button" className="passe-lien-ligne" onClick={() => choisirSourceStock(d.perimetre, null)}>
            Changer de source
          </button>
          {onOuvrirStocks && d.source === "novanta" && (
            <>
              {" · "}
              <button type="button" className="passe-lien-ligne" onClick={onOuvrirStocks}>
                Voir les stocks
              </button>
            </>
          )}
        </p>
      ))}
      {reponse.decisionsAmortissement.filter((d) => d.conflit).map((d) => (
        <div key={d.perimetre.cle} className="passe-message passe-flux-hors-pnl" role="alert">
          <p>
            Amortissements, exercice du {formatDateCourte(d.perimetre.debut)} au {formatDateCourte(d.perimetre.fin)} : la comptabilité contient des dotations ({formatMontantComptable(d.montantComptable)}, {libellePerimetreMois(d.moisComptables)}) et des dotations estimées sont saisies dans Novanta ({formatMontantComptable(d.montantAjustements)}, {libellePerimetreMois(d.moisAjustements)}). Une seule source sera retenue pour cet exercice : laquelle ?
          </p>
          <div className="passe-tri selecteur" role="group" aria-label="Source des amortissements">
            <button type="button" className="btn-secondaire" onClick={() => appliquer({ action: "source_stock", debut: d.perimetre.debut, fin: d.perimetre.fin, source: "pennylane", element: "depreciation" })}>
              Dotations comptables
            </button>
            <button type="button" className="btn-secondaire" onClick={() => appliquer({ action: "source_stock", debut: d.perimetre.debut, fin: d.perimetre.fin, source: "novanta", element: "depreciation" })}>
              Dotations estimées
            </button>
          </div>
        </div>
      ))}
      {reponse.ajustementsAVerifier.length > 0 && (
        <p className="passe-message" role="status">
          {reponse.ajustementsAVerifier.length} ajustement{reponse.ajustementsAVerifier.length > 1 ? "s portent" : " porte"} sur un exercice clôturé : la comptabilité en tient peut-être déjà compte, ce que Novanta ne peut pas établir à partir d&apos;un numéro de compte. À vérifier dans l&apos;onglet Ajustements.
        </p>
      )}

      {onglet === "import" ? (
        <PasseImportFec
          imports={reponse.imports}
          importer={importerFec}
          onImporte={() => setRechargement((n) => n + 1)}
          onRetirer={(id) => appliquer({ action: "retirer_import", id })}
          onVoir={(p) => {
            setExerciceChoisi(p);
            setOnglet("pnl");
          }}
          onCorrespondance={(p) => {
            setExerciceChoisi(p);
            setOnglet("correspondance");
          }}
        />
      ) : onglet === "ajustements" ? (
        <PasseAjustementsComptables
          ajustements={reponse.ajustements}
          ecartes={reponse.ajustementsEcartes}
          aVerifier={reponse.ajustementsAVerifier}
          onAjouter={(ajustements) => appliquer({ action: "ajouter_ajustements", ajustements })}
          onRetirer={(id) => appliquer({ action: "retirer_ajustement", id })}
        />
      ) : onglet === "comparaison" ? (
        <PasseComparaisonComptable exercices={reponse.exercices} charger={charger} />
      ) : onglet === "correspondance" ? (
        <PasseCorrespondanceComptable
          comptes={pnl.comptes}
          regles={reponse.regles}
          nouveauxComptes={nouveaux}
          onEnregistrer={(regle: RegleCorrespondance) => appliquer({ action: "enregistrer_regle", prefixe: regle.prefixe, destination: regle.destination, categorie: regle.categorie })}
          onSupprimer={(prefixe) => appliquer({ action: "supprimer_regle", prefixe })}
          onAppliquerModele={() => appliquer({ action: "appliquer_modele" })}
          erreur={erreurModification}
        />
      ) : !pnl.aDesEcritures ? (
        <div className="passe-etat">
          <p>Aucune écriture comptable sur cette période.</p>
          <p>Le P&amp;L cash estimé reste disponible et utilisable.</p>
          <button type="button" className="btn-secondaire" onClick={() => setOnglet("import")}>
            Importer un FEC
          </button>
        </div>
      ) : (
        <div className="passe-general">
          <section className="passe-pnl" aria-label={TITRE_PNL_COMPTABLE}>
            <h2 className="passe-pnl__titre">{TITRE_PNL_COMPTABLE}</h2>
            <LignesRapport reponse={reponse} />
          </section>
          <div className="passe-general__structures">
            <PasseStructureChart titre="Structure des revenus" structure={structures.revenus} messageVide="Aucun revenu sur la période." teintes={teintes} />
            <PasseStructureChart titre="Structure des coûts" structure={structures.couts} messageVide="Aucun coût sur la période." teintes={teintes} />
          </div>
        </div>
      )}
      {reponse.synchroDisponible && exercicesClotures.length > 0 && (
        <details className="compta-regles">
          <summary>Exercices clôturés ({exercicesClotures.length})</summary>
          <p className="passe-message">Leur historique est conservé. Une resynchronisation remplace ses chiffres par ceux de Pennylane aujourd&apos;hui.</p>
          {exercicesClotures.map((e) => (
            <p key={e.idSource} className="passe-flux-hors-pnl__ligne">
              <span>
                Du {formatDateCourte(e.debut)} au {formatDateCourte(e.fin)}
              </span>
              {exerciceAConfirmer === e.idSource ? (
                <button type="button" className="btn-secondaire" disabled={synchro.enCours} onClick={() => lancerSynchro({ type: "exceptionnel", idExercice: e.idSource, confirmation: true })}>
                  Confirmer la resynchronisation
                </button>
              ) : (
                <button type="button" className="passe-lien-ligne" onClick={() => setExerciceAConfirmer(e.idSource)}>
                  Resynchroniser
                </button>
              )}
            </p>
          ))}
        </details>
      )}
      <p className="passe-disclaimer">
        {MENTION_BALANCE} {TEXTE_DEUX_PNL}
      </p>
    </>
  );
}
