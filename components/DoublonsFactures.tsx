"use client";

import { groupeDeEtage, libelleGroupeEtage } from "@/lib/futurPnl";
import { useState } from "react";
import { formatDateCourte } from "@/lib/dates";
import { formatMontant } from "@/lib/format";
import {
  appliquerFusion,
  ChoixFusion,
  clePaire,
  DetectionDoublon,
  FactureFusionnable,
  PaireDoublon,
  PropositionFusion,
  proposerFusion,
  rattachementPossible,
} from "@/lib/doublonsFactures";
import { RattachementPropose } from "@/lib/pennylaneInvoiceAdapter";

interface DoublonsFacturesProps {
  sens: "client" | "fournisseur";
  // Factures Pennylane non importées à la dernière synchronisation : elles correspondent
  // probablement à une ligne déjà présente.
  rattachements: RattachementPropose[];
  // Paires déjà présentes dans Novanta qui semblent représenter le même document.
  paires: PaireDoublon<FactureFusionnable>[];
  factureParId: (id: string) => FactureFusionnable | undefined;
  onRattacher: (rattachement: RattachementPropose) => void;
  onImporterSeparement: (rattachement: RattachementPropose) => void;
  // Fusion confirmée : rejette en cas d'échec (la carte reste affichée, avec l'erreur).
  onFusionner: (paire: PaireDoublon<FactureFusionnable>, proposition: PropositionFusion, choix: ChoixFusion) => Promise<void>;
  onIgnorer: (paire: PaireDoublon<FactureFusionnable>) => Promise<void>;
}

const origine = (f: FactureFusionnable) => (f.pennylaneId ? "Pennylane" : "Novanta");

function Ligne({ titre, facture, tiers, montant, echeance }: { titre: string; facture: string; tiers: string; montant: number; echeance: string }) {
  return (
    <div className="doublons-cote">
      <span className="doublons-cote__titre">{titre}</span>
      <strong>{tiers || "Tiers non renseigné"}</strong>
      <span>{formatMontant(montant)}</span>
      <span className="doublons-cote__detail">
        N° {facture || "—"}
        {echeance ? ` · échéance ${formatDateCourte(echeance)}` : ""}
      </span>
    </div>
  );
}

function Diagnostic({ detection }: { detection: DetectionDoublon }) {
  // Un libellé et ses raisons concrètes, jamais un score.
  return (
    <p className="doublons-carte__diagnostic">
      {detection.libelle}
      <span className="doublons-cote__detail"> — {detection.raison}</span>
    </p>
  );
}

const date = (valeur: string) => (valeur ? formatDateCourte(valeur) : "—");
const ouiNon = (valeur: boolean) => (valeur ? "Oui" : "Non");

// Lignes du comparatif : le document (repris de la référence) puis les réglages de prévision.
const LIGNES_COMPARAISON: { libelle: string; valeur: (f: FactureFusionnable) => string; reglage?: boolean }[] = [
  { libelle: "Tiers", valeur: (f) => f.tiers || "—" },
  { libelle: "N° de facture", valeur: (f) => f.facture || "—" },
  { libelle: "Montant", valeur: (f) => formatMontant(f.montant) },
  { libelle: "Échéance", valeur: (f) => date(f.dateEcheance) },
  { libelle: "Origine", valeur: origine },
  { libelle: "Paiement prévu", valeur: (f) => date(f.datePrevue), reglage: true },
  { libelle: "Payée", valeur: (f) => ouiNon(f.payee), reglage: true },
  { libelle: "Litigieuse", valeur: (f) => ouiNon(f.litigieuse), reglage: true },
];

/**
 * Résolution d'un doublon, avant toute écriture (lib/doublonsFactures.ts) : les deux lignes et le
 * résultat côte à côte. Le document de la facture Pennylane est conservé sans choix possible ; les
 * réglages de prévision Novanta sont repris. Seul un vrai conflit (deux dates de paiement prévues
 * explicites différentes) demande une décision.
 */
function ResolutionFusion({
  paire,
  onConfirmer,
  onAnnuler,
}: {
  paire: PaireDoublon<FactureFusionnable>;
  onConfirmer: (proposition: PropositionFusion, choix: ChoixFusion) => Promise<void>;
  onAnnuler: () => void;
}) {
  const [referenceChoisie, setReferenceChoisie] = useState<string | null>(null);
  const [choix, setChoix] = useState<ChoixFusion>({});
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const proposition = proposerFusion(paire.a, paire.b, referenceChoisie);
  const resultat = appliquerFusion(paire.a, paire.b, proposition, choix);
  const reference = proposition.referenceId === paire.a.id ? paire.a : paire.b;
  const retiree = reference === paire.a ? paire.b : paire.a;
  const cle = clePaire(paire.a.id, paire.b.id);

  const confirmer = async () => {
    // Un seul envoi : le bouton est désactivé dès le premier clic.
    if (enCours || !resultat) return;
    setEnCours(true);
    setErreur(null);
    try {
      await onConfirmer(proposition, choix);
    } catch {
      setErreur("La fusion n'a pas pu être enregistrée. Les deux lignes ont été relues ; réessayez.");
      setEnCours(false);
    }
  };

  return (
    <div className="doublons-fusion" role="group" aria-label="Fusionner ces deux factures">
      <table className="doublons-fusion__table">
        <thead>
          <tr>
            <th scope="col">
              <span className="passe-visuellement-cache">Champ</span>
            </th>
            <th scope="col">{origine(paire.a)}</th>
            <th scope="col">{origine(paire.b)}</th>
            <th scope="col">Après fusion</th>
          </tr>
        </thead>
        <tbody>
          {LIGNES_COMPARAISON.map((ligne) => {
            const [va, vb] = [ligne.valeur(paire.a), ligne.valeur(paire.b)];
            const apres = resultat ? ligne.valeur(resultat.reference) : ligne.libelle === "Paiement prévu" ? "À choisir" : ligne.valeur(reference);
            return (
              <tr key={ligne.libelle} className={va !== vb ? "doublons-fusion__difference" : undefined}>
                <th scope="row">{ligne.libelle}</th>
                <td>{va}</td>
                <td>{vb}</td>
                <td>
                  <strong>{apres}</strong>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="doublons-cote__detail">
        {proposition.referenceImposee
          ? "Les informations de facturation Pennylane seront conservées. Les réglages de prévision Novanta seront repris."
          : "Les informations de facturation de la ligne de référence seront conservées. Les réglages de prévision des deux lignes seront repris."}{" "}
        Une seule facture comptera dans les prévisions ; la ligne {origine(retiree)} est retirée et son contenu gardé dans
        l&apos;historique de la fusion.
        {retiree.pennylaneId ? " Cette autre facture Pennylane ne sera plus importée." : ""}
      </p>

      {!proposition.referenceImposee && (
        <fieldset className="doublons-fusion__choix">
          <legend>Facture de référence</legend>
          {[paire.a, paire.b].map((f) => (
            <label key={f.id}>
              <input type="radio" name={`ref-${cle}`} checked={f === reference} onChange={() => setReferenceChoisie(f.id)} />
              {f.tiers || "Tiers non renseigné"} — {formatMontant(f.montant)} ({origine(f)})
            </label>
          ))}
        </fieldset>
      )}

      {proposition.conflitDatePrevue && (
        <fieldset className="doublons-fusion__choix">
          <legend>
            Paiement prévu <span className="doublons-cote__detail">— deux dates posées dans Novanta, à choisir</span>
          </legend>
          {(["a", "b"] as const).map((c) => (
            <label key={c}>
              <input type="radio" name={`date-${cle}`} checked={choix.datePrevue === c} onChange={() => setChoix((prev) => ({ ...prev, datePrevue: c }))} />
              {date(proposition.conflitDatePrevue!.valeurs[c])} <span className="doublons-cote__detail">({origine(c === "a" ? paire.a : paire.b)})</span>
            </label>
          ))}
        </fieldset>
      )}

      {proposition.conflitEtagePnl && (
        <fieldset className="doublons-fusion__choix">
          <legend>
            Étage P&amp;L <span className="doublons-cote__detail">— deux classements choisis dans Futur, à choisir</span>
          </legend>
          {(["a", "b"] as const).map((c) => (
            <label key={c}>
              <input type="radio" name={`etage-${cle}`} checked={choix.etagePnl === c} onChange={() => setChoix((prev) => ({ ...prev, etagePnl: c }))} />
              {libelleGroupeEtage(groupeDeEtage(proposition.conflitEtagePnl!.valeurs[c]))}{" "}
              <span className="doublons-cote__detail">({origine(c === "a" ? paire.a : paire.b)})</span>
            </label>
          ))}
        </fieldset>
      )}

      {erreur && (
        <p className="login-erreur" role="alert">
          {erreur}
        </p>
      )}
      <div className="doublons-carte__actions">
        <button type="button" className="btn-add" onClick={confirmer} disabled={enCours || !resultat}>
          {enCours ? "Fusion en cours…" : "Confirmer la fusion"}
        </button>
        <button type="button" className="btn-secondaire" onClick={onAnnuler} disabled={enCours}>
          Annuler
        </button>
      </div>
    </div>
  );
}

/**
 * Doublons de factures : suggestions seulement. Rien n'est fusionné ni rattaché sans un clic de
 * l'utilisateur ; la raison de chaque suggestion est affichée.
 */
export default function DoublonsFactures({
  sens,
  rattachements,
  paires,
  factureParId,
  onRattacher,
  onImporterSeparement,
  onFusionner,
  onIgnorer,
}: DoublonsFacturesProps) {
  const [ouverte, setOuverte] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [erreurIgnorer, setErreurIgnorer] = useState<string | null>(null);
  if (rattachements.length === 0 && paires.length === 0 && !confirmation) return null;

  return (
    <div className="doublons">
      <h3>Doublons de factures {sens === "client" ? "clients" : "fournisseurs"} possibles</h3>
      {confirmation && (
        <p className="doublons__confirmation" role="status">
          {confirmation}
        </p>
      )}
      {(rattachements.length > 0 || paires.length > 0) && (
        <p className="doublons__intro">
          Ces factures semblent représenter le même document. Vérifiez avant de confirmer : rien n&apos;est fusionné sans
          votre accord.
        </p>
      )}
      {erreurIgnorer && (
        <p className="login-erreur" role="alert">
          {erreurIgnorer}
        </p>
      )}
      <ul className="doublons__liste">
        {rattachements.map((r) => {
          const existante = factureParId(r.existanteId);
          if (!existante) return null;
          return (
            <li key={`r-${r.candidat.pennylaneId}`} className="doublons-carte">
              <Diagnostic detection={r.detection} />
              <div className="doublons-carte__paire">
                <Ligne titre="Déjà dans Novanta" facture={existante.facture} tiers={existante.tiers} montant={existante.montant} echeance={existante.dateEcheance} />
                <Ligne titre="Reçue de Pennylane" facture={r.candidat.facture} tiers={r.candidat.tiers} montant={r.candidat.montant} echeance={r.candidat.dateEcheance} />
              </div>
              <p className="doublons-cote__detail">
                Rattacher : la ligne Novanta prend les informations de facturation Pennylane (montant{" "}
                {formatMontant(r.candidat.montant)}
                {r.candidat.dateEcheance ? `, échéance ${formatDateCourte(r.candidat.dateEcheance)}` : ""}) et garde ses réglages de
                prévision. Elle ne sera plus importée en double.
                {!rattachementPossible(r.detection) && ` Montants différents (${formatMontant(existante.montant)} saisi dans Novanta) : vérifiez qu'il s'agit bien de la même facture.`}
              </p>
              <div className="doublons-carte__actions">
                <button type="button" className="btn-add" onClick={() => onRattacher(r)}>
                  Rattacher à la facture existante
                </button>
                <button type="button" className="btn-secondaire" onClick={() => onImporterSeparement(r)}>
                  Importer comme facture distincte
                </button>
              </div>
            </li>
          );
        })}
        {paires.map((paire) => {
          const cle = clePaire(paire.a.id, paire.b.id);
          const titre = (f: FactureFusionnable) => (f.pennylaneId ? "Importée de Pennylane" : "Saisie dans Novanta");
          return (
            <li key={`p-${cle}`} className="doublons-carte">
              <Diagnostic detection={paire.detection} />
              <div className="doublons-carte__paire">
                <Ligne titre={titre(paire.a)} facture={paire.a.facture} tiers={paire.a.tiers} montant={paire.a.montant} echeance={paire.a.dateEcheance} />
                <Ligne titre={titre(paire.b)} facture={paire.b.facture} tiers={paire.b.tiers} montant={paire.b.montant} echeance={paire.b.dateEcheance} />
              </div>
              {ouverte === cle ? (
                <ResolutionFusion
                  paire={paire}
                  onAnnuler={() => setOuverte(null)}
                  onConfirmer={async (proposition, choix) => {
                    await onFusionner(paire, proposition, choix);
                    setOuverte(null);
                    setConfirmation(`Factures fusionnées : ${paire.a.facture || paire.a.tiers}. Une seule ligne compte désormais dans les prévisions.`);
                  }}
                />
              ) : (
                <>
                  <p className="doublons-cote__detail">
                    Fusionner garde une seule facture : vous verrez les deux lignes et le résultat côte à côte avant de
                    confirmer. S&apos;il s&apos;agit de deux factures distinctes, écartez la suggestion.
                  </p>
                  <div className="doublons-carte__actions">
                    <button
                      type="button"
                      className="btn-add"
                      onClick={() => {
                        setConfirmation(null);
                        setOuverte(cle);
                      }}
                    >
                      Fusionner
                    </button>
                    <button
                      type="button"
                      className="btn-secondaire"
                      onClick={() => {
                        setErreurIgnorer(null);
                        onIgnorer(paire).catch(() => setErreurIgnorer("Ce choix n'a pas pu être enregistré. Réessayez."));
                      }}
                    >
                      Ce ne sont pas des doublons
                    </button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
