"use client";

import { useState } from "react";
import { formatDate, formatMontant } from "@/lib/format";
import type { SourceFlux } from "@/lib/cash-engine";
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
  HypotheseEffective,
  LigneHypothese,
  phraseARenseigner,
  resumeGroupe,
  correspondAuFiltre,
} from "@/lib/probaEcran";

export const LIBELLES_SOURCE: Record<SourceFlux, string> = {
  facture_client: "Facture client",
  facture_fournisseur: "Facture fournisseur",
  financement: "Financement",
  charge_fixe: "Charge fixe",
  autre_depense: "Autre dépense",
  rentree_reguliere: "Rentrée régulière",
};

type TypeCondition = "aucune" | ConditionSaisie["type"];
const LIBELLES_CONDITION: Record<TypeCondition, string> = {
  aucune: "Toujours",
  evenement: "Si une autre ligne se réalise",
  seuil: "Si un seuil est atteint",
  apres_evenement: "À partir du mois suivant une autre ligne",
};

interface HypothesesProbabilistesProps {
  lignes: LigneHypothese[];
  completude: Completude;
  // Montant de référence d'une rentrée régulière à montant fixe (valeur cible proposée), sinon absent.
  montantsFixes: ReadonlyMap<string, number>;
  // Lignes qui dépendent (directement ou non) de chaque ligne : on ne peut pas les choisir comme condition.
  descendantsDe: (cle: string) => ReadonlySet<string>;
  onModifier: (ligne: LigneHypothese, hypothese: HypotheseEffective) => void;
  desactive?: boolean;
}

/** Résumé court des incertitudes d'une ligne, en mots simples. */
export function resumeLigne(l: LigneHypothese): string {
  const dims = DIMENSIONS[l.source];
  const h = l.hypothese;
  const parties: string[] = [LIBELLES_PROBABILITE[h.probabilite]];
  if (dims.montant && h.fiabiliteMontant < 100) parties.push(`montant ±${Math.round(ECARTS_MONTANT[h.fiabiliteMontant] * 100)} %`);
  if (h.fiabiliteDate < 100) {
    parties.push(
      l.source === "facture_client" && h.fiabiliteDate === 50
        ? "date selon vos habitudes de paiement"
        : `${dims.date === "debut" ? "début" : "date"} ${LIBELLES_FIABILITE[h.fiabiliteDate].toLowerCase()}`
    );
  }
  if (h.condition) parties.push("conditionnelle");
  return parties.join(" · ");
}

function EditeurLigne({
  ligne,
  lignes,
  montantFixe,
  exclus,
  onModifier,
  desactive,
}: {
  ligne: LigneHypothese;
  lignes: LigneHypothese[];
  montantFixe: number | undefined;
  exclus: ReadonlySet<string>;
  onModifier: (h: HypotheseEffective) => void;
  desactive?: boolean;
}) {
  const dims = DIMENSIONS[ligne.source];
  const h = ligne.hypothese;
  const id = `hyp-${ligne.cle.replace(/[^\w-]/g, "_")}`;
  const [cible, setCible] = useState(h.montantCible !== null ? String(h.montantCible) : "");
  const seuilInitial = h.condition?.type === "seuil" ? String(h.condition.valeur) : "";
  const [seuil, setSeuil] = useState(seuilInitial);
  const changer = (c: Partial<HypotheseEffective>) => onModifier({ ...h, ...c });
  const autres = lignes.filter((l) => l.cle !== ligne.cle && !exclus.has(l.cle));
  const typeCondition: TypeCondition = h.condition?.type ?? "aucune";
  const cleParent = h.condition && h.condition.type !== "seuil" ? cleLigne(h.condition.source, h.condition.sourceId) : "";
  const montantReference = h.montantCible ?? montantFixe ?? (ligne.echeances > 0 ? ligne.impact / ligne.echeances : 0);
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
        <div className="proba-editeur__champ">
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
                onChange={(e) => setCible(e.target.value)}
                onBlur={() => {
                  const n = cible.trim() === "" ? null : lireNombre(cible);
                  if (n !== null && n <= 0) return setCible(h.montantCible !== null ? String(h.montantCible) : "");
                  if (n !== h.montantCible) changer({ montantCible: n });
                }}
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
          {ecart > 0 && montantReference > 0 && (
            <p className="proba-editeur__aide">
              8 fois sur 10 entre {formatMontant(montantReference * (1 - ecart))} et {formatMontant(montantReference * (1 + ecart))}
              {ligne.echeances > 1 ? " par échéance" : ""}
            </p>
          )}
        </div>
      )}

      <div className="proba-editeur__champ">
        <label htmlFor={`${id}-date`}>{dims.date === "debut" ? "Fiabilité de la date de début" : "Fiabilité de la date"}</label>
        <select id={`${id}-date`} value={h.fiabiliteDate} disabled={desactive} onChange={(e) => changer({ fiabiliteDate: Number(e.target.value) as FiabiliteDate })}>
          {FIABILITES.map((f) => (
            <option key={f} value={f}>
              {LIBELLES_FIABILITE[f]}
            </option>
          ))}
        </select>
        {h.fiabiliteDate < 100 && (
          <p className="proba-editeur__aide">
            {ligne.encaissement ? "Décalage tiré des habitudes de paiement de vos clients" : "Décalage tiré de vos habitudes de paiement fournisseurs"}
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

      {ligne.aRenseigner && (
        <div className="proba-editeur__valider">
          <button type="button" className="btn-secondaire" disabled={desactive} onClick={() => onModifier({ ...h })}>
            Valider ces hypothèses
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Pilotage des hypothèses de la prévision probabiliste : étages P&L repliables, résumés, lignes
 * les plus matérielles en premier, filtre par probabilité / « À renseigner ». Les détails ne
 * s'ouvrent que ligne par ligne (« Ajuster ») : pas de tableau géant.
 */
export default function HypothesesProbabilistes({ lignes, completude, montantsFixes, descendantsDe, onModifier, desactive }: HypothesesProbabilistesProps) {
  const [filtre, setFiltre] = useState<FiltreHypotheses>("toutes");
  const [replies, setReplies] = useState<Set<string>>(new Set());
  const [ouverte, setOuverte] = useState<string | null>(null);
  const groupes = grouperHypotheses(lignes, filtre);
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

      <div className="passe-tri selecteur" role="group" aria-label="Filtrer les hypothèses">
        {FILTRES_HYPOTHESES.map((f) => {
          const nombre = lignes.filter((l) => correspondAuFiltre(l, f.cle)).length;
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

      {groupes.length === 0 && <p className="proba-vide">Aucune hypothèse pour ce filtre.</p>}

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
                {g.lignes.map((l) => {
                  const edition = ouverte === l.cle;
                  return (
                    <li key={l.cle} className={`proba-ligne${l.aRenseigner ? " proba-ligne--a-renseigner" : ""}`}>
                      <div className="proba-ligne__resume">
                        <div className="proba-ligne__libelle">
                          <span>{l.libelle}</span>
                          <span className="proba-ligne__detail">
                            {LIBELLES_SOURCE[l.source]} · {formatDate(l.premiereDate)}
                            {l.echeances > 1 ? ` · ${l.echeances} échéances` : ""}
                          </span>
                        </div>
                        <span className={`proba-ligne__montant${l.encaissement ? " proba-montant--entree" : ""}`}>{formatMontant(l.encaissement ? l.impact : -l.impact)}</span>
                        <span className="proba-ligne__etat">
                          {l.aRenseigner ? (
                            <span className="proba-badge-renseigner">À renseigner{l.importante ? " · important" : ""}</span>
                          ) : (
                            resumeLigne(l)
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
                          onModifier={(h) => onModifier(l, h)}
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
