"use client";

import { useMemo, useState } from "react";
import { FactureClient, TriMode } from "@/lib/types";
import { estDateValide, formatDateCourte, parseDateISO, trierParDate, trierParMontant } from "@/lib/dates";
import { formatMontant } from "@/lib/format";
import { filtrerFacturesPrevisionnelles } from "@/lib/recherche";
import { OccurrencesParId } from "@/lib/periodeFiltre";
import {
  estPrevisionnelleActive,
  FacturePrevisionnelle,
  facturesRapprochables,
  libelleStatut,
  SuggestionPrevisionnelle,
} from "@/lib/facturesPrevisionnelles";
import DateField from "./DateField";

interface FacturesPrevisionnellesTableProps {
  previsionnelles: FacturePrevisionnelle[];
  factures: FactureClient[]; // vraies factures clients
  onChange: (id: string, patch: Partial<Pick<FacturePrevisionnelle, "client" | "montant" | "dateFacturationPrevue" | "dateEncaissementPrevue">>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onRapprocher: (previsionnelleId: string, factureClientId: string) => void;
  onAnnulerRapprochement: (previsionnelleId: string) => void;
  // Suggestions issues de la dernière synchronisation Pennylane (vide tant qu'aucune n'a eu lieu).
  suggestions: SuggestionPrevisionnelle[];
  onIgnorer: (factureClientId: string, previsionnelleIds: string[]) => void;
  recherche: string;
  tri: TriMode;
  dateReleve: string;
  filtrePeriode?: OccurrencesParId | null;
}

function BlocFacture({ facture }: { facture: FactureClient }) {
  return (
    <div className="rapprochement-cote">
      <span className="rapprochement-cote__titre">Facture émise</span>
      <strong>{facture.client || "Client non renseigné"}</strong>
      <span>{formatMontant(facture.montant)}</span>
      <span className="rapprochement-cote__detail">
        {facture.facture ? `N° ${facture.facture} · ` : ""}
        {estDateValide(facture.dateEcheance) ? `échéance le ${formatDateCourte(facture.dateEcheance)}` : "sans échéance"}
        {facture.payee ? " · payée" : ""}
      </span>
    </div>
  );
}

function detailPrevisionnelle(p: FacturePrevisionnelle): string {
  const morceaux = [
    estDateValide(p.dateFacturationPrevue) ? `facturation prévue le ${formatDateCourte(p.dateFacturationPrevue)}` : null,
    estDateValide(p.dateEncaissementPrevue) ? `encaissement prévu le ${formatDateCourte(p.dateEncaissementPrevue)}` : null,
  ].filter(Boolean);
  return morceaux.length > 0 ? morceaux.join(" · ") : "sans date";
}

/** « Cette facture semble correspondre à une facture prévisionnelle. » — jamais appliqué sans « Rapprocher ». */
function CarteSuggestion({
  suggestion,
  facture,
  previsionnelles,
  onRapprocher,
  onIgnorer,
}: {
  suggestion: SuggestionPrevisionnelle;
  facture: FactureClient;
  previsionnelles: FacturePrevisionnelle[];
  onRapprocher: FacturesPrevisionnellesTableProps["onRapprocher"];
  onIgnorer: FacturesPrevisionnellesTableProps["onIgnorer"];
}) {
  const candidates = suggestion.candidats
    .map((c) => previsionnelles.find((p) => p.id === c.previsionnelleId))
    .filter((p): p is FacturePrevisionnelle => Boolean(p));
  const ambigue = candidates.length > 1;
  // Ambiguïté : rien n'est présélectionné, l'utilisateur désigne lui-même la bonne prévisionnelle.
  const [choix, setChoix] = useState<string | null>(ambigue ? null : (candidates[0]?.id ?? null));
  if (candidates.length === 0) return null;

  return (
    <li className="rapprochement-carte">
      <p className="rapprochement-carte__contexte">
        {ambigue
          ? "Cette facture semble correspondre à plusieurs factures prévisionnelles : choisissez la bonne."
          : "Cette facture semble correspondre à une facture prévisionnelle."}
      </p>
      <div className="rapprochement-carte__paire">
        <BlocFacture facture={facture} />
        <div className="rapprochement-cote">
          <span className="rapprochement-cote__titre">{ambigue ? "Factures prévisionnelles" : "Facture prévisionnelle"}</span>
          {ambigue ? (
            candidates.map((p) => (
              <label key={p.id} className="rapprochement-choix">
                <input type="radio" name={`previsionnelle-${facture.id}`} checked={choix === p.id} onChange={() => setChoix(p.id)} />
                <span>
                  <strong>{p.client || "Sans libellé"}</strong> · {formatMontant(p.montant)} · {detailPrevisionnelle(p)}
                </span>
              </label>
            ))
          ) : (
            <>
              <strong>{candidates[0].client || "Sans libellé"}</strong>
              <span>{formatMontant(candidates[0].montant)}</span>
              <span className="rapprochement-cote__detail">{detailPrevisionnelle(candidates[0])}</span>
            </>
          )}
        </div>
      </div>
      <div className="rapprochement-carte__actions">
        <button type="button" className="btn-add" disabled={choix === null} onClick={() => choix && onRapprocher(choix, facture.id)}>
          Rapprocher
        </button>
        <button type="button" className="btn-secondaire" onClick={() => onIgnorer(facture.id, candidates.map((p) => p.id))}>
          Ignorer
        </button>
      </div>
    </li>
  );
}

/** « Rapprocher d'une facture émise » : l'utilisateur choisit la vraie facture, sans seuil. */
function RapprochementManuel({
  previsionnelle,
  choixPossibles,
  onRapprocher,
  onAnnuler,
}: {
  previsionnelle: FacturePrevisionnelle;
  choixPossibles: FactureClient[];
  onRapprocher: FacturesPrevisionnellesTableProps["onRapprocher"];
  onAnnuler: () => void;
}) {
  const [factureId, setFactureId] = useState("");
  const facture = choixPossibles.find((f) => f.id === factureId) ?? null;
  return (
    <div className="rapprochement-carte">
      <p className="rapprochement-carte__contexte">Rapprocher d&apos;une facture émise</p>
      <div className="rapprochement-carte__paire">
        <div className="rapprochement-cote">
          <span className="rapprochement-cote__titre">Facture prévisionnelle</span>
          <strong>{previsionnelle.client || "Sans libellé"}</strong>
          <span>{formatMontant(previsionnelle.montant)}</span>
          <span className="rapprochement-cote__detail">{detailPrevisionnelle(previsionnelle)}</span>
        </div>
        <div className="rapprochement-cote">
          <span className="rapprochement-cote__titre">Facture émise</span>
          <select value={factureId} onChange={(e) => setFactureId(e.target.value)}>
            <option value="">Choisir une facture client…</option>
            {choixPossibles.map((f) => (
              <option key={f.id} value={f.id}>
                {[f.facture || "Sans n°", f.client || "Client non renseigné", formatMontant(f.montant), estDateValide(f.dateEcheance) ? formatDateCourte(f.dateEcheance) : null]
                  .filter(Boolean)
                  .join(" · ")}
              </option>
            ))}
          </select>
          {choixPossibles.length === 0 && <span className="rapprochement-cote__detail">Aucune facture client disponible.</span>}
        </div>
      </div>
      {facture && (
        <p className="rapprochement-cote__detail">
          La prévisionnelle sera conservée mais ne comptera plus : seule la facture {facture.facture || "choisie"} ({formatMontant(facture.montant)}) comptera.
        </p>
      )}
      <div className="rapprochement-carte__actions">
        <button type="button" className="btn-add" disabled={!facture} onClick={() => facture && onRapprocher(previsionnelle.id, facture.id)}>
          Confirmer le rapprochement
        </button>
        <button type="button" className="btn-secondaire" onClick={onAnnuler}>
          Annuler
        </button>
      </div>
    </div>
  );
}

/**
 * Factures prévisionnelles : factures que l'entreprise prévoit d'émettre. Une prévisionnelle « À
 * facturer » compte à sa date d'encaissement prévue ; une prévisionnelle « Facturée » (rapprochée
 * d'une vraie facture) reste affichée, grisée, et ne compte plus.
 */
export default function FacturesPrevisionnellesTable({
  previsionnelles,
  factures,
  onChange,
  onAdd,
  onRemove,
  onRapprocher,
  onAnnulerRapprochement,
  suggestions,
  onIgnorer,
  recherche,
  tri,
  dateReleve,
  filtrePeriode,
}: FacturesPrevisionnellesTableProps) {
  const [manuelleId, setManuelleId] = useState<string | null>(null);

  const triees = useMemo(() => {
    const dansPeriode = filtrePeriode ? previsionnelles.filter((p) => filtrePeriode.has(p.id)) : previsionnelles;
    const filtrees = filtrerFacturesPrevisionnelles(dansPeriode, recherche);
    return tri === "montant" ? trierParMontant(filtrees, (p) => p.montant) : trierParDate(filtrees, (p) => p.dateEncaissementPrevue);
  }, [previsionnelles, recherche, tri, filtrePeriode]);

  const suggestionsVisibles = suggestions
    .map((suggestion) => ({ suggestion, facture: factures.find((f) => f.id === suggestion.factureClientId) }))
    .filter((s): s is { suggestion: SuggestionPrevisionnelle; facture: FactureClient } => Boolean(s.facture));

  const manuelle = manuelleId ? previsionnelles.find((p) => p.id === manuelleId && estPrevisionnelleActive(p)) ?? null : null;
  const filtreActif = !!recherche || !!filtrePeriode;
  const debutProjection = estDateValide(dateReleve) ? parseDateISO(dateReleve) : null;

  return (
    <div className="table-wrapper table-wrapper--previsionnelles" id="factures-previsionnelles">
      <h3>Factures prévisionnelles</h3>
      <p className="table-wrapper__intro">
        Factures à émettre, pas encore réelles. Elles comptent à leur date d&apos;encaissement prévue jusqu&apos;à leur rapprochement avec la
        facture émise.
      </p>

      {suggestionsVisibles.length > 0 && (
        <ul className="rapprochement__liste rapprochement__liste--previsionnelles">
          {suggestionsVisibles.map(({ suggestion, facture }) => (
            <CarteSuggestion
              key={`${suggestion.factureClientId}-${suggestion.candidats.map((c) => c.previsionnelleId).join("-")}`}
              suggestion={suggestion}
              facture={facture}
              previsionnelles={previsionnelles}
              onRapprocher={onRapprocher}
              onIgnorer={onIgnorer}
            />
          ))}
        </ul>
      )}

      {manuelle && (
        <RapprochementManuel
          key={manuelle.id}
          previsionnelle={manuelle}
          choixPossibles={facturesRapprochables(manuelle, previsionnelles, factures)}
          onRapprocher={(previsionnelleId, factureId) => {
            onRapprocher(previsionnelleId, factureId);
            setManuelleId(null);
          }}
          onAnnuler={() => setManuelleId(null)}
        />
      )}

      {filtreActif && triees.length === 0 ? (
        <p className="recherche-vide">Aucun résultat dans cette section</p>
      ) : triees.length === 0 ? null : (
        <div className="table-wrapper__defilement">
        <table className="invoice-table">
          <thead>
            <tr>
              <th>Client / libellé</th>
              <th className="col-montant">Montant prévisionnel</th>
              <th>Facturation prévue</th>
              <th>Encaissement prévu</th>
              <th>Statut</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {triees.map((p) => {
              const active = estPrevisionnelleActive(p);
              // À facturer mais encaissement prévu avant le début de la projection : hors projection.
              const horsProjection =
                active && debutProjection !== null && estDateValide(p.dateEncaissementPrevue) && parseDateISO(p.dateEncaissementPrevue) < debutProjection;
              return (
                <tr key={p.id} className={active ? "" : "row--litigieuse"}>
                  <td>
                    <input type="text" value={p.client} placeholder="Client ou libellé" onChange={(e) => onChange(p.id, { client: e.target.value })} />
                  </td>
                  <td className="col-montant">
                    <input
                      type="number"
                      min="0"
                      value={p.montant}
                      onChange={(e) => onChange(p.id, { montant: Math.abs(Number(e.target.value) || 0) })}
                    />
                  </td>
                  <td>
                    <DateField value={p.dateFacturationPrevue} onChange={(valeur) => onChange(p.id, { dateFacturationPrevue: valeur })} />
                  </td>
                  <td>
                    <DateField
                      className={horsProjection ? "date-retard" : ""}
                      value={p.dateEncaissementPrevue}
                      onChange={(valeur) => onChange(p.id, { dateEncaissementPrevue: valeur })}
                    />
                    {horsProjection && (
                      <span className="badge-retard" title="Date passée : cette prévisionnelle n'entre pas dans la projection. Décalez la date ou rapprochez-la de la facture émise.">
                        Date passée
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`etiquette etiquette--previsionnelle${active ? "" : " etiquette--facturee"}`}>{libelleStatut(p, factures)}</span>
                    {active ? (
                      <button type="button" className="btn-shift rapprochement-ligne" onClick={() => setManuelleId(p.id)}>
                        Rapprocher d&apos;une facture émise
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-shift rapprochement-ligne"
                        onClick={() => {
                          if (window.confirm("Annuler le rapprochement ? La prévisionnelle redeviendra « À facturer » et comptera de nouveau dans la projection. La facture émise reste inchangée.")) {
                            onAnnulerRapprochement(p.id);
                          }
                        }}
                      >
                        Annuler le rapprochement
                      </button>
                    )}
                  </td>
                  <td className="col-actions">
                    <button
                      type="button"
                      className="btn-remove"
                      onClick={() => {
                        if (window.confirm("Supprimer cette facture prévisionnelle ?")) onRemove(p.id);
                      }}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
      <button type="button" className="btn-add" onClick={onAdd}>
        + Ajouter une facture prévisionnelle
      </button>
    </div>
  );
}
