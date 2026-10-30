"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import PasseCorrespondanceComptable from "./PasseCorrespondanceComptable";
import PasseStructureChart from "./PasseStructureChart";
import { teintesParCategorie } from "@/lib/dataviz";
import { formatMontantComptable, formatPourcentage } from "@/lib/format";
import { chargerCompta, DemandeSynchroCompta, modifierCompta, ReponseCompta, synchroniserCompta } from "@/lib/comptaClient";
import { etatExercice } from "@/lib/comptaExercices";
import type { BilanSynchro } from "@/lib/comptaSynchro";
import { RegleCorrespondance } from "@/lib/comptaCorrespondance";
import { comptesNouveaux, lignesDuRapport, structuresDuRapport, TEXTE_DEUX_PNL, TITRE_PNL_COMPTABLE } from "@/lib/comptaLecture";
import { SourceStock } from "@/lib/comptaPnl";
import { libellePerimetreMois, MENTION_BALANCE, periodePartielle, resumeSynchro, TEXTE_PROVISOIRE, TEXTE_STATUT_AMBIGU, TITRE_PROVISOIRE } from "@/lib/comptaLecture";
import { formatDateCourte, toISODate } from "@/lib/dates";
import { Periode } from "@/lib/pastTransactions";

type Onglet = "pnl" | "correspondance";

/** Données et actions de l'écran : en vrai par les routes, en démonstration sur des données simulées. */
export interface ServicesCompta {
  charger: (periode: Periode) => Promise<ReponseCompta>;
  modifier: (action: Parameters<typeof modifierCompta>[1]) => Promise<void>;
  synchroniser: (demande: DemandeSynchroCompta) => Promise<BilanSynchro>;
}

export function servicesCompta(accessToken: string): ServicesCompta {
  return {
    charger: (periode) => chargerCompta(accessToken, periode),
    modifier: (action) => modifierCompta(accessToken, action),
    synchroniser: (demande) => synchroniserCompta(accessToken, demande),
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
            const masque = ligne.niveau !== undefined && (pnl.nonAffectes.significatif || pnl.comptesIllisibles > 0);
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
export default function PasseCompta({ periode, services, onOuvrirStocks }: PasseComptaProps) {
  const [onglet, setOnglet] = useState<Onglet>("pnl");
  const [reponse, setReponse] = useState<ReponseCompta | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [erreurModification, setErreurModification] = useState<string | null>(null);
  const [synchro, setSynchro] = useState<{ enCours: boolean; message: string | null; erreur: string | null }>({ enCours: false, message: null, erreur: null });
  const [rechargement, setRechargement] = useState(0);
  // Resynchroniser un exercice clôturé demande une seconde action explicite.
  const [exerciceAConfirmer, setExerciceAConfirmer] = useState<string | null>(null);
  const { charger, modifier, synchroniser } = services;

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
  const exercicesClotures = reponse.exercices.filter((e) => etatExercice(e.statut) === "cloture");

  return (
    <>
      <div className="passe-controles">
        <div className="passe-tri selecteur" role="group" aria-label="Écran du P&L comptable">
          <button type="button" className={`btn-secondaire${onglet === "pnl" ? " btn-module--actif" : ""}`} aria-pressed={onglet === "pnl"} onClick={() => setOnglet("pnl")}>
            {TITRE_PNL_COMPTABLE}
          </button>
          <button type="button" className={`btn-secondaire${onglet === "correspondance" ? " btn-module--actif" : ""}`} aria-pressed={onglet === "correspondance"} onClick={() => setOnglet("correspondance")}>
            Correspondance comptable
            {pnl.nonAffectes.comptes.length > 0 && <span className="passe-onglet__pastille">{pnl.nonAffectes.comptes.length}</span>}
          </button>
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
            Variation de stocks, exercice du {formatDateCourte(d.perimetre.debut)} au {formatDateCourte(d.perimetre.fin)} : Pennylane contient des écritures ({formatMontantComptable(d.montantPennylane)}, {libellePerimetreMois(d.moisPennylane)}) et des stocks sont saisis dans Novanta ({formatMontantComptable(d.montantNovanta)}, {libellePerimetreMois(d.moisNovanta)}). Novanta ne peut pas savoir si elles couvrent le même périmètre, et les additionner risquerait de compter deux fois la même variation. Quelle source retenir pour cet exercice ?
          </p>
          <div className="passe-tri selecteur" role="group" aria-label="Source de la variation de stocks">
            <button type="button" className="btn-secondaire" onClick={() => choisirSourceStock(d.perimetre, "pennylane")}>
              Écritures Pennylane
            </button>
            <button type="button" className="btn-secondaire" onClick={() => choisirSourceStock(d.perimetre, "novanta")}>
              Stocks saisis dans Novanta
            </button>
          </div>
        </div>
      ))}
      {reponse.decisionsStock.filter((d) => d.choix?.source && !d.conflit && d.moisPennylane.length > 0 && d.moisNovanta.length > 0).map((d) => (
        <p key={d.perimetre.cle} className="passe-message">
          Variation de stocks de l&apos;exercice du {formatDateCourte(d.perimetre.debut)} : {d.source === "novanta" ? "stocks saisis dans Novanta" : "écritures Pennylane"}, selon votre arbitrage.
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
      {reponse.ajustementsEcartes.length > 0 && (
        <p className="passe-message">
          {reponse.ajustementsEcartes.length} ajustement{reponse.ajustementsEcartes.length > 1 ? "s" : ""} de gestion écarté{reponse.ajustementsEcartes.length > 1 ? "s" : ""} : la comptabilité porte déjà des écritures sur cette ligne pour l&apos;exercice.
        </p>
      )}

      {onglet === "correspondance" ? (
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
