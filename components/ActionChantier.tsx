"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Cartouche from "@/components/Cartouche";
import ActionCreation, { ChantierALancer } from "@/components/ActionCreation";
import ActionKpiCarte from "@/components/ActionKpiCarte";
import {
  Chantier,
  CLE_PERSONNALISE,
  DonneesPasse,
  formatJourLong,
  joursEcoules,
  libellePeriode,
  moisSaisissables,
  suivreKpi,
  SuiviKpi,
  ValeurManuelle,
} from "@/lib/actionChantier";
import {
  chargerChantierActif,
  chargerDonneesPasse,
  ChantierCharge,
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
  | { etat: "pret"; exercice: ConfigExercice; charge: ChantierCharge | null };

/**
 * Module Action : LE chantier de rentabilité prioritaire de l'entreprise. Charge le chantier
 * actif, puis les données du module Passé sur sa période ; sans chantier, propose d'en définir un.
 */
export default function ActionChantier({ organizationId }: ActionChantierProps) {
  const aujourdhui = todayISO();
  const [chargement, setChargement] = useState<Chargement>({ etat: "chargement" });
  const [rechargement, setRechargement] = useState(0);
  const [creation, setCreation] = useState(false);

  useEffect(() => {
    let annule = false;
    setChargement({ etat: "chargement" });
    Promise.all([chargerExercice(supabase!, organizationId), chargerChantierActif(supabase!, organizationId)])
      .then(([exercice, charge]) => {
        if (!annule) setChargement({ etat: "pret", exercice, charge });
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

  const { exercice, charge } = chargement;

  if (!charge) {
    return (
      <section className="passe action">
        {creation ? (
          <ActionCreation aujourdhui={aujourdhui} exercice={exercice} chargerDonnees={chargerDonnees} lancer={lancer} annuler={() => setCreation(false)} />
        ) : (
          <ActionVide onDefinir={() => setCreation(true)} />
        )}
      </section>
    );
  }

  return (
    <SuiviCharge
      key={charge.chantier.id}
      organizationId={organizationId}
      charge={charge}
      exercice={exercice}
      aujourdhui={aujourdhui}
      chargerDonnees={chargerDonnees}
      onCloture={() => setRechargement((n) => n + 1)}
    />
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

  const suivis = useMemo(
    () => (donnees.etat === "pret" ? chantier.kpis.map((k) => suivreKpi(k, chantier, donnees.donnees, valeursManuelles, aujourdhui)) : null),
    [donnees, chantier, valeursManuelles, aujourdhui]
  );

  const enregistrer = async (kpiId: string, mois: string, valeur: number) => {
    await enregistrerValeurManuelle(supabase!, organizationId, kpiId, mois, valeur);
    setValeursManuelles((courantes) => [...courantes.filter((v) => !(v.kpiId === kpiId && v.mois === mois)), { kpiId, mois, valeur }]);
  };

  const cloturer = async () => {
    await cloturerChantier(supabase!, organizationId, chantier.id);
    onCloture();
  };

  return (
    <ActionSuivi
      chantier={chantier}
      exercice={exercice}
      aujourdhui={aujourdhui}
      suivis={suivis}
      erreurDonnees={donnees.etat === "erreur"}
      axeAConfigurer={donnees.etat === "pret" && donnees.axeAConfigurer}
      enregistrer={enregistrer}
      cloturer={cloturer}
    />
  );
}

/** Écran de suivi du chantier — purement d'affichage. */
export function ActionSuivi({
  chantier,
  exercice,
  aujourdhui,
  suivis,
  erreurDonnees,
  axeAConfigurer,
  enregistrer,
  cloturer,
}: {
  chantier: Chantier;
  exercice: ConfigExercice;
  aujourdhui: string;
  // null : données du module Passé en cours de chargement.
  suivis: SuiviKpi[] | null;
  erreurDonnees: boolean;
  axeAConfigurer: boolean;
  enregistrer: (kpiId: string, mois: string, valeur: number) => Promise<void>;
  cloturer: () => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState<{ ouverte: boolean; enCours: boolean; erreur: string | null }>({
    ouverte: false,
    enCours: false,
    erreur: null,
  });
  const { periode } = chantier;
  const jours = joursEcoules(periode, aujourdhui);
  const nomPeriode = libellePeriode(chantier.typePeriode, periode, exercice);
  const avancement =
    periode.debut > aujourdhui ? `démarre le ${formatJourLong(periode.debut)}` : periode.fin < aujourdhui ? "période terminée" : `jour ${jours.ecoules} sur ${jours.total}`;

  const confirmerCloture = async () => {
    setConfirmation({ ouverte: true, enCours: true, erreur: null });
    try {
      await cloturer();
    } catch {
      setConfirmation({ ouverte: true, enCours: false, erreur: "Clôture impossible pour le moment." });
    }
  };

  return (
    <section className="passe action">
      <header className="action-chantier">
        <div className="action-chantier__texte">
          <p className="eyebrow">Chantier prioritaire</p>
          <h3 className="action-chantier__titre">{chantier.titre}</h3>
          <p className="action-chantier__changement">{chantier.changement}</p>
          <p className="action-chantier__dates">
            <strong>{nomPeriode}</strong> · du {formatJourLong(periode.debut)} au {formatJourLong(periode.fin)} · {avancement}
          </p>
        </div>
        <div className="action-chantier__actions">
          {confirmation.ouverte ? (
            <div className="action-confirmation" role="group" aria-label="Clôturer le chantier">
              <p>Clôturer ce chantier ? Il ne sera plus suivi ; vous pourrez en lancer un nouveau.</p>
              <div className="action-confirmation__boutons">
                <button type="button" className="btn-secondaire" onClick={() => setConfirmation({ ouverte: false, enCours: false, erreur: null })} disabled={confirmation.enCours}>
                  Annuler
                </button>
                <button type="button" className="btn-add" onClick={() => void confirmerCloture()} disabled={confirmation.enCours}>
                  {confirmation.enCours ? "Clôture…" : "Clôturer"}
                </button>
              </div>
              {confirmation.erreur && <p className="login-erreur">{confirmation.erreur}</p>}
            </div>
          ) : (
            <button type="button" className="btn-secondaire" onClick={() => setConfirmation({ ouverte: true, enCours: false, erreur: null })}>
              Clôturer le chantier
            </button>
          )}
        </div>
      </header>

      {axeAConfigurer && (
        <p className="login-erreur">Plusieurs axes analytiques : choisissez-en un dans Passé › Correspondance P&L pour que Novanta calcule les indicateurs.</p>
      )}

      {erreurDonnees ? (
        <p className="login-erreur">Impossible de charger les données du module Passé : les indicateurs automatiques sont indisponibles pour le moment.</p>
      ) : suivis === null ? (
        <p className="passe-message">Calcul des indicateurs…</p>
      ) : (
        <div className="action-kpis">
          {suivis.map((suivi) => (
            <ActionKpiCarte
              key={suivi.kpi.id}
              suivi={suivi}
              saisie={
                suivi.kpi.cle === CLE_PERSONNALISE
                  ? { mois: moisSaisissables(periode, aujourdhui), enregistrer: (mois, valeur) => enregistrer(suivi.kpi.id, mois, valeur) }
                  : undefined
              }
            />
          ))}
        </div>
      )}

      <Cartouche
        titre="Lecture"
        lignes={[
          { libelle: "Indicateurs automatiques", valeur: "P&L du module Passé, mêmes dates" },
          { libelle: "Mois clos", valeur: "dernier jour passé ; mois en cours provisoire" },
          { libelle: "Références", valeur: "figées au lancement du chantier" },
          { libelle: "Objectifs", valeur: "valeurs finales fixes, sans trajectoire" },
        ]}
      />
    </section>
  );
}
