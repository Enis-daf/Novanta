"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CATALOGUE_KPI,
  CleKpiAuto,
  CLE_PERSONNALISE,
  CLES_KPI_AUTO,
  ChoixKpi,
  DonneesPasse,
  erreurCible,
  erreurCompositionKpis,
  formatJourLong,
  formatValeurKpi,
  KPI_NON_DISPONIBLES,
  libellePeriode,
  LIBELLES_FAMILLE,
  NOMBRE_KPI,
  periodesProposees,
  peutAjouterKpi,
  proposerReference,
  ReferenceProposee,
  Sens,
  TYPES_PERIODE,
  TypePeriode,
} from "@/lib/actionChantier";
import { KpiALancer } from "@/lib/actionRepository";
import { ConfigExercice } from "@/lib/fiscalPeriods";
import { MENTION_HT_ESTIME, MENTION_TTC } from "@/lib/format";
import { Periode } from "@/lib/pastTransactions";

const ETAPES = ["Priorité", "Période", "3 indicateurs", "Références et objectifs"] as const;

const LIBELLES_ORIGINE: Record<ReferenceProposee["origine"], string> = {
  equivalent: "Période équivalente passée",
  previous: "Dernière période complète comparable",
  indicative: "Référence indicative",
  situation: "Situation BFR validée",
  manual: "Saisie",
  none: "Aucune référence",
};

export interface ChantierALancer {
  titre: string;
  changement: string;
  typePeriode: TypePeriode;
  periode: Periode;
  kpis: KpiALancer[];
}

interface ActionCreationProps {
  aujourdhui: string;
  exercice: ConfigExercice;
  // Données du module Passé sur une fenêtre donnée (références historiques).
  chargerDonnees: (fenetre: Periode, avecBfr: boolean) => Promise<{ donnees: DonneesPasse; axeAConfigurer: boolean }>;
  lancer: (chantier: ChantierALancer) => Promise<void>;
  annuler?: () => void;
}

interface SaisiePersonnalisee {
  nom: string;
  unite: string;
  sens: Sens;
  reference: string;
}

function lireNombre(saisie: string): number | null {
  const nettoye = saisie.replace(/[\s  €%]/g, "").replace(",", ".");
  if (nettoye === "" || !/^-?\d+(\.\d+)?$/.test(nettoye)) return null;
  return Number(nettoye);
}

function uniteSaisie(cle: CleKpiAuto): string {
  return CATALOGUE_KPI[cle].unite === "pct" ? "%" : "€";
}

export default function ActionCreation({ aujourdhui, exercice, chargerDonnees, lancer, annuler }: ActionCreationProps) {
  const [etape, setEtape] = useState(0);
  const [titre, setTitre] = useState("");
  const [changement, setChangement] = useState("");
  const [typePeriode, setTypePeriode] = useState<TypePeriode>("quarter");
  const [choixPeriode, setChoixPeriode] = useState<"en_cours" | "suivante">("en_cours");
  const [choix, setChoix] = useState<ChoixKpi[]>([]);
  const [cibles, setCibles] = useState<Record<string, string>>({});
  const [personnalise, setPersonnalise] = useState<SaisiePersonnalisee>({ nom: "", unite: "", sens: "up", reference: "" });
  const [tentative, setTentative] = useState(false);
  const [lancement, setLancement] = useState<{ enCours: boolean; erreur: string | null }>({ enCours: false, erreur: null });

  const propositions = useMemo(() => periodesProposees(typePeriode, aujourdhui, exercice), [typePeriode, aujourdhui, exercice]);
  const periode = propositions.find((p) => p.cle === choixPeriode)!.periode;

  // Références : calculées à l'arrivée sur l'étape 4, sur l'année qui précède le chantier.
  const [references, setReferences] = useState<{
    etat: "attente" | "chargement" | "pret" | "erreur";
    parCle: Partial<Record<CleKpiAuto, ReferenceProposee>>;
    axeAConfigurer: boolean;
  }>({ etat: "attente", parCle: {}, axeAConfigurer: false });

  const clesAuto = choix.map((c) => c.cle).filter((c): c is CleKpiAuto => c !== CLE_PERSONNALISE);
  const cleReferences = `${periode.debut}|${periode.fin}|${clesAuto.join(",")}`;

  useEffect(() => {
    if (etape !== 3) return;
    if (clesAuto.length === 0) {
      setReferences({ etat: "pret", parCle: {}, axeAConfigurer: false });
      return;
    }
    let annule = false;
    setReferences((r) => ({ ...r, etat: "chargement" }));
    const debutFenetre = `${Number(periode.debut.slice(0, 4)) - 1}${periode.debut.slice(4)}`;
    const finFenetre = periode.debut <= aujourdhui ? periode.debut : aujourdhui;
    chargerDonnees({ debut: debutFenetre, fin: finFenetre }, clesAuto.includes("bfr"))
      .then(({ donnees, axeAConfigurer }) => {
        if (annule) return;
        const parCle: Partial<Record<CleKpiAuto, ReferenceProposee>> = {};
        for (const cle of clesAuto) {
          parCle[cle] = proposerReference(cle, typePeriode, periode, (p) => libellePeriode(typePeriode, p, exercice), donnees, aujourdhui);
        }
        setReferences({ etat: "pret", parCle, axeAConfigurer });
      })
      .catch((error) => {
        if (annule) return;
        console.error("[action/references] échec du chargement :", error);
        setReferences({ etat: "erreur", parCle: {}, axeAConfigurer: false });
      });
    return () => {
      annule = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [etape, cleReferences]);

  const basculer = (cle: ChoixKpi["cle"]) => {
    setChoix((courant) => (courant.some((c) => c.cle === cle) ? courant.filter((c) => c.cle !== cle) : peutAjouterKpi(courant, cle) ? [...courant, { cle }] : courant));
  };

  // --- Validation par étape ---
  const erreurPriorite =
    titre.trim() === "" ? "Nommez votre priorité." : changement.trim() === "" ? "Décrivez ce que vous changez concrètement." : null;
  const erreurKpis = erreurCompositionKpis(choix);

  const erreursObjectifs = useMemo(() => {
    const erreurs: Record<string, string> = {};
    for (const { cle } of choix) {
      if (cle === CLE_PERSONNALISE) {
        if (personnalise.nom.trim() === "") erreurs[cle] = "Nommez l'indicateur personnalisé.";
        else if (personnalise.unite.trim() === "") erreurs[cle] = "Précisez son unité (jours, clients, %…).";
        else if (lireNombre(personnalise.reference) === null) erreurs[cle] = "Saisissez sa valeur de référence.";
        else {
          const e = erreurCible(lireNombre(cibles[cle] ?? ""), personnalise.sens, lireNombre(personnalise.reference), "manuel");
          if (e) erreurs[cle] = e;
        }
        continue;
      }
      const reference = references.parCle[cle]?.valeur ?? null;
      const e = erreurCible(lireNombre(cibles[cle] ?? ""), CATALOGUE_KPI[cle].sens, reference, CATALOGUE_KPI[cle].nature);
      if (e) erreurs[cle] = e;
    }
    return erreurs;
  }, [choix, cibles, personnalise, references.parCle]);

  const erreurEtape = [erreurPriorite, null, erreurKpis, Object.keys(erreursObjectifs).length > 0 || references.etat !== "pret" ? "incomplet" : null][etape];

  const continuer = () => {
    setTentative(true);
    if (erreurEtape) return;
    setTentative(false);
    setEtape((e) => e + 1);
  };

  const lancerChantier = async () => {
    setTentative(true);
    if (erreurEtape || erreurKpis || erreurPriorite) return;
    setLancement({ enCours: true, erreur: null });
    const kpis: KpiALancer[] = choix.map(({ cle }, index) => {
      const position = (index + 1) as 1 | 2 | 3;
      if (cle === CLE_PERSONNALISE) {
        return {
          position,
          cle,
          nomPersonnalise: personnalise.nom.trim(),
          unitePersonnalisee: personnalise.unite.trim(),
          sens: personnalise.sens,
          reference: { valeur: lireNombre(personnalise.reference), libelle: "Saisie au lancement", origine: "manual", periode: null },
          cible: lireNombre(cibles[cle] ?? "") as number,
        };
      }
      const ref = references.parCle[cle]!;
      return {
        position,
        cle,
        nomPersonnalise: null,
        unitePersonnalisee: null,
        sens: CATALOGUE_KPI[cle].sens,
        reference: { valeur: ref.valeur, libelle: ref.libelle, origine: ref.origine, periode: ref.periode },
        cible: lireNombre(cibles[cle] ?? "") as number,
      };
    });
    try {
      await lancer({ titre: titre.trim(), changement: changement.trim(), typePeriode, periode, kpis });
    } catch (error) {
      setLancement({ enCours: false, erreur: error instanceof Error && error.message ? error.message : "Lancement impossible pour le moment." });
      return;
    }
    setLancement({ enCours: false, erreur: null });
  };

  return (
    <section className="action-creation" aria-label="Définir le chantier prioritaire">
      <ol className="action-etapes">
        {ETAPES.map((libelle, index) => (
          <li
            key={libelle}
            className={`action-etapes__etape${index === etape ? " action-etapes__etape--active" : ""}${index < etape ? " action-etapes__etape--faite" : ""}`}
            aria-current={index === etape ? "step" : undefined}
          >
            <span className="action-etapes__numero">{index + 1}</span>
            <span className="action-etapes__libelle">{libelle}</span>
          </li>
        ))}
      </ol>

      {etape === 0 && (
        <div className="action-creation__corps">
          <div className="action-champ">
            <label htmlFor="action-titre">Votre priorité</label>
            <input id="action-titre" type="text" maxLength={200} value={titre} placeholder="Ex. Remonter la marge contributive" onChange={(e) => setTitre(e.target.value)} />
          </div>
          <div className="action-champ">
            <label htmlFor="action-changement">Ce que vous changez concrètement</label>
            <textarea
              id="action-changement"
              maxLength={2000}
              rows={3}
              value={changement}
              placeholder="Ex. Hausse de 8 % des tarifs au 1er octobre, arrêt des remises au-delà de 10 %"
              onChange={(e) => setChangement(e.target.value)}
            />
          </div>
          <p className="passe-message">Un seul chantier à la fois : LE changement prioritaire pour la rentabilité.</p>
        </div>
      )}

      {etape === 1 && (
        <div className="action-creation__corps">
          <div className="selecteur" role="radiogroup" aria-label="Type de période">
            {TYPES_PERIODE.map((t) => (
              <button
                key={t.cle}
                type="button"
                role="radio"
                aria-checked={typePeriode === t.cle}
                className={`btn-secondaire${typePeriode === t.cle ? " btn-module--actif" : ""}`}
                onClick={() => setTypePeriode(t.cle)}
              >
                {t.libelle}
              </button>
            ))}
          </div>
          <div className="action-periodes" role="radiogroup" aria-label="Période du chantier">
            {propositions.map((p) => (
              <label key={p.cle} className={`action-option${choixPeriode === p.cle ? " action-option--choisie" : ""}`}>
                <input type="radio" name="action-periode" checked={choixPeriode === p.cle} onChange={() => setChoixPeriode(p.cle)} />
                <span className="action-option__texte">
                  <strong>
                    {p.libelle} {p.cle === "en_cours" ? "— en cours" : "— à venir"}
                  </strong>
                  <span>
                    Du {formatJourLong(p.periode.debut)} au {formatJourLong(p.periode.fin)}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {typePeriode !== "month" && <p className="passe-message">Trimestres, semestres et années suivent l'exercice de l'entreprise (réglé dans Passé).</p>}
        </div>
      )}

      {etape === 2 && (
        <div className="action-creation__corps">
          <p className="action-compteur">
            {choix.length} / {NOMBRE_KPI} indicateurs · au plus 1 personnalisé (saisie manuelle)
          </p>
          <div className="action-familles">
            {(["performance", "bfr"] as const).map((famille) => (
              <fieldset key={famille} className="action-famille">
                <legend>{LIBELLES_FAMILLE[famille]}</legend>
                {CLES_KPI_AUTO.filter((cle) => CATALOGUE_KPI[cle].famille === famille).map((cle) => {
                  const coche = choix.some((c) => c.cle === cle);
                  const possible = coche || peutAjouterKpi(choix, cle);
                  return (
                    <label key={cle} className={`action-option${coche ? " action-option--choisie" : ""}${possible ? "" : " action-option--inactive"}`}>
                      <input type="checkbox" checked={coche} disabled={!possible} onChange={() => basculer(cle)} />
                      <span className="action-option__texte">
                        <strong>{CATALOGUE_KPI[cle].libelle}</strong>
                        <span>{CATALOGUE_KPI[cle].description}</span>
                      </span>
                    </label>
                  );
                })}
                {KPI_NON_DISPONIBLES.filter((k) => k.famille === famille).map((k) => (
                  <div key={k.libelle} className="action-option action-option--indisponible" aria-disabled="true">
                    <input type="checkbox" disabled aria-label={`${k.libelle} — indisponible`} />
                    <span className="action-option__texte">
                      <strong>
                        {k.libelle} <span className="action-badge">Pas encore disponible</span>
                      </strong>
                      <span>{k.raison}</span>
                    </span>
                  </div>
                ))}
              </fieldset>
            ))}
            <fieldset className="action-famille">
              <legend>{LIBELLES_FAMILLE.custom}</legend>
              {(() => {
                const coche = choix.some((c) => c.cle === CLE_PERSONNALISE);
                const possible = coche || peutAjouterKpi(choix, CLE_PERSONNALISE);
                return (
                  <label className={`action-option${coche ? " action-option--choisie" : ""}${possible ? "" : " action-option--inactive"}`}>
                    <input type="checkbox" checked={coche} disabled={!possible} onChange={() => basculer(CLE_PERSONNALISE)} />
                    <span className="action-option__texte">
                      <strong>Indicateur personnalisé</strong>
                      <span>Un indicateur que Novanta ne calcule pas : vous le nommez et saisissez sa valeur chaque mois.</span>
                    </span>
                  </label>
                );
              })()}
            </fieldset>
          </div>
        </div>
      )}

      {etape === 3 && (
        <div className="action-creation__corps">
          <p className="passe-message">
            {libellePeriode(typePeriode, periode, exercice)} · du {formatJourLong(periode.debut)} au {formatJourLong(periode.fin)}. La cible est la valeur
            finale à atteindre : elle ne change pas pendant le chantier.
          </p>
          {references.etat === "chargement" && <p className="passe-message">Calcul des références historiques…</p>}
          {references.etat === "erreur" && <p className="login-erreur">Impossible de calculer les références pour le moment. Réessayez plus tard.</p>}
          {references.axeAConfigurer && (
            <p className="login-erreur">Plusieurs axes analytiques : choisissez-en un dans Passé › Correspondance P&L pour que Novanta calcule les indicateurs.</p>
          )}
          {references.etat === "pret" && (
            <div className="action-objectifs">
              {choix.map(({ cle }) =>
                cle === CLE_PERSONNALISE ? (
                  <ObjectifPersonnalise
                    key={cle}
                    saisie={personnalise}
                    onChange={setPersonnalise}
                    cible={cibles[cle] ?? ""}
                    onCible={(v) => setCibles((c) => ({ ...c, [cle]: v }))}
                    erreur={tentative ? erreursObjectifs[cle] : undefined}
                  />
                ) : (
                  <ObjectifAuto
                    key={cle}
                    cle={cle}
                    reference={references.parCle[cle]}
                    cible={cibles[cle] ?? ""}
                    onCible={(v) => setCibles((c) => ({ ...c, [cle]: v }))}
                    erreur={tentative ? erreursObjectifs[cle] : undefined}
                  />
                )
              )}
            </div>
          )}
        </div>
      )}

      {tentative && etape === 0 && erreurPriorite && <p className="login-erreur">{erreurPriorite}</p>}
      {tentative && etape === 2 && erreurKpis && <p className="login-erreur">{erreurKpis}</p>}
      {lancement.erreur && <p className="login-erreur">{lancement.erreur}</p>}

      <div className="action-creation__actions">
        {etape > 0 ? (
          <button type="button" className="btn-secondaire" onClick={() => setEtape((e) => e - 1)} disabled={lancement.enCours}>
            Retour
          </button>
        ) : (
          annuler && (
            <button type="button" className="btn-secondaire" onClick={annuler}>
              Annuler
            </button>
          )
        )}
        {etape < ETAPES.length - 1 ? (
          <button type="button" className="btn-add" onClick={continuer}>
            Continuer
          </button>
        ) : (
          <button type="button" className="btn-add" onClick={() => void lancerChantier()} disabled={lancement.enCours || references.etat !== "pret"}>
            {lancement.enCours ? "Lancement…" : "Lancer ce chantier"}
          </button>
        )}
      </div>
    </section>
  );
}

function ObjectifAuto({
  cle,
  reference,
  cible,
  onCible,
  erreur,
}: {
  cle: CleKpiAuto;
  reference: ReferenceProposee | undefined;
  cible: string;
  onCible: (v: string) => void;
  erreur?: string;
}) {
  const definition = CATALOGUE_KPI[cle];
  const id = `action-cible-${cle}`;
  const mention = cle === "bfr" ? "HT" : definition.base === "ttc" ? MENTION_TTC : MENTION_HT_ESTIME;
  return (
    <div className="action-objectif">
      <p className="action-objectif__nom">
        <strong>{definition.libelle}</strong>
        <span className="action-kpi__mention">
          {mention} · {definition.sens === "up" ? "plus haut = mieux" : "plus bas = mieux"}
        </span>
      </p>
      {reference && reference.valeur !== null ? (
        <p className="action-objectif__reference">
          Référence : <strong>{formatValeurKpi(reference.valeur, definition.unite)}</strong> — {reference.libelle}
          <span className={`action-badge${reference.origine === "indicative" ? "" : " action-badge--neutre"}`}>{LIBELLES_ORIGINE[reference.origine]}</span>
        </p>
      ) : (
        <p className="action-objectif__reference">Aucune référence — {reference?.raison ?? "historique insuffisant"}. L'atteinte ne sera pas calculable.</p>
      )}
      {reference?.avertissements.map((a) => (
        <p key={a} className="passe-message">
          {a}
        </p>
      ))}
      {definition.nature === "cumulatif" && (
        <p className="passe-message">Montant total visé sur la période. La progression se lit en cumul, depuis zéro.</p>
      )}
      <div className="action-champ action-champ--ligne">
        <label htmlFor={id}>Objectif</label>
        <span className="action-champ-unite">
          <input id={id} type="text" inputMode="decimal" value={cible} onChange={(e) => onCible(e.target.value)} aria-invalid={Boolean(erreur)} />
          <span>{uniteSaisie(cle)}</span>
        </span>
      </div>
      {erreur && <p className="login-erreur">{erreur}</p>}
    </div>
  );
}

function ObjectifPersonnalise({
  saisie,
  onChange,
  cible,
  onCible,
  erreur,
}: {
  saisie: SaisiePersonnalisee;
  onChange: (s: SaisiePersonnalisee) => void;
  cible: string;
  onCible: (v: string) => void;
  erreur?: string;
}) {
  return (
    <div className="action-objectif">
      <p className="action-objectif__nom">
        <strong>Indicateur personnalisé</strong>
        <span className="action-kpi__mention">Saisie manuelle chaque mois</span>
      </p>
      <div className="action-objectif__grille">
        <div className="action-champ">
          <label htmlFor="action-perso-nom">Nom</label>
          <input id="action-perso-nom" type="text" maxLength={80} value={saisie.nom} placeholder="Ex. Délai de livraison" onChange={(e) => onChange({ ...saisie, nom: e.target.value })} />
        </div>
        <div className="action-champ">
          <label htmlFor="action-perso-unite">Unité</label>
          <input id="action-perso-unite" type="text" maxLength={20} value={saisie.unite} placeholder="Ex. jours" onChange={(e) => onChange({ ...saisie, unite: e.target.value })} />
        </div>
        <div className="action-champ">
          <label htmlFor="action-perso-sens">Sens souhaité</label>
          <select id="action-perso-sens" value={saisie.sens} onChange={(e) => onChange({ ...saisie, sens: e.target.value as Sens })}>
            <option value="up">Plus haut = mieux</option>
            <option value="down">Plus bas = mieux</option>
          </select>
        </div>
        <div className="action-champ">
          <label htmlFor="action-perso-reference">Valeur de référence</label>
          <input id="action-perso-reference" type="text" inputMode="decimal" value={saisie.reference} onChange={(e) => onChange({ ...saisie, reference: e.target.value })} />
        </div>
        <div className="action-champ">
          <label htmlFor="action-perso-cible">Objectif</label>
          <input id="action-perso-cible" type="text" inputMode="decimal" value={cible} onChange={(e) => onCible(e.target.value)} aria-invalid={Boolean(erreur)} />
        </div>
      </div>
      {erreur && <p className="login-erreur">{erreur}</p>}
    </div>
  );
}
