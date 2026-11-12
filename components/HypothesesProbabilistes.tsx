"use client";

import { useState } from "react";
import BarreRecherche from "./BarreRecherche";
import { formatDate, formatMontant } from "@/lib/format";
import {
  Comparateur,
  ConditionSaisie,
  DECALAGE_MOIS_MAX,
  DIMENSIONS,
  ECARTS_MONTANT,
  FIABILITES,
  FiabiliteDate,
  FiabiliteMontant,
  INDICATEURS_SEUIL,
  IndicateurSeuil,
  LIBELLES_FIABILITE,
  LIBELLES_FIABILITE_MONTANT,
  LIBELLES_INDICATEUR,
  LIBELLES_PROBABILITE,
  PROBABILITES,
  ProbabiliteSaisie,
  UNITE_INDICATEUR,
  cleLigne,
} from "@/lib/probaEvenements";
import {
  Completude,
  FILTRES_HYPOTHESES,
  FiltreHypotheses,
  grouperHypotheses,
  correspondALaRecherche,
  LIBELLES_SOURCE,
  HypotheseEffective,
  LigneHypothese,
  phraseARenseigner,
  resumeGroupe,
  correspondAuFiltre,
} from "@/lib/probaEcran";

export { LIBELLES_SOURCE };

type TypeCondition = "aucune" | ConditionSaisie["type"];
const LIBELLES_CONDITION: Record<TypeCondition, string> = {
  aucune: "Toujours",
  evenement: "Si une autre ligne se réalise",
  seuil: "Si un seuil est atteint",
  apres_evenement: "À partir du mois suivant une autre ligne",
};

/** État de l'enregistrement d'une ligne (mêmes états que les autres saisies de Novanta). */
export interface EtatSauvegarde {
  enCours: boolean;
  erreur: string | null;
  ok: boolean;
}
const SAUVEGARDE_AU_REPOS: EtatSauvegarde = { enCours: false, erreur: null, ok: false };

/** Deux jeux d'hypothèses identiques ? (le brouillon diffère-t-il de ce qui est enregistré ?) */
export function memesHypotheses(a: HypotheseEffective, b: HypotheseEffective): boolean {
  return (
    a.probabilite === b.probabilite &&
    a.fiabiliteDate === b.fiabiliteDate &&
    a.fiabiliteMontant === b.fiabiliteMontant &&
    a.montantCible === b.montantCible &&
    JSON.stringify(a.condition) === JSON.stringify(b.condition)
  );
}

/** Certitude du montant telle que le moteur l'utilise ; un montant sans incertitude possible est « Certain ». */
export function libelleCertitudeMontant(l: LigneHypothese): string {
  return LIBELLES_FIABILITE_MONTANT[DIMENSIONS[l.source].montant ? l.hypothese.fiabiliteMontant : 100];
}

/** Certitude de la date telle que le moteur l'utilise (date d'échéance, ou début de la série). */
export function libelleCertitudeDate(l: LigneHypothese): string {
  return LIBELLES_FIABILITE[l.hypothese.fiabiliteDate];
}

interface HypothesesProbabilistesProps {
  lignes: LigneHypothese[];
  completude: Completude;
  // Montant de référence d'une rentrée régulière à montant fixe (valeur cible proposée), sinon absent.
  montantsFixes: ReadonlyMap<string, number>;
  // Lignes qui dépendent (directement ou non) de chaque ligne : on ne peut pas les choisir comme condition.
  descendantsDe: (cle: string) => ReadonlySet<string>;
  // Enregistre l'hypothèse ; rejette (avec le message à afficher) si l'enregistrement échoue.
  onEnregistrer: (ligne: LigneHypothese, hypothese: HypotheseEffective) => Promise<void>;
  desactive?: boolean;
}

function EditeurLigne({
  ligne,
  lignes,
  montantFixe,
  exclus,
  brouillon,
  onBrouillon,
  sauvegarde,
  onEnregistrer,
  desactive,
}: {
  ligne: LigneHypothese;
  lignes: LigneHypothese[];
  montantFixe: number | undefined;
  exclus: ReadonlySet<string>;
  brouillon: HypotheseEffective;
  onBrouillon: (h: HypotheseEffective) => void;
  sauvegarde: EtatSauvegarde;
  onEnregistrer: () => void;
  desactive?: boolean;
}) {
  const dims = DIMENSIONS[ligne.source];
  const h = brouillon;
  const modifie = !memesHypotheses(brouillon, ligne.hypothese);
  // Une ligne « À renseigner » s'enregistre même inchangée : l'enregistrement vaut validation.
  const enregistrable = (modifie || ligne.aRenseigner) && !sauvegarde.enCours && !desactive;
  const id = `hyp-${ligne.cle.replace(/[^\w-]/g, "_")}`;
  const [cible, setCible] = useState(h.montantCible !== null ? String(h.montantCible) : "");
  const seuilInitial = h.condition?.type === "seuil" ? String(h.condition.valeur) : "";
  const [seuil, setSeuil] = useState(seuilInitial);
  // Chaque changement reste local (brouillon) : rien n'est enregistré avant « Enregistrer ».
  const changer = (c: Partial<HypotheseEffective>) => onBrouillon({ ...h, ...c });
  const autres = lignes.filter((l) => l.cle !== ligne.cle && !exclus.has(l.cle));
  const typeCondition: TypeCondition = h.condition?.type ?? "aucune";
  const cleParent = h.condition && h.condition.type !== "seuil" ? cleLigne(h.condition.source, h.condition.sourceId) : "";
  // Valeur autour de laquelle le moteur fait varier le montant : la valeur cible du brouillon (rentrée
  // régulière à montant fixe), sinon le montant de chaque échéance retenu par la prévision.
  const montantReference = h.montantCible ?? (montantFixe !== undefined ? montantFixe : ligne.montantParEcheance);
  const parEcheance = ligne.echeances > 1 ? " par échéance" : "";
  const ecart = ECARTS_MONTANT[h.fiabiliteMontant];
  const lireNombre = (texte: string) => {
    const n = Number(texte.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };

  return (
    <div className="proba-editeur">
      <div className="proba-editeur__champ">
        <label htmlFor={`${id}-proba`}>Probabilité</label>
        <select id={`${id}-proba`} value={h.probabilite} disabled={desactive} onChange={(e) => changer({ probabilite: Number(e.target.value) as ProbabiliteSaisie })}>
          {PROBABILITES.map((p) => (
            <option key={p} value={p}>
              {LIBELLES_PROBABILITE[p]} ({p} %)
            </option>
          ))}
        </select>
      </div>

      {dims.montant && (
        <div className="proba-editeur__champ proba-editeur__bloc">
          <p className="proba-editeur__reference">
            <span>Montant prévu</span>
            <strong>
              {montantReference !== null
                ? `${formatMontant(montantReference)}${parEcheance}`
                : `${formatMontant(ligne.impact)} sur l'horizon, en ${ligne.echeances} échéances de montants variables`}
            </strong>
          </p>
          {montantFixe !== undefined && (
            <>
              <label htmlFor={`${id}-cible`}>Montant cible par échéance</label>
              <input
                id={`${id}-cible`}
                type="text"
                inputMode="decimal"
                placeholder={formatMontant(montantFixe)}
                value={cible}
                disabled={desactive}
                onChange={(e) => {
                  setCible(e.target.value);
                  // La nouvelle valeur s'affiche aussitôt comme référence ; rien n'est enregistré.
                  const n = e.target.value.trim() === "" ? null : lireNombre(e.target.value);
                  if ((n === null && e.target.value.trim() === "") || (n !== null && n > 0)) changer({ montantCible: n });
                }}
                onBlur={() => setCible(h.montantCible !== null ? String(h.montantCible) : "")}
              />
            </>
          )}
          <label htmlFor={`${id}-montant`}>Certitude du montant</label>
          <select id={`${id}-montant`} value={h.fiabiliteMontant} disabled={desactive} onChange={(e) => changer({ fiabiliteMontant: Number(e.target.value) as FiabiliteMontant })}>
            {FIABILITES.map((f) => (
              <option key={f} value={f}>
                {LIBELLES_FIABILITE_MONTANT[f]}
              </option>
            ))}
          </select>
          {ecart > 0 && montantReference !== null && montantReference > 0 && (
            <p className="proba-editeur__aide">
              8 fois sur 10 entre {formatMontant(montantReference * (1 - ecart))} et {formatMontant(montantReference * (1 + ecart))}
              {parEcheance}
            </p>
          )}
        </div>
      )}

      <div className="proba-editeur__champ proba-editeur__bloc">
        <p className="proba-editeur__reference">
          <span>{dims.date === "debut" ? "Début prévu" : "Date prévue"}</span>
          <strong>
            {formatDate(ligne.premiereDate)}
            {ligne.echeances > 1 ? `, puis ${ligne.echeances - 1} échéance${ligne.echeances > 2 ? "s" : ""}` : ""}
          </strong>
          {ligne.dateEcheance && ligne.dateEcheance < ligne.premiereDate && (
            <span className="proba-editeur__aide">Échéance de la facture : {formatDate(ligne.dateEcheance)}</span>
          )}
        </p>
        <label htmlFor={`${id}-date`}>{dims.date === "debut" ? "Certitude de la date de début" : "Certitude de la date"}</label>
        <select id={`${id}-date`} value={h.fiabiliteDate} disabled={desactive} onChange={(e) => changer({ fiabiliteDate: Number(e.target.value) as FiabiliteDate })}>
          {FIABILITES.map((f) => (
            <option key={f} value={f}>
              {LIBELLES_FIABILITE[f]}
            </option>
          ))}
        </select>
        {h.fiabiliteDate < 100 && (
          <p className="proba-editeur__aide">
            {ligne.dateEcheance && ligne.dateEcheance < ligne.premiereDate
              ? "Décalage tiré de l'historique à partir de l'échéance, jamais avant la date prévue"
              : `Décalage tiré de l'historique, jamais avant la ${dims.date === "debut" ? "date de début prévue" : "date prévue"}`}
            {ligne.encaissement ? " (habitudes de paiement de vos clients)" : " (vos habitudes de paiement fournisseurs)"}
            {dims.date === "debut" ? " ; une fois démarrée, la série suit sa fréquence." : "."}
          </p>
        )}
      </div>

      <div className="proba-editeur__champ proba-editeur__champ--large">
        <label htmlFor={`${id}-condition`}>Dépend de</label>
        <select
          id={`${id}-condition`}
          value={typeCondition}
          disabled={desactive}
          onChange={(e) => {
            const type = e.target.value as TypeCondition;
            if (type === "aucune") return changer({ condition: null });
            if (type === "seuil") return changer({ condition: { type: "seuil", indicateur: "ca_mois_precedent", comparateur: ">", valeur: 0 } });
            const premier = autres[0];
            if (!premier) return;
            changer({
              condition:
                type === "evenement"
                  ? { type: "evenement", source: premier.source, sourceId: premier.sourceId }
                  : { type: "apres_evenement", source: premier.source, sourceId: premier.sourceId, decalageMois: 0 },
            });
          }}
        >
          {(Object.keys(LIBELLES_CONDITION) as TypeCondition[]).map((t) => (
            <option key={t} value={t} disabled={(t === "evenement" || t === "apres_evenement") && autres.length === 0}>
              {LIBELLES_CONDITION[t]}
            </option>
          ))}
        </select>

        {h.condition && h.condition.type !== "seuil" && (
          <select
            aria-label="Ligne dont elle dépend"
            value={cleParent}
            disabled={desactive}
            onChange={(e) => {
              const cible = autres.find((l) => l.cle === e.target.value);
              if (!cible || !h.condition || h.condition.type === "seuil") return;
              changer({ condition: { ...h.condition, source: cible.source, sourceId: cible.sourceId } });
            }}
          >
            {!autres.some((l) => l.cle === cleParent) && <option value={cleParent}>Ligne hors de l&apos;horizon</option>}
            {autres.map((l) => (
              <option key={l.cle} value={l.cle}>
                {l.libelle}
              </option>
            ))}
          </select>
        )}
        {h.condition?.type === "apres_evenement" && (
          <label className="proba-editeur__inline">
            + mois
            <input
              type="number"
              min={0}
              max={DECALAGE_MOIS_MAX}
              value={h.condition.decalageMois}
              disabled={desactive}
              onChange={(e) => {
                const n = Math.min(DECALAGE_MOIS_MAX, Math.max(0, Math.floor(Number(e.target.value) || 0)));
                if (h.condition?.type === "apres_evenement") changer({ condition: { ...h.condition, decalageMois: n } });
              }}
            />
          </label>
        )}
        {h.condition?.type === "seuil" && (
          <span className="proba-editeur__seuil">
            <select
              aria-label="Indicateur"
              value={h.condition.indicateur}
              disabled={desactive}
              onChange={(e) => h.condition?.type === "seuil" && changer({ condition: { ...h.condition, indicateur: e.target.value as IndicateurSeuil } })}
            >
              {INDICATEURS_SEUIL.map((i) => (
                <option key={i} value={i}>
                  {LIBELLES_INDICATEUR[i]}
                </option>
              ))}
            </select>
            <select
              aria-label="Comparaison"
              value={h.condition.comparateur}
              disabled={desactive}
              onChange={(e) => h.condition?.type === "seuil" && changer({ condition: { ...h.condition, comparateur: e.target.value as Comparateur } })}
            >
              <option value=">">supérieur à</option>
              <option value="<">inférieur à</option>
            </select>
            <input
              aria-label="Seuil"
              type="text"
              inputMode="decimal"
              value={seuil}
              disabled={desactive}
              onChange={(e) => setSeuil(e.target.value)}
              onBlur={() => {
                const n = lireNombre(seuil);
                if (n === null || h.condition?.type !== "seuil") return setSeuil(seuilInitial);
                if (n !== h.condition.valeur) changer({ condition: { ...h.condition, valeur: n } });
              }}
            />
            <span>{UNITE_INDICATEUR[h.condition.indicateur]}</span>
          </span>
        )}
      </div>

      <div className="proba-editeur__valider">
        <button type="button" className="btn-add" disabled={!enregistrable} onClick={onEnregistrer}>
          {sauvegarde.enCours ? "Enregistrement…" : "Enregistrer"}
        </button>
        {modifie && !sauvegarde.enCours && <p className="proba-editeur__aide">Modifications non enregistrées</p>}
        {sauvegarde.erreur && <p className="login-erreur">{sauvegarde.erreur}</p>}
        {sauvegarde.ok && !modifie && <p className="passe-message">Hypothèse enregistrée.</p>}
      </div>
    </div>
  );
}

/**
 * Pilotage des hypothèses de la prévision probabiliste : étages P&L repliables, résumés, lignes
 * les plus matérielles en premier, filtre par probabilité / « À renseigner ». Les détails ne
 * s'ouvrent que ligne par ligne (« Ajuster ») : pas de tableau géant.
 */
export default function HypothesesProbabilistes({ lignes, completude, montantsFixes, descendantsDe, onEnregistrer, desactive }: HypothesesProbabilistesProps) {
  const [filtre, setFiltre] = useState<FiltreHypotheses>("toutes");
  // Recherche locale : les lignes sont déjà dans le navigateur, aucune requête réseau.
  const [recherche, setRecherche] = useState("");
  const [replies, setReplies] = useState<Set<string>>(new Set());
  const [ouverte, setOuverte] = useState<string | null>(null);
  // Brouillons par ligne : conservés si l'on ferme la ligne ou change de filtre, jusqu'à « Enregistrer ».
  // Les filtres lisent l'état ENREGISTRÉ : une ligne ne quitte « À renseigner » qu'après un
  // enregistrement réussi.
  const [brouillons, setBrouillons] = useState<Map<string, HypotheseEffective>>(new Map());
  const [sauvegardes, setSauvegardes] = useState<Map<string, EtatSauvegarde>>(new Map());
  const majCle = <T,>(setter: (f: (m: Map<string, T>) => Map<string, T>) => void, cle: string, valeur: T | null) =>
    setter((m) => {
      const suivante = new Map(m);
      if (valeur === null) suivante.delete(cle);
      else suivante.set(cle, valeur);
      return suivante;
    });
  const enregistrer = (l: LigneHypothese) => {
    const h = brouillons.get(l.cle) ?? l.hypothese;
    majCle(setSauvegardes, l.cle, { enCours: true, erreur: null, ok: false });
    onEnregistrer(l, h).then(
      () => {
        majCle(setBrouillons, l.cle, null);
        majCle(setSauvegardes, l.cle, { enCours: false, erreur: null, ok: true });
      },
      (e: unknown) =>
        majCle(setSauvegardes, l.cle, { enCours: false, erreur: e instanceof Error ? e.message : "L'hypothèse n'a pas pu être enregistrée.", ok: false })
    );
  };
  const groupes = grouperHypotheses(lignes, filtre, recherche);
  const aRenseigner = phraseARenseigner(completude);

  if (lignes.length === 0) {
    return <p className="proba-vide">Aucun flux sur l&apos;horizon : ajoutez des lignes dans « Flux de tréso » pour construire la prévision.</p>;
  }

  return (
    <div className="proba-hypotheses">
      <div className="proba-hypotheses__entete">
        {aRenseigner ? (
          <button
            type="button"
            className={`proba-a-renseigner${filtre === "a_renseigner" ? " proba-a-renseigner--actif" : ""}`}
            aria-pressed={filtre === "a_renseigner"}
            onClick={() => setFiltre(filtre === "a_renseigner" ? "toutes" : "a_renseigner")}
          >
            <strong>{aRenseigner}</strong>
            <span>
              {completude.importantesARenseigner > 0
                ? `dont ${completude.importantesARenseigner} importante${completude.importantesARenseigner > 1 ? "s" : ""}`
                : "toutes secondaires"}
            </span>
          </button>
        ) : (
          <p className="proba-a-renseigner proba-a-renseigner--complet">Toutes les hypothèses sont renseignées</p>
        )}
        <p className="proba-hypotheses__compte">
          {lignes.length} hypothèse{lignes.length > 1 ? "s" : ""} · {completude.incertaines} incertaine{completude.incertaines > 1 ? "s" : ""}
        </p>
      </div>

      <div className="barre-outils-recherche proba-recherche">
        <BarreRecherche valeur={recherche} onChange={setRecherche} placeholder="Rechercher une transaction…" />
      </div>

      <div className="passe-tri selecteur" role="group" aria-label="Filtrer les hypothèses">
        {FILTRES_HYPOTHESES.map((f) => {
          const nombre = lignes.filter((l) => correspondAuFiltre(l, f.cle) && correspondALaRecherche(l, recherche)).length;
          return (
            <button
              key={String(f.cle)}
              type="button"
              className={`btn-secondaire${filtre === f.cle ? " btn-module--actif" : ""}`}
              aria-pressed={filtre === f.cle}
              onClick={() => setFiltre(f.cle)}
            >
              {f.libelle}<span className="passe-detail__compte proba-filtre-compte">{nombre}</span>
            </button>
          );
        })}
      </div>

      {groupes.length === 0 && (
        <p className="proba-vide">{recherche.trim() ? "Aucune transaction ne correspond à votre recherche." : "Aucune hypothèse pour ce filtre."}</p>
      )}

      {groupes.map((g) => {
        const replie = replies.has(g.cle);
        return (
          <section key={g.cle} className="proba-groupe" aria-label={g.libelle}>
            <button
              type="button"
              className="proba-groupe__titre"
              aria-expanded={!replie}
              onClick={() => {
                const suivant = new Set(replies);
                if (replie) suivant.delete(g.cle);
                else suivant.add(g.cle);
                setReplies(suivant);
              }}
            >
              <span className={`section-titre__chevron${replie ? "" : " section-titre__chevron--ouvert"}`} aria-hidden>
                ▾
              </span>
              <span className="proba-groupe__resume">{resumeGroupe(g)}</span>
            </button>
            {!replie && (
              <ul className="proba-groupe__lignes">
                <li className="proba-ligne__resume proba-ligne__entete" aria-hidden>
                  <span>Ligne</span>
                  <span>Montant</span>
                  <span>Certitude du montant</span>
                  <span>Date</span>
                  <span>Certitude de la date</span>
                  <span>Probabilité</span>
                  <span />
                </li>
                {g.lignes.map((l) => {
                  const edition = ouverte === l.cle;
                  const brouillon = brouillons.get(l.cle);
                  const nonEnregistree = brouillon !== undefined && !memesHypotheses(brouillon, l.hypothese);
                  return (
                    <li key={l.cle} className={`proba-ligne${l.aRenseigner ? " proba-ligne--a-renseigner" : ""}`}>
                      <div className="proba-ligne__resume">
                        <div className="proba-ligne__libelle">
                          <span>{l.libelle}</span>
                          <span className="proba-ligne__detail">
                            {LIBELLES_SOURCE[l.source]}
                            {nonEnregistree ? " · modifications non enregistrées" : ""}
                          </span>
                        </div>
                        <span className={`proba-ligne__montant${l.encaissement ? " proba-montant--entree" : ""}`}>{formatMontant(l.encaissement ? l.impact : -l.impact)}</span>
                        <span className="proba-ligne__etat" data-colonne="Certitude du montant">
                          {libelleCertitudeMontant(l)}
                        </span>
                        <span className="proba-ligne__etat" data-colonne="Date">
                          {formatDate(l.premiereDate)}
                          {l.echeances > 1 && <span className="proba-ligne__detail">{DIMENSIONS[l.source].date === "debut" ? "début · " : ""}{l.echeances} échéances</span>}
                        </span>
                        <span
                          className="proba-ligne__etat"
                          data-colonne="Certitude de la date"
                          title={l.source === "facture_client" && l.hypothese.fiabiliteDate === 50 ? "Selon les habitudes de paiement de vos clients" : undefined}
                        >
                          {libelleCertitudeDate(l)}
                        </span>
                        <span className="proba-ligne__etat" data-colonne="Probabilité">
                          {l.aRenseigner ? (
                            <span className="proba-badge-renseigner">À renseigner{l.importante ? " · important" : ""}</span>
                          ) : (
                            `${LIBELLES_PROBABILITE[l.hypothese.probabilite]}${l.hypothese.condition ? " · sous condition" : ""}`
                          )}
                        </span>
                        <button type="button" className="etage-pnl-outils__lien" aria-expanded={edition} onClick={() => setOuverte(edition ? null : l.cle)}>
                          {edition ? "Fermer" : l.aRenseigner ? "Renseigner" : "Ajuster"}
                        </button>
                      </div>
                      {edition && (
                        <EditeurLigne
                          ligne={l}
                          lignes={lignes}
                          montantFixe={montantsFixes.get(l.cle)}
                          exclus={descendantsDe(l.cle)}
                          brouillon={brouillon ?? l.hypothese}
                          onBrouillon={(h) => {
                            majCle(setBrouillons, l.cle, h);
                            majCle(setSauvegardes, l.cle, null);
                          }}
                          sauvegarde={sauvegardes.get(l.cle) ?? SAUVEGARDE_AU_REPOS}
                          onEnregistrer={() => enregistrer(l)}
                          desactive={desactive}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
