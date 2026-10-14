"use client";

import { formatDateCourte } from "@/lib/dates";
import { formatMontant } from "@/lib/format";
import { DetectionDoublon, FactureFusionnable, MOTIF_MONTANTS_DIFFERENTS, PaireDoublon, planFusion, rattachementPossible } from "@/lib/doublonsFactures";
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
  onFusionner: (paire: PaireDoublon<FactureFusionnable>) => void;
  onIgnorer: (paire: PaireDoublon<FactureFusionnable>) => void;
}

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
  if (rattachements.length === 0 && paires.length === 0) return null;
  const libelleTiers = sens === "client" ? "client" : "fournisseur";

  return (
    <div className="doublons">
      <h3>Doublons de factures {sens === "client" ? "clients" : "fournisseurs"} possibles</h3>
      <p className="doublons__intro">
        Ces factures semblent représenter le même document. Vérifiez avant de confirmer : rien n&apos;est fusionné sans
        votre accord.
      </p>
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
              {rattachementPossible(r.detection) ? (
                <p className="doublons-cote__detail">
                  Rattacher conserve la ligne Novanta telle quelle (montant, date prévue, statuts) et la relie à la facture
                  Pennylane : elle ne sera plus jamais importée en double.
                </p>
              ) : (
                <p className="doublons-cote__detail">
                  {MOTIF_MONTANTS_DIFFERENTS}. La facture Pennylane n&apos;est pas importée tant que vous n&apos;avez pas
                  décidé : corrigez ou retirez la ligne Novanta si besoin.
                </p>
              )}
              <div className="doublons-carte__actions">
                {rattachementPossible(r.detection) && (
                  <button type="button" className="btn-add" onClick={() => onRattacher(r)}>
                    Rattacher à la facture existante
                  </button>
                )}
                <button type="button" className="btn-secondaire" onClick={() => onImporterSeparement(r)}>
                  Importer comme facture distincte
                </button>
              </div>
            </li>
          );
        })}
        {paires.map((paire) => {
          const plan = planFusion(paire.a, paire.b);
          const titre = (f: FactureFusionnable) => (f.pennylaneId ? "Importée de Pennylane" : "Saisie dans Novanta");
          return (
            <li key={`p-${[paire.a.id, paire.b.id].sort().join("-")}`} className="doublons-carte">
              <Diagnostic detection={paire.detection} />
              <div className="doublons-carte__paire">
                <Ligne titre={titre(paire.a)} facture={paire.a.facture} tiers={paire.a.tiers} montant={paire.a.montant} echeance={paire.a.dateEcheance} />
                <Ligne titre={titre(paire.b)} facture={paire.b.facture} tiers={paire.b.tiers} montant={paire.b.montant} echeance={paire.b.dateEcheance} />
              </div>
              {plan.possible ? (
                <p className="doublons-cote__detail">
                  Fusionner garde la ligne « {factureParId(plan.survivantId)?.tiers || libelleTiers} » avec ses réglages
                  {plan.pennylaneIdATransferer ? " et la relie à la facture Pennylane" : ""}, puis retire l&apos;autre.
                  {plan.ecarts.length > 0 ? ` Écarts : ${plan.ecarts.join(" ; ")}.` : ""}
                </p>
              ) : (
                <p className="doublons-cote__detail">{plan.motif}</p>
              )}
              <div className="doublons-carte__actions">
                {plan.possible && (
                  <button type="button" className="btn-add" onClick={() => onFusionner(paire)}>
                    Fusionner
                  </button>
                )}
                <button type="button" className="btn-secondaire" onClick={() => onIgnorer(paire)}>
                  Ce ne sont pas des doublons
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
