"use client";

import { useEffect, useRef, useState } from "react";
import ImpactRisqueChart from "./ImpactRisqueChart";
import { formatDate, formatMontant } from "@/lib/format";
import { decalerDateISO } from "@/lib/dates";
import type { AlerteRisque, FactureAnalysee, GroupeAlertes } from "@/lib/probaRisques";
import type { ReponseRisques, RequeteRisques } from "@/lib/probaApi";
import {
  datesDuScenario,
  limitesCouverture,
  messageSansAlerte,
  nomFacture,
  PHRASE_DATES_CONJOINTES,
  PHRASE_MEME_CLIENT,
  PHRASE_UN_SUFFIT,
  phraseDeclencheur,
  phrasePlausibilite,
  phrasesReference,
  resumeTension,
  titreGroupe,
  TypeLimite,
} from "@/lib/probaRisquesEcran";

const DELAI_CALCUL_MS = 700;
export const GROUPES_AFFICHES = 3;

export interface EtatRisques {
  resultat: ReponseRisques | null;
  enCours: boolean;
  aActualiser: boolean; // les données ont changé depuis le résultat affiché
  erreur: string | null;
}

// ---------------------------------------------------------------------------------------------
// Vue (sans requête : testée seule)
// ---------------------------------------------------------------------------------------------

function DetailFactures({ alerte, onVoirFacture }: { alerte: AlerteRisque; onVoirFacture: (terme: string) => void }) {
  return (
    <ul className="proba-risque__factures">
      {alerte.factures.map((f) => (
        <li key={f.cleLigne}>
          <span className="proba-risque__facture-nom">{nomFacture(f)}</span>
          <span className="proba-ligne__detail">
            Reste à encaisser {formatMontant(f.montantRestant)}
            {f.dateEcheance ? ` · échéance contractuelle ${formatDate(f.dateEcheance)}` : ""}
          </span>
          <span className="proba-ligne__detail">
            {datesDuScenario(f)}
            {f.dateReferenceEstimee ? " · date de référence estimée par l'historique de paiement (facture en retard)" : ""}
          </span>
          <span className="proba-ligne__detail">
            {f.dateCertaine ? "Date saisie comme ferme : ce retard est hypothétique. " : ""}
            {phrasePlausibilite(f.plausibilite)}
          </span>
          <button type="button" className="etage-pnl-outils__lien" onClick={() => onVoirFacture(f.numero ?? f.client)}>
            Ouvrir dans Flux de tréso
          </button>
        </li>
      ))}
    </ul>
  );
}

function TableauSituations({ alerte, dates }: { alerte: AlerteRisque; dates: string[] }) {
  return (
    <table className="invoice-table proba-risque__situations">
      <thead>
        <tr>
          <th>Situation</th>
          <th>Premier passage sous 0 €</th>
          <th>Point bas</th>
          <th>Jours sous zéro</th>
        </tr>
      </thead>
      <tbody>
        {alerte.situations.map((s) => (
          <tr key={s.libelle}>
            <td>{s.libelle}</td>
            <td>{s.mesures.premierNegatif !== null ? formatDate(dates[s.mesures.premierNegatif]) : "Aucun"}</td>
            <td>{formatMontant(s.mesures.minimum)}</td>
            <td>{s.mesures.premierNegatif === null ? "0" : s.mesures.retourPositif ? String(s.mesures.dureeJours) : `${s.mesures.dureeJours}, jusqu'à la fin de l'horizon`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CarteAlerte({ alerte, dates, onVoirFacture }: { alerte: AlerteRisque; dates: string[]; onVoirFacture: (terme: string) => void }) {
  const [ouvert, setOuvert] = useState<"factures" | "courbe" | null>(null);
  const basculer = (v: "factures" | "courbe") => setOuvert(ouvert === v ? null : v);
  return (
    <div className="proba-risque__alerte">
      <p className="proba-risque__declencheur">{phraseDeclencheur(alerte, dates)}</p>
      {alerte.type === "duo" && (
        <ul className="proba-risque__dates">
          {alerte.factures.map((f) => (
            <li key={f.cleLigne}>
              {nomFacture(f)} : {datesDuScenario(f)}
            </li>
          ))}
        </ul>
      )}
      {alerte.type === "duo" && <p className="proba-editeur__aide">{PHRASE_DATES_CONJOINTES}</p>}
      {alerte.type === "duo" && <p className="proba-editeur__aide">{PHRASE_UN_SUFFIT}</p>}
      {alerte.type === "duo" && alerte.memeClient && <p className="proba-editeur__aide">{PHRASE_MEME_CLIENT}</p>}
      <p className="proba-risque__tension">{resumeTension(alerte.mesures, dates)}</p>
      {alerte.decaissementsDuJour.length > 0 && (
        <p className="proba-editeur__aide">
          Ce jour-là sont aussi prévus : {alerte.decaissementsDuJour.map((d) => `${d.libelle} (${formatMontant(d.montant)})`).join(", ")}.
        </p>
      )}
      <div className="proba-risque__actions">
        <button type="button" className="btn-secondaire" aria-expanded={ouvert === "factures"} onClick={() => basculer("factures")}>
          {alerte.factures.length > 1 ? "Voir les 2 factures" : "Voir la facture"}
        </button>
        {alerte.situations.length > 0 && (
          <button type="button" className="btn-secondaire" aria-expanded={ouvert === "courbe"} onClick={() => basculer("courbe")}>
            Voir l&apos;impact sur la courbe
          </button>
        )}
      </div>
      {ouvert === "factures" && <DetailFactures alerte={alerte} onVoirFacture={onVoirFacture} />}
      {ouvert === "courbe" && alerte.situations.length > 0 && (
        <div className="proba-risque__impact">
          <ImpactRisqueChart dates={dates} situations={alerte.situations} />
          <TableauSituations alerte={alerte} dates={dates} />
        </div>
      )}
    </div>
  );
}

function CarteGroupe({ groupe, dates, onVoirFacture }: { groupe: GroupeAlertes; dates: string[]; onVoirFacture: (terme: string) => void }) {
  const [autresOuverts, setAutresOuverts] = useState(false);
  const reste = groupe.nombreTotal - groupe.alertes.length;
  return (
    <article className={`proba-risque proba-risque--${groupe.type}`} aria-label={titreGroupe(groupe, dates)}>
      <p className="proba-risque__titre">{titreGroupe(groupe, dates)}</p>
      {groupe.alertes.map((a) => (
        <CarteAlerte key={a.id} alerte={a} dates={dates} onVoirFacture={onVoirFacture} />
      ))}
      {reste > 0 && (
        <div className="proba-risque__autres">
          <button type="button" className="etage-pnl-outils__lien" aria-expanded={autresOuverts} onClick={() => setAutresOuverts(!autresOuverts)}>
            {autresOuverts ? "Masquer" : `+ ${reste} autre${reste > 1 ? "s" : ""} combinaison${reste > 1 ? "s" : ""} pour cette tension`}
          </button>
          {autresOuverts && (
            <ul>
              {groupe.autres.map((x) => (
                <li key={x.factures.map((f) => f.cleLigne).join("|")} className="proba-ligne__detail">
                  {x.factures.map((f) => `${nomFacture(f)} (+${f.retardJours} j)`).join(" et ")} · déficit {formatMontant(x.deficitMax)}
                </li>
              ))}
              {reste > groupe.autres.length && <li className="proba-ligne__detail">… et {reste - groupe.autres.length} autres.</li>}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

const LIBELLES_LIMITE: Record<TypeLimite, string> = {
  donnees: "Données",
  methode: "Méthode",
  calcul: "Calcul",
  affichage: "Affichage",
};

export function GestionRisquesVue({ etat, onVoirFacture }: { etat: EtatRisques; onVoirFacture: (terme: string) => void }) {
  const [toutes, setToutes] = useState(false);
  const { resultat } = etat;
  const dates = resultat?.dates ?? [];
  const groupes = resultat?.groupes ?? [];
  const affiches = toutes ? groupes : groupes.slice(0, GROUPES_AFFICHES);
  const limites = resultat ? limitesCouverture(resultat.couverture) : [];

  return (
    <section className="proba-section proba-risques" aria-label="Gestion des risques">
      <h4>Gestion des risques</h4>
      <p className="proba-risques__sous-titre">
        Encaissements critiques
        {resultat && (
          <>
            {" "}
            · horizon analysé du {formatDate(resultat.parametres.dateDepart)} au {formatDate(decalerDateISO(resultat.parametres.dateDepart, resultat.parametres.horizonJours))}
          </>
        )}
      </p>

      {etat.erreur && (
        <p className="login-erreur">
          {etat.erreur} {resultat ? "Le résultat affiché n'est plus à jour." : "Aucun résultat : cela ne signifie pas une absence de risque."}
        </p>
      )}
      {!resultat && etat.enCours && <p className="proba-attente">Analyse des encaissements critiques en cours…</p>}
      {resultat && (etat.aActualiser || etat.enCours) && !etat.erreur && <p className="proba-editeur__aide">Résultats en cours d&apos;actualisation…</p>}
      {resultat && (
        <div className="proba-risques__portee">
          {phrasesReference(resultat.reference).map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      )}
      {limites.length > 0 && (
        <ul className="proba-risques__limites" aria-label="Couverture de l'analyse">
          {resultat?.couverture.partielle && <li className="proba-risques__partielle">Analyse partielle</li>}
          {limites.map((l) => (
            <li key={l.type} className={l.type === "affichage" ? "proba-editeur__aide" : "fiabilite-alerte"}>
              <strong>{LIBELLES_LIMITE[l.type]} · </strong>
              {l.texte}
            </li>
          ))}
        </ul>
      )}
      {resultat && resultat.couverture.perimetre.aActualiser.length > 0 && (
        <div className="proba-risques__a-actualiser">
          <p className="proba-editeur__aide">Date d&apos;encaissement à actualiser :</p>
          <ul>
            {resultat.couverture.perimetre.aActualiser.map((f) => (
              <li key={f.cleLigne}>
                <span>
                  {nomFacture(f)} · {formatMontant(f.montant)} · {f.raison}
                </span>{" "}
                <button type="button" className="etage-pnl-outils__lien" onClick={() => onVoirFacture(f.numero ?? f.client)}>
                  Actualiser la date
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {resultat && (
        <div className={`proba-risques__liste${etat.aActualiser || etat.erreur ? " proba-risques__liste--perime" : ""}`}>
          {groupes.length === 0 ? (
            <p className="proba-vide">{messageSansAlerte(resultat.couverture)}</p>
          ) : (
            affiches.map((g) => <CarteGroupe key={g.id} groupe={g} dates={dates} onVoirFacture={onVoirFacture} />)
          )}
          {groupes.length > GROUPES_AFFICHES && (
            <button type="button" className="btn-secondaire" onClick={() => setToutes(!toutes)}>
              {toutes ? "Voir moins d'alertes" : `Voir toutes les alertes (${groupes.length})`}
            </button>
          )}
        </div>
      )}

      {resultat && (
        <details className="proba-risques__hypotheses">
          <summary>Hypothèses du calcul</summary>
          <ul>
            <li>
              Référence : la projection de Futur (solde initial de {formatMontant(resultat.parametres.soldeInitial)}), toutes les lignes prévues à leurs montants et dates
              prévus, conditions « Dépend de » évaluées.
            </li>
            <li>
              Test : seule la date d&apos;encaissement des factures testées change, jour par jour ; le chiffre d&apos;affaires reste compté à sa date prévue. Rien n&apos;est
              enregistré.
            </li>
            <li>Tension : solde de fin de journée strictement inférieur à 0 €. Le déficit est le montant à couvrir dans le scénario, pas une offre de financement.</li>
            <li>
              Duos : chaque facture a son propre retard ; pour chaque jour de tension possible, les deux encaissements sont testés juste après ce jour.
              {resultat.couverture.methode === "exacte" ? " Sans condition dépendant de la trésorerie, cette recherche couvre toutes les combinaisons de dates." : ""}
            </li>
            <li>
              {resultat.couverture.facturesAnalysees} facture{resultat.couverture.facturesAnalysees > 1 ? "s" : ""} à encaisser testée
              {resultat.couverture.facturesAnalysees > 1 ? "s" : ""} seule{resultat.couverture.facturesAnalysees > 1 ? "s" : ""} ; {resultat.couverture.pairesExplorees} paire
              {resultat.couverture.pairesExplorees > 1 ? "s" : ""} explorée{resultat.couverture.pairesExplorees > 1 ? "s" : ""} sur {resultat.couverture.pairesPossibles},{" "}
              {resultat.couverture.pairesEcarteesSansRisque} écartée{resultat.couverture.pairesEcarteesSansRisque > 1 ? "s" : ""} car incapable
              {resultat.couverture.pairesEcarteesSansRisque > 1 ? "s" : ""} de passer sous zéro.
            </li>
            {resultat.couverture.perimetre.enRetardEstimees > 0 && (
              <li>
                {resultat.couverture.perimetre.enRetardEstimees} facture{resultat.couverture.perimetre.enRetardEstimees > 1 ? "s" : ""} en retard placée
                {resultat.couverture.perimetre.enRetardEstimees > 1 ? "s" : ""} à une date estimée (médiane des paiements encore possibles selon l&apos;historique du client ou
                du compte) ; jamais d&apos;office au premier jour.
              </li>
            )}
            {resultat.couverture.perimetre.litigieusesExclues > 0 && (
              <li>
                {resultat.couverture.perimetre.litigieusesExclues} facture{resultat.couverture.perimetre.litigieusesExclues > 1 ? "s" : ""} litigieuse
                {resultat.couverture.perimetre.litigieusesExclues > 1 ? "s" : ""} : exclue{resultat.couverture.perimetre.litigieusesExclues > 1 ? "s" : ""} de la projection (règle
                existante de Futur), donc non testée{resultat.couverture.perimetre.litigieusesExclues > 1 ? "s" : ""}.
              </li>
            )}
            {resultat.couverture.perimetre.horsHorizon > 0 && (
              <li>
                {resultat.couverture.perimetre.horsHorizon} facture{resultat.couverture.perimetre.horsHorizon > 1 ? "s" : ""} encaissée
                {resultat.couverture.perimetre.horsHorizon > 1 ? "s" : ""} après la fin de l&apos;horizon dans la référence : aucun retard à tester.
              </li>
            )}
          </ul>
        </details>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Conteneur : requête au serveur (offre Pilotage revérifiée), résultat le plus récent seulement
// ---------------------------------------------------------------------------------------------

export default function GestionRisques({
  accessToken,
  actif,
  requete,
  onVoirFacture,
}: {
  accessToken: string | null;
  actif: boolean;
  requete: (Omit<RequeteRisques, "factures"> & { factures: FactureAnalysee[] }) | null;
  onVoirFacture: (terme: string) => void;
}) {
  const [etat, setEtat] = useState<EtatRisques>({ resultat: null, enCours: false, aActualiser: false, erreur: null });
  const numero = useRef(0);
  const controleur = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!actif || !accessToken || requete === null) return;
    // Données modifiées : le résultat affiché devient « à actualiser » jusqu'au nouveau calcul.
    setEtat((e) => (e.resultat ? { ...e, aActualiser: true } : e));
    const minuteur = setTimeout(() => {
      controleur.current?.abort();
      const c = new AbortController();
      controleur.current = c;
      const ce = ++numero.current;
      setEtat((e) => ({ ...e, enCours: true }));
      fetch("/api/futur/probabiliste/risques", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(requete),
        signal: c.signal,
      })
        .then(async (r) => {
          const corps = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(corps.error ?? "L'analyse des encaissements critiques n'a pas pu être calculée.");
          return corps as ReponseRisques;
        })
        .then((resultat) => {
          // Seule la requête la plus récente peut remplacer le résultat affiché.
          if (ce === numero.current) setEtat({ resultat, enCours: false, aActualiser: false, erreur: null });
        })
        .catch((e: Error) => {
          if (e.name === "AbortError" || ce !== numero.current) return;
          setEtat((x) => ({ ...x, enCours: false, erreur: e.message }));
        });
    }, DELAI_CALCUL_MS);
    return () => clearTimeout(minuteur);
  }, [actif, accessToken, requete]);

  return <GestionRisquesVue etat={etat} onVoirFacture={onVoirFacture} />;
}
