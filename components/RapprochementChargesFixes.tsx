"use client";

import { useState } from "react";
import { formatDateCourte } from "@/lib/dates";
import { formatMontant } from "@/lib/format";
import {
  CandidatRapprochement,
  dateCashFacture,
  LienARevoir,
  OccurrenceRapprochable,
  PropositionRapprochement,
} from "@/lib/rapprochementChargesFixes";
import { ChargeFixe, FactureFournisseur } from "@/lib/types";

/** Cible d'une confirmation : une occurrence précise d'une Charge fixe. */
export interface CibleRapprochement {
  chargeFixeId: string;
  dateOccurrence: string;
  lienARemplacerId: string | null;
}

interface RapprochementChargesFixesProps {
  // Propositions issues de la dernière synchronisation Pennylane (vide tant qu'aucune n'a eu lieu).
  propositions: PropositionRapprochement[];
  aRevoir: LienARevoir[];
  factures: FactureFournisseur[];
  charges: ChargeFixe[];
  onConfirmer: (factureId: string, cible: CibleRapprochement) => void;
  onRefuser: (factureId: string, candidats: CandidatRapprochement[]) => void;
  // « Rétablir la charge prévue » / « Dissocier » : supprime le rapprochement, l'occurrence revient.
  onDissocier: (lienId: string) => void;
  onLaisserRemplacee: (lienId: string) => void;
  // Rapprochement manuel en cours (facture choisie depuis le tableau des factures fournisseurs).
  factureManuelle: FactureFournisseur | null;
  occurrencesManuelles: (chargeFixeId: string) => OccurrenceRapprochable[];
  onAnnulerManuel: () => void;
}

function BlocFacture({ facture }: { facture: FactureFournisseur }) {
  const dateCash = dateCashFacture(facture);
  return (
    <div className="rapprochement-cote">
      <span className="rapprochement-cote__titre">Facture réelle</span>
      <strong>{facture.fournisseur || "Fournisseur non renseigné"}</strong>
      <span>{formatMontant(facture.montant)}</span>
      <span className="rapprochement-cote__detail">
        {facture.facture ? `N° ${facture.facture} · ` : ""}
        {dateCash ? `paiement prévu le ${formatDateCourte(dateCash)}` : "sans date"}
      </span>
    </div>
  );
}

function BlocCharge({ libelle, montantPrevu, dateOccurrence }: { libelle: string; montantPrevu: number | null; dateOccurrence: string }) {
  return (
    <div className="rapprochement-cote">
      <span className="rapprochement-cote__titre">Charge fixe prévue</span>
      <strong>{libelle || "Charge sans libellé"}</strong>
      <span>{montantPrevu === null ? "Montant indisponible" : formatMontant(montantPrevu)}</span>
      <span className="rapprochement-cote__detail">occurrence du {formatDateCourte(dateOccurrence)}</span>
    </div>
  );
}

/** Une proposition : la facture face à la (ou aux) Charge(s) fixe(s) candidate(s). */
function CarteProposition({
  proposition,
  facture,
  charges,
  onConfirmer,
  onRefuser,
}: {
  proposition: PropositionRapprochement;
  facture: FactureFournisseur;
  charges: ChargeFixe[];
  onConfirmer: RapprochementChargesFixesProps["onConfirmer"];
  onRefuser: RapprochementChargesFixesProps["onRefuser"];
}) {
  const ambigue = proposition.candidats.length > 1;
  // Ambiguïté : rien n'est présélectionné, l'utilisateur désigne lui-même la bonne charge.
  const [choix, setChoix] = useState<number | null>(ambigue ? null : 0);
  const candidat = choix === null ? null : proposition.candidats[choix];
  const libelleCharge = (c: CandidatRapprochement) => charges.find((charge) => charge.id === c.chargeFixeId)?.libelle ?? "";
  const alimenteDesChargesCalculees =
    candidat !== null && charges.some((c) => c.sourceCalculType === "charge_fixe" && c.sourceCalculId === candidat.chargeFixeId);

  return (
    <li className="rapprochement-carte">
      {proposition.niveau === "forte" && <p className="rapprochement-carte__contexte">Fournisseur déjà rapproché de cette charge.</p>}
      {proposition.niveau === "ambigue" && (
        <p className="rapprochement-carte__contexte">
          {ambigue ? "Plusieurs charges fixes peuvent correspondre : choisissez la bonne." : "Plusieurs factures peuvent correspondre à cette occurrence."}
        </p>
      )}
      <div className="rapprochement-carte__paire">
        <BlocFacture facture={facture} />
        {ambigue ? (
          <div className="rapprochement-cote">
            <span className="rapprochement-cote__titre">Charges fixes prévues</span>
            {proposition.candidats.map((c, index) => (
              <label key={`${c.chargeFixeId}-${c.dateOccurrence}`} className="rapprochement-choix">
                <input type="radio" name={`rapprochement-${proposition.factureId}`} checked={choix === index} onChange={() => setChoix(index)} />
                <span>
                  <strong>{libelleCharge(c) || "Charge sans libellé"}</strong> · {formatMontant(c.montantPrevu)} · occurrence du{" "}
                  {formatDateCourte(c.dateOccurrence)}
                </span>
              </label>
            ))}
          </div>
        ) : (
          <BlocCharge libelle={libelleCharge(proposition.candidats[0])} montantPrevu={proposition.candidats[0].montantPrevu} dateOccurrence={proposition.candidats[0].dateOccurrence} />
        )}
      </div>
      {alimenteDesChargesCalculees && (
        <p className="rapprochement-cote__detail">
          Les charges calculées sur cette charge seront recalculées sur {formatMontant(facture.montant)} pour cette occurrence.
        </p>
      )}
      <div className="rapprochement-carte__actions">
        <button
          type="button"
          className="btn-add"
          disabled={candidat === null}
          onClick={() => candidat && onConfirmer(facture.id, candidat)}
        >
          Confirmer le rapprochement
        </button>
        <button type="button" className="btn-secondaire" onClick={() => onRefuser(facture.id, proposition.candidats)}>
          Ce n’est pas la même dépense
        </button>
      </div>
    </li>
  );
}

/** Rapprochement manuel : l'utilisateur choisit la Charge fixe puis l'occurrence, sans seuil. */
function RapprochementManuel({
  facture,
  charges,
  occurrencesManuelles,
  onConfirmer,
  onAnnuler,
}: {
  facture: FactureFournisseur;
  charges: ChargeFixe[];
  occurrencesManuelles: RapprochementChargesFixesProps["occurrencesManuelles"];
  onConfirmer: RapprochementChargesFixesProps["onConfirmer"];
  onAnnuler: () => void;
}) {
  const [chargeId, setChargeId] = useState("");
  const [dateChoisie, setDateChoisie] = useState("");
  const occurrences = chargeId ? occurrencesManuelles(chargeId) : [];
  const dateOccurrence = dateChoisie || occurrences.find((o) => o.suggeree)?.dateOccurrence || "";
  const occurrence = occurrences.find((o) => o.dateOccurrence === dateOccurrence) ?? null;

  return (
    <div className="rapprochement-carte">
      <p className="rapprochement-carte__contexte">Rapprocher à une charge fixe</p>
      <div className="rapprochement-carte__paire">
        <BlocFacture facture={facture} />
        <div className="rapprochement-cote">
          <span className="rapprochement-cote__titre">Charge fixe prévue</span>
          <select
            value={chargeId}
            onChange={(e) => {
              setChargeId(e.target.value);
              setDateChoisie("");
            }}
          >
            <option value="">Choisir une charge fixe…</option>
            {charges.map((c) => (
              <option key={c.id} value={c.id}>
                {c.libelle || "Charge sans libellé"}
              </option>
            ))}
          </select>
          {chargeId && occurrences.length === 0 && <span className="rapprochement-cote__detail">Aucune occurrence disponible pour cette charge.</span>}
          {occurrences.length > 0 && (
            <select value={dateOccurrence} onChange={(e) => setDateChoisie(e.target.value)}>
              <option value="">Choisir l’occurrence…</option>
              {occurrences.map((o) => (
                <option key={o.dateOccurrence} value={o.dateOccurrence}>
                  {formatDateCourte(o.dateOccurrence)}
                  {o.montantPrevu !== null ? ` · ${formatMontant(o.montantPrevu)}` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      {occurrence && (
        <p className="rapprochement-cote__detail">
          {formatMontant(facture.montant)} remplacera l’occurrence du {formatDateCourte(occurrence.dateOccurrence)}
          {occurrence.montantPrevu !== null ? ` (${formatMontant(occurrence.montantPrevu)} prévus)` : ""}.
        </p>
      )}
      <div className="rapprochement-carte__actions">
        <button
          type="button"
          className="btn-add"
          disabled={!occurrence}
          onClick={() =>
            occurrence && onConfirmer(facture.id, { chargeFixeId: chargeId, dateOccurrence: occurrence.dateOccurrence, lienARemplacerId: occurrence.lienARemplacerId })
          }
        >
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
 * Validation des rapprochements Facture fournisseur <-> Charge fixe. Affiche uniquement ce qui
 * demande une décision : rien n'est neutralisé tant que l'utilisateur n'a pas confirmé.
 */
export default function RapprochementChargesFixes({
  propositions,
  aRevoir,
  factures,
  charges,
  onConfirmer,
  onRefuser,
  onDissocier,
  onLaisserRemplacee,
  factureManuelle,
  occurrencesManuelles,
  onAnnulerManuel,
}: RapprochementChargesFixesProps) {
  const visibles = propositions
    .map((proposition) => ({ proposition, facture: factures.find((f) => f.id === proposition.factureId) }))
    .filter((p): p is { proposition: PropositionRapprochement; facture: FactureFournisseur } => Boolean(p.facture));

  if (visibles.length === 0 && aRevoir.length === 0 && !factureManuelle) return null;
  const libelleCharge = (id: string) => charges.find((c) => c.id === id)?.libelle || "Charge sans libellé";

  return (
    <div className="rapprochement" id="rapprochement-charges-fixes">
      {factureManuelle && (
        <RapprochementManuel
          key={factureManuelle.id}
          facture={factureManuelle}
          charges={charges.filter((c) => c.recurrence !== "quotidien")}
          occurrencesManuelles={occurrencesManuelles}
          onConfirmer={onConfirmer}
          onAnnuler={onAnnulerManuel}
        />
      )}

      {visibles.length > 0 && (
        <>
          <h3>Doublons potentiels détectés</h3>
          <p className="rapprochement__intro">
            Certaines factures semblent correspondre à des Charges fixes déjà prévues. Confirmez les correspondances pour éviter de les
            compter deux fois.
          </p>
          <ul className="rapprochement__liste">
            {visibles.map(({ proposition, facture }) => (
              <CarteProposition
                key={`${proposition.factureId}-${proposition.candidats.map((c) => c.chargeFixeId).join("-")}`}
                proposition={proposition}
                facture={facture}
                charges={charges}
                onConfirmer={onConfirmer}
                onRefuser={onRefuser}
              />
            ))}
          </ul>
        </>
      )}

      {aRevoir.length > 0 && (
        <>
          <h3>Rapprochements à revoir</h3>
          <ul className="rapprochement__liste">
            {aRevoir.map(({ lien, motif }) => (
              <li key={lien.id} className="rapprochement-carte">
                {motif === "facture_absente" ? (
                  <p>
                    La facture {lien.fournisseurLibelle}
                    {lien.factureLibelle ? ` n° ${lien.factureLibelle}` : ""}
                    {lien.montantFacture !== null ? ` (${formatMontant(lien.montantFacture)})` : ""} qui remplaçait «&nbsp;
                    {libelleCharge(lien.chargeFixeId)}&nbsp;» du {formatDateCourte(lien.dateOccurrence)} n’existe plus. Cette occurrence reste
                    remplacée et n’est pas comptée.
                  </p>
                ) : (
                  <p>
                    Le calendrier de «&nbsp;{libelleCharge(lien.chargeFixeId)}&nbsp;» a changé : le rapprochement avec la facture{" "}
                    {lien.fournisseurLibelle}
                    {lien.montantFacture !== null ? ` (${formatMontant(lien.montantFacture)})` : ""} du {formatDateCourte(lien.dateOccurrence)} ne
                    correspond plus à aucune occurrence. La charge et la facture sont toutes deux comptées.
                  </p>
                )}
                <div className="rapprochement-carte__actions">
                  {motif === "facture_absente" ? (
                    <>
                      <button type="button" className="btn-secondaire" onClick={() => onLaisserRemplacee(lien.id)}>
                        Laisser remplacée
                      </button>
                      <button type="button" className="btn-secondaire" onClick={() => onDissocier(lien.id)}>
                        Rétablir la charge prévue
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn-secondaire" onClick={() => onDissocier(lien.id)}>
                      Dissocier
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
