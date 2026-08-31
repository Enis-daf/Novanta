"use client";

import { ChangeEvent, useMemo, useRef, useState } from "react";
import { AutreDepense, FactureClient, FactureFournisseur, Financement } from "@/lib/types";
import { formatMontant } from "@/lib/format";
import { formatDateCourte } from "@/lib/dates";
import { ErreurImportBancaire, ResultatAnalyseBancaire, analyserFichierBancaireXlsx } from "@/lib/bankXlsxAdapter";
import { ConsistencyIssue, ConsistencyIssueType, ResultatControleCoherence, controlerCoherence } from "@/lib/consistencyChecker";

interface VerifierMesDonneesProps {
  facturesClients: FactureClient[];
  facturesFournisseurs: FactureFournisseur[];
  autresDepenses: AutreDepense[];
  financements: Financement[];
  onChangeFactureClient: (id: string, patch: Partial<FactureClient>) => void;
  onChangeFactureFournisseur: (id: string, patch: Partial<FactureFournisseur>) => void;
  onChangeAutreDepense: (id: string, patch: Partial<AutreDepense>) => void;
  onChangeFinancement: (id: string, patch: Partial<Financement>) => void;
}

const LIBELLES_TYPE: Record<ConsistencyIssueType, { singulier: string; pluriel: string }> = {
  invoice_maybe_paid: {
    singulier: "facture potentiellement déjà payée",
    pluriel: "factures potentiellement déjà payées",
  },
  invoice_paid_but_unmatched: { singulier: "paiement à vérifier", pluriel: "paiements à vérifier" },
  other_expense_maybe_invoiced: {
    singulier: "dépense potentiellement déjà facturée",
    pluriel: "dépenses potentiellement déjà facturées",
  },
  other_expense_invoiced_but_missing_invoice: {
    singulier: "dépense facturée à vérifier",
    pluriel: "dépenses facturées à vérifier",
  },
  financing_maybe_received: { singulier: "financement à vérifier", pluriel: "financements à vérifier" },
  financing_received_but_unmatched: { singulier: "financement à vérifier", pluriel: "financements à vérifier" },
  bank_duplicate_candidate: { singulier: "doublon bancaire potentiel", pluriel: "doublons bancaires potentiels" },
};

const LIBELLE_SEVERITE: Record<ConsistencyIssue["severity"], string> = {
  strong: "Correspondance trouvée",
  possible: "Correspondance possible",
  informational: "À vérifier",
};

export default function VerifierMesDonnees({
  facturesClients,
  facturesFournisseurs,
  autresDepenses,
  financements,
  onChangeFactureClient,
  onChangeFactureFournisseur,
  onChangeAutreDepense,
  onChangeFinancement,
}: VerifierMesDonneesProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [chargement, setChargement] = useState(false);
  const [erreur, setErreur] = useState<ErreurImportBancaire | null>(null);
  const [resultat, setResultat] = useState<ResultatControleCoherence | null>(null);
  const [ignorees, setIgnorees] = useState<Set<string>>(new Set());

  const reinitialiser = () => {
    setErreur(null);
    setResultat(null);
    setIgnorees(new Set());
  };

  const handleFichierSelectionne = async (e: ChangeEvent<HTMLInputElement>) => {
    const fichier = e.target.files?.[0];
    e.target.value = "";
    if (!fichier) return;

    reinitialiser();
    setChargement(true);
    try {
      const analyse: ResultatAnalyseBancaire = await analyserFichierBancaireXlsx(fichier);
      // Le fichier peut contenir plusieurs mois d'historique : controlerCoherence filtre lui-même
      // aux 30 derniers jours — les transactions brutes ne sont jamais conservées au-delà de cet
      // appel (aucun état ne les retient une fois le résultat calculé).
      setResultat(
        controlerCoherence({
          transactions: analyse.transactions,
          facturesClients,
          facturesFournisseurs,
          autresDepenses,
          financements,
        })
      );
    } catch (err) {
      setErreur(
        err instanceof ErreurImportBancaire
          ? err
          : new ErreurImportBancaire(
              "Impossible de lire ce fichier. Vérifiez qu'il s'agit bien d'un fichier Excel (.xlsx) valide."
            )
      );
    } finally {
      setChargement(false);
    }
  };

  const issuesVisibles = useMemo(
    () => (resultat ? resultat.issues.filter((i) => !ignorees.has(i.id)) : []),
    [resultat, ignorees]
  );

  const groupes = useMemo(() => {
    const parType = new Map<ConsistencyIssueType, ConsistencyIssue[]>();
    for (const issue of issuesVisibles) {
      const liste = parType.get(issue.type) ?? [];
      liste.push(issue);
      parType.set(issue.type, liste);
    }
    return [...parType.entries()];
  }, [issuesVisibles]);

  const ignorer = (id: string) => setIgnorees((prev) => new Set(prev).add(id));

  // Règle absolue : le moteur détecte, l'utilisateur valide, Novanta modifie. Cette fonction n'est
  // JAMAIS appelée automatiquement — uniquement au clic explicite sur le bouton d'action ci-dessous.
  // Elle réutilise exactement les handlers existants (mêmes que les cases à cocher des tableaux).
  const executerAction = (issue: ConsistencyIssue) => {
    if (!issue.entityId) return;
    if (issue.type === "invoice_maybe_paid" && issue.entityType === "facture_fournisseur") {
      onChangeFactureFournisseur(issue.entityId, { payee: true, paidAt: new Date().toISOString() });
    } else if (issue.type === "invoice_maybe_paid" && issue.entityType === "facture_client") {
      onChangeFactureClient(issue.entityId, { payee: true, paidAt: new Date().toISOString() });
    } else if (issue.type === "other_expense_maybe_invoiced") {
      onChangeAutreDepense(issue.entityId, { facturee: true });
    } else if (issue.type === "financing_maybe_received") {
      onChangeFinancement(issue.entityId, { verse: true });
    }
    ignorer(issue.id); // traité : disparaît de la liste courante (session en cours uniquement)
  };

  return (
    <div className="table-wrapper">
      <div className="import-bancaire-intro">
        <h4>Vérifier la cohérence de mes données</h4>
        <p>
          Importez un relevé bancaire Excel. Novanta analysera uniquement les 30 derniers jours et recherchera les
          écarts potentiels avec vos données actuelles.
        </p>
        <button type="button" className="btn-add" onClick={() => inputRef.current?.click()} disabled={chargement}>
          {chargement ? "Analyse en cours…" : "Importer un relevé .xlsx"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx"
          onChange={handleFichierSelectionne}
          style={{ display: "none" }}
        />
      </div>

      {erreur && (
        <div className="import-apercu">
          <p className="login-erreur">Import impossible</p>
          {erreur.diagnostic ? (
            <>
              <p>{erreur.diagnostic.totalLignes} ligne(s) détectée(s)</p>
              <ul className="diagnostic-colonnes">
                <li className={erreur.diagnostic.date.ok ? "diagnostic-ok" : "diagnostic-echec"}>
                  <span>{erreur.diagnostic.date.ok ? "✓" : "✕"}</span> Date transaction :{" "}
                  {erreur.diagnostic.date.ok ? `"${erreur.diagnostic.date.detail}"` : erreur.diagnostic.date.detail}
                </li>
                <li className={erreur.diagnostic.libelle.ok ? "diagnostic-ok" : "diagnostic-echec"}>
                  <span>{erreur.diagnostic.libelle.ok ? "✓" : "✕"}</span> Libellé :{" "}
                  {erreur.diagnostic.libelle.ok
                    ? `"${erreur.diagnostic.libelle.detail}"`
                    : erreur.diagnostic.libelle.detail}
                </li>
                <li className={erreur.diagnostic.montant.ok ? "diagnostic-ok" : "diagnostic-echec"}>
                  <span>{erreur.diagnostic.montant.ok ? "✓" : "✕"}</span> Montant :{" "}
                  {erreur.diagnostic.montant.ok
                    ? `"${erreur.diagnostic.montant.detail}"`
                    : erreur.diagnostic.montant.detail}
                </li>
              </ul>
            </>
          ) : (
            <p>{erreur.message}</p>
          )}
          <div className="import-boutons">
            <button type="button" className="btn-secondaire" onClick={() => inputRef.current?.click()}>
              Choisir un autre fichier
            </button>
          </div>
        </div>
      )}

      {resultat && (
        <div className="import-apercu">
          <p>
            {resultat.transactionsAnalysees} transaction{resultat.transactionsAnalysees > 1 ? "s" : ""} analysée
            {resultat.transactionsAnalysees > 1 ? "s" : ""} sur les 30 derniers jours
            {resultat.totalTransactions !== resultat.transactionsAnalysees && (
              <>
                {" "}
                ({resultat.totalTransactions} transaction{resultat.totalTransactions > 1 ? "s" : ""} trouvée
                {resultat.totalTransactions > 1 ? "s" : ""} dans le fichier)
              </>
            )}
          </p>
          <p>
            {issuesVisibles.length === 0
              ? "Aucun point à vérifier."
              : `${issuesVisibles.length} point${issuesVisibles.length > 1 ? "s" : ""} à vérifier`}
          </p>

          {groupes.map(([type, issues]) => (
            <div key={type} className="consistency-groupe">
              <h5>
                {issues.length} {issues.length > 1 ? LIBELLES_TYPE[type].pluriel : LIBELLES_TYPE[type].singulier}
              </h5>
              <ul className="consistency-liste">
                {issues.map((issue) => (
                  <li key={issue.id} className="consistency-item">
                    <div className="consistency-item__ligne">
                      <strong>{issue.donneesAffichage.libelle}</strong>
                      <span className="col-montant">{formatMontant(issue.donneesAffichage.montant)}</span>
                      {issue.donneesAffichage.date && <span>{formatDateCourte(issue.donneesAffichage.date)}</span>}
                    </div>
                    {issue.transactions.map((t, i) => (
                      <p key={i} className="occurrences-periode">
                        Mouvement bancaire trouvé : {formatDateCourte(t.date)} · {t.libelle} · {formatMontant(t.montant)}
                      </p>
                    ))}
                    <p className="consistency-item__message">
                      {issue.message}{" "}
                      <span className="consistency-item__badge">{LIBELLE_SEVERITE[issue.severity]}</span>
                    </p>
                    <p className="occurrences-periode">{issue.raison}</p>
                    <div className="import-boutons">
                      {issue.actionPossible && (
                        <button type="button" className="btn-add" onClick={() => executerAction(issue)}>
                          {issue.actionPossible.label}
                        </button>
                      )}
                      <button type="button" className="btn-secondaire" onClick={() => ignorer(issue.id)}>
                        Ignorer
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {issuesVisibles.length > 0 && (
            <div className="import-boutons">
              <button type="button" className="btn-secondaire" onClick={reinitialiser}>
                Fermer l&apos;analyse
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
