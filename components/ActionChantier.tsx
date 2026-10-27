"use client";

import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import Cartouche from "@/components/Cartouche";
import ActionCreation, { ChantierALancer } from "@/components/ActionCreation";
import ActionKpiCarte from "@/components/ActionKpiCarte";
import {
  CarteKpi,
  carteDuSuivi,
  CLE_PERSONNALISE,
  DonneesPasse,
  formatJourLong,
  joursEcoules,
  libellePeriode,
  moisSaisissables,
  PhotographieChantier,
  photographierChantier,
  suivreKpi,
  ValeurManuelle,
} from "@/lib/actionChantier";
import {
  chargerChantierActif,
  chargerChantiersClotures,
  chargerDonneesPasse,
  ChantierCharge,
  ChantierCloture,
  cloturerChantier,
  enregistrerValeurManuelle,
  estTableAbsente,
  lancerChantier,
} from "@/lib/actionRepository";
import { todayISO } from "@/lib/dates";
import { ConfigExercice } from "@/lib/fiscalPeriods";
import { supabase } from "@/lib/supabaseClient";
import { chargerExercice } from "@/lib/pastTransactionsRepository";
import { Periode } from "@/lib/pastTransactions";

interface ActionChantierProps {
  organizationId: string;
}

type Chargement =
  | { etat: "chargement" }
  | { etat: "erreur"; message: string }
  | { etat: "pret"; exercice: ConfigExercice; charge: ChantierCharge | null; historique: ChantierCloture[] };

/**
 * Module Action : LE chantier de rentabilité prioritaire de l'entreprise. Charge le chantier
 * actif, puis les données du module Passé sur sa période ; sans chantier, propose d'en définir un.
 * Les chantiers clôturés restent consultables dans l'onglet Historique, tels qu'à leur clôture.
 */
export default function ActionChantier({ organizationId }: ActionChantierProps) {
  const aujourdhui = todayISO();
  const [chargement, setChargement] = useState<Chargement>({ etat: "chargement" });
  const [rechargement, setRechargement] = useState(0);
  const [creation, setCreation] = useState(false);
  const [vue, setVue] = useState<"en_cours" | "historique">("en_cours");
  const [ficheId, setFicheId] = useState<string | null>(null);

  useEffect(() => {
    let annule = false;
    setChargement({ etat: "chargement" });
    Promise.all([
      chargerExercice(supabase!, organizationId),
      chargerChantierActif(supabase!, organizationId),
      chargerChantiersClotures(supabase!, organizationId),
    ])
      .then(([exercice, charge, historique]) => {
        if (!annule) setChargement({ etat: "pret", exercice, charge, historique });
      })
      .catch((error) => {
        if (annule) return;
        console.error("[action] échec du chargement du chantier :", error);
        setChargement({
          etat: "erreur",
          message: estTableAbsente(error)
            ? "Le suivi du chantier n'est pas encore activé sur votre espace."
            : "Impossible de charger le chantier pour le moment.",
        });
      });
    return () => {
      annule = true;
    };
  }, [organizationId, rechargement]);

  const chargerDonnees = useCallback(
    (fenetre: Periode, avecBfr: boolean) => chargerDonneesPasse(supabase!, organizationId, fenetre, avecBfr),
    [organizationId]
  );

  const lancer = async (nouveau: ChantierALancer) => {
    await lancerChantier(supabase!, organizationId, nouveau, nouveau.kpis);
    setCreation(false);
    setRechargement((n) => n + 1);
  };

  if (chargement.etat === "chargement") {
    return (
      <section className="passe action">
        <p className="passe-message">Chargement du chantier…</p>
      </section>
    );
  }

  if (chargement.etat === "erreur") {
    return (
      <section className="passe action">
        <p className="login-erreur">{chargement.message}</p>
        <div>
          <button type="button" className="btn-secondaire" onClick={() => setRechargement((n) => n + 1)}>
            Réessayer
          </button>
        </div>
      </section>
    );
  }

  const { exercice, charge, historique } = chargement;
  const fiche = vue === "historique" && ficheId ? (historique.find((c) => c.id === ficheId) ?? null) : null;

  return (
    <section className="passe action">
      {historique.length > 0 && (
        <OngletsAction
          vue={vue}
          nombreClotures={historique.length}
          choisir={(v) => {
            setVue(v);
            setFicheId(null);
          }}
        />
      )}

      {vue === "historique" ? (
        fiche ? (
          <FicheCloturee chantier={fiche} retour={() => setFicheId(null)} />
        ) : (
          <HistoriqueChantiers historique={historique} exercice={exercice} ouvrir={setFicheId} />
        )
      ) : charge ? (
        <SuiviCharge
          key={charge.chantier.id}
          organizationId={organizationId}
          charge={charge}
          exercice={exercice}
          aujourdhui={aujourdhui}
          chargerDonnees={chargerDonnees}
          onCloture={() => setRechargement((n) => n + 1)}
        />
      ) : creation ? (
        <ActionCreation aujourdhui={aujourdhui} exercice={exercice} chargerDonnees={chargerDonnees} lancer={lancer} annuler={() => setCreation(false)} />
      ) : (
        <ActionVide onDefinir={() => setCreation(true)} />
      )}
    </section>
  );
}

/** Mêmes onglets que le module Passé : le chantier en cours, puis l'historique. */
export function OngletsAction({
  vue,
  nombreClotures,
  choisir,
}: {
  vue: "en_cours" | "historique";
  nombreClotures: number;
  choisir: (vue: "en_cours" | "historique") => void;
}) {
  const onglets = [
    { cle: "en_cours" as const, libelle: "Chantier en cours" },
    { cle: "historique" as const, libelle: "Historique" },
  ];
  return (
    <div className="passe-onglets" role="tablist">
      <div className="passe-onglets__groupe" role="presentation">
        {onglets.map((onglet) => (
          <button
            key={onglet.cle}
            type="button"
            role="tab"
            aria-selected={vue === onglet.cle}
            className={`passe-onglet${vue === onglet.cle ? " passe-onglet--actif" : ""}`}
            onClick={() => choisir(onglet.cle)}
          >
            {onglet.libelle}
            {onglet.cle === "historique" && <span className="passe-onglet__pastille">{nombreClotures}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ActionVide({ onDefinir }: { onDefinir: () => void }) {
  return (
    <div className="action-vide">
      <p className="eyebrow">Passé → Action → Futur</p>
      <h3 className="action-vide__titre">Aucun chantier en cours</h3>
      <p className="action-vide__texte">
        Choisissez LE changement prioritaire pour votre rentabilité, la période pendant laquelle vous le menez, et trois indicateurs pour en mesurer
        l'effet. Novanta les suit chaque mois à partir de vos données.
      </p>
      <div>
        <button type="button" className="btn-add" onClick={onDefinir}>
          Définir le chantier
        </button>
      </div>
    </div>
  );
}

function SuiviCharge({
  organizationId,
  charge,
  exercice,
  aujourdhui,
  chargerDonnees,
  onCloture,
}: {
  organizationId: string;
  charge: ChantierCharge;
  exercice: ConfigExercice;
  aujourdhui: string;
  chargerDonnees: (fenetre: Periode, avecBfr: boolean) => Promise<{ donnees: DonneesPasse; axeAConfigurer: boolean }>;
  onCloture: () => void;
}) {
  const { chantier } = charge;
  const [valeursManuelles, setValeursManuelles] = useState<ValeurManuelle[]>(charge.valeursManuelles);
  const [donnees, setDonnees] = useState<
    { etat: "chargement" } | { etat: "erreur" } | { etat: "pret"; donnees: DonneesPasse; axeAConfigurer: boolean }
  >({ etat: "chargement" });
  const avecBfr = chantier.kpis.some((k) => k.cle === "bfr");

  useEffect(() => {
    let annule = false;
    // Rien à lire avant le début du chantier : un chantier à venir n'a aucune valeur.
    const fenetre = chantier.periode.debut <= aujourdhui ? { debut: chantier.periode.debut, fin: [chantier.periode.fin, aujourdhui].sort()[0] } : null;
    (fenetre
      ? chargerDonnees(fenetre, avecBfr)
      : Promise.resolve({
          donnees: { transactions: [], axeId: null, mappings: new Map(), ajustements: [], premiereOperation: null, situationsBfr: [] },
          axeAConfigurer: false,
        })
    )
      .then((resultat) => {
        if (!annule) setDonnees({ etat: "pret", ...resultat });
      })
      .catch((error) => {
        if (annule) return;
        console.error("[action] échec du chargement des données du module Passé :", error);
        setDonnees({ etat: "erreur" });
      });
    return () => {
      annule = true;
    };
  }, [chantier.periode.debut, chantier.periode.fin, aujourdhui, avecBfr, chargerDonnees]);

  const cartes = useMemo(
    () =>
      donnees.etat === "pret"
        ? chantier.kpis.map((k) => carteDuSuivi(suivreKpi(k, chantier, donnees.donnees, valeursManuelles, aujourdhui), chantier.typePeriode, exercice))
        : null,
    [donnees, chantier, valeursManuelles, aujourdhui, exercice]
  );

  const enregistrer = async (kpiId: string, mois: string, valeur: number) => {
    await enregistrerValeurManuelle(supabase!, organizationId, kpiId, mois, valeur);
    setValeursManuelles((courantes) => [...courantes.filter((v) => !(v.kpiId === kpiId && v.mois === mois)), { kpiId, mois, valeur }]);
  };

  // La clôture photographie ce que le dirigeant voit : impossible tant que les indicateurs ne sont
  // pas calculés.
  const cloturer = cartes
    ? async () => {
        const photographie = photographierChantier(chantier, cartes, exercice, aujourdhui, new Date().toISOString());
        await cloturerChantier(supabase!, organizationId, chantier.id, photographie);
        onCloture();
      }
    : null;

  const { periode } = chantier;
  const jours = joursEcoules(periode, aujourdhui);
  const avancement =
    periode.debut > aujourdhui ? `démarre le ${formatJourLong(periode.debut)}` : periode.fin < aujourdhui ? "période terminée" : `jour ${jours.ecoules} sur ${jours.total}`;

  return (
    <ActionSuivi
      entete={{ titre: chantier.titre, changement: chantier.changement, libellePeriode: libellePeriode(chantier.typePeriode, periode, exercice), periode, avancement }}
      actions={<ClotureChantier cloturer={cloturer} />}
      cartes={cartes}
      erreurDonnees={donnees.etat === "erreur"}
      axeAConfigurer={donnees.etat === "pret" && donnees.axeAConfigurer}
      saisie={(kpiId) => ({ mois: moisSaisissables(periode, aujourdhui), enregistrer: (mois, valeur) => enregistrer(kpiId, mois, valeur) })}
      cartouche={[
        { libelle: "Indicateurs automatiques", valeur: "P&L du module Passé, mêmes dates" },
        { libelle: "Mois clos", valeur: "dernier jour passé ; mois en cours provisoire" },
        { libelle: "Références", valeur: "figées au lancement du chantier" },
        { libelle: "Objectifs", valeur: "valeurs finales fixes, sans trajectoire" },
      ]}
    />
  );
}

function ClotureChantier({ cloturer }: { cloturer: (() => Promise<void>) | null }) {
  const [etat, setEtat] = useState<{ ouverte: boolean; enCours: boolean; erreur: string | null }>({ ouverte: false, enCours: false, erreur: null });

  const confirmer = async () => {
    if (!cloturer) return;
    setEtat({ ouverte: true, enCours: true, erreur: null });
    try {
      await cloturer();
    } catch {
      setEtat({ ouverte: true, enCours: false, erreur: "Clôture impossible pour le moment." });
    }
  };

  if (!etat.ouverte) {
    return (
      <button type="button" className="btn-secondaire" onClick={() => setEtat({ ouverte: true, enCours: false, erreur: null })} disabled={!cloturer}>
        Clôturer le chantier
      </button>
    );
  }
  return (
    <div className="action-confirmation" role="group" aria-label="Clôturer le chantier">
      <p>Clôturer ce chantier ? Ses résultats sont figés tels qu'affichés aujourd'hui et il passe dans l'historique ; vous pourrez en lancer un nouveau.</p>
      <div className="action-confirmation__boutons">
        <button type="button" className="btn-secondaire" onClick={() => setEtat({ ouverte: false, enCours: false, erreur: null })} disabled={etat.enCours}>
          Annuler
        </button>
        <button type="button" className="btn-add" onClick={() => void confirmer()} disabled={etat.enCours || !cloturer}>
          {etat.enCours ? "Clôture…" : "Clôturer"}
        </button>
      </div>
      {etat.erreur && <p className="login-erreur">{etat.erreur}</p>}
    </div>
  );
}

interface EnteteChantier {
  titre: string;
  changement: string;
  libellePeriode: string;
  periode: Periode;
  avancement: string;
}

/** Écran d'un chantier — purement d'affichage, vivant (chantier en cours) ou figé (clôturé). */
export function ActionSuivi({
  entete,
  actions,
  statut,
  cartes,
  figee = false,
  erreurDonnees = false,
  axeAConfigurer = false,
  saisie,
  cartouche,
}: {
  entete: EnteteChantier;
  actions?: ReactNode;
  // Bandeau sous les dates (chantier clôturé).
  statut?: ReactNode;
  // null : données du module Passé en cours de chargement.
  cartes: CarteKpi[] | null;
  figee?: boolean;
  erreurDonnees?: boolean;
  axeAConfigurer?: boolean;
  saisie?: (kpiId: string) => { mois: string[]; enregistrer: (mois: string, valeur: number) => Promise<void> };
  cartouche: { libelle: string; valeur: string }[];
}) {
  const { periode } = entete;
  return (
    <>
      <header className="action-chantier">
        <div className="action-chantier__texte">
          <p className="eyebrow">{figee ? "Chantier clôturé" : "Chantier prioritaire"}</p>
          <h3 className="action-chantier__titre">{entete.titre}</h3>
          <p className="action-chantier__changement">{entete.changement}</p>
          <p className="action-chantier__dates">
            <strong>{entete.libellePeriode}</strong> · du {formatJourLong(periode.debut)} au {formatJourLong(periode.fin)} · {entete.avancement}
          </p>
          {statut}
        </div>
        {actions && <div className="action-chantier__actions">{actions}</div>}
      </header>

      {axeAConfigurer && (
        <p className="login-erreur">Plusieurs axes analytiques : choisissez-en un dans Passé › Correspondance P&L pour que Novanta calcule les indicateurs.</p>
      )}

      {erreurDonnees ? (
        <p className="login-erreur">Impossible de charger les données du module Passé : les indicateurs automatiques sont indisponibles pour le moment.</p>
      ) : cartes === null ? (
        <p className="passe-message">Calcul des indicateurs…</p>
      ) : (
        <div className="action-kpis">
          {cartes.map((carte) => (
            <ActionKpiCarte
              key={carte.suivi.kpi.id}
              carte={carte}
              figee={figee}
              saisie={!figee && saisie && carte.suivi.kpi.cle === CLE_PERSONNALISE ? saisie(carte.suivi.kpi.id) : undefined}
            />
          ))}
        </div>
      )}

      <Cartouche titre="Lecture" lignes={cartouche} />
    </>
  );
}

const formatHorodatage = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });

function dateDeCloture(clotureLe: string): string {
  return formatHorodatage.format(new Date(clotureLe));
}

export function HistoriqueChantiers({
  historique,
  exercice,
  ouvrir,
}: {
  historique: ChantierCloture[];
  exercice: ConfigExercice;
  ouvrir: (id: string) => void;
}) {
  return (
    <div className="action-historique">
      <h3 className="eyebrow eyebrow--encre">Chantiers clôturés</h3>
      <ul className="action-historique__liste">
        {historique.map((c) => (
          <li key={c.id} className="action-historique__ligne">
            <div className="action-historique__texte">
              <strong>{c.titre}</strong>
              <span>
                {c.photographie?.libellePeriode ?? libellePeriode(c.typePeriode, c.periode, exercice)} · du {formatJourLong(c.periode.debut)} au{" "}
                {formatJourLong(c.periode.fin)}
              </span>
            </div>
            <span className="action-historique__cloture">Clôturé le {dateDeCloture(c.clotureLe)}</span>
            <button type="button" className="btn-secondaire" onClick={() => ouvrir(c.id)}>
              Ouvrir la fiche
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function avancementALaCloture(photo: PhotographieChantier): string {
  if (photo.arreteAu > photo.periode.fin) return "clôturé après la fin de la période";
  const { ecoules, total } = joursEcoules(photo.periode, photo.arreteAu);
  return `clôturé au jour ${ecoules} sur ${total}`;
}

/** Fiche d'un chantier clôturé : la photographie de la clôture, en lecture seule. */
export function FicheCloturee({ chantier, retour }: { chantier: ChantierCloture; retour: () => void }) {
  const photo: PhotographieChantier | null = chantier.photographie;
  const retourBouton = (
    <button type="button" className="btn-secondaire" onClick={retour}>
      ← Retour à l'historique
    </button>
  );
  const bandeau = (
    <p className="action-chantier__cloture">
      <span className="action-statut action-statut--clos">Clôturé le {dateDeCloture(chantier.clotureLe)}</span>
      {photo && <span> · lecture seule, résultats figés à la clôture (données arrêtées au {formatJourLong(photo.arreteAu)})</span>}
    </p>
  );

  if (!photo) {
    return (
      <>
        <header className="action-chantier">
          <div className="action-chantier__texte">
            <p className="eyebrow">Chantier clôturé</p>
            <h3 className="action-chantier__titre">{chantier.titre}</h3>
            {bandeau}
          </div>
          <div className="action-chantier__actions">{retourBouton}</div>
        </header>
        <p className="login-erreur">Ce chantier a été clôturé avant l'historisation des résultats : aucune photographie de ses indicateurs n'est disponible.</p>
      </>
    );
  }

  return (
    <ActionSuivi
      entete={{ titre: photo.titre, changement: photo.changement, libellePeriode: photo.libellePeriode, periode: photo.periode, avancement: avancementALaCloture(photo) }}
      actions={retourBouton}
      statut={bandeau}
      cartes={photo.cartes}
      figee
      cartouche={[
        { libelle: "Résultats", valeur: `figés le ${dateDeCloture(photo.clotureLe)}, jamais recalculés` },
        { libelle: "Mois en cours à la clôture", valeur: "provisoire, tel qu'affiché alors" },
        { libelle: "Références", valeur: "figées au lancement du chantier" },
        { libelle: "Objectifs", valeur: "valeurs finales fixes, sans trajectoire" },
      ]}
    />
  );
}
