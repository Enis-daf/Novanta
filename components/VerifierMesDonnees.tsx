"use client";

import { ChangeEvent, useMemo, useRef, useState } from "react";
import { AutreDepense, FactureClient, FactureFournisseur, Financement } from "@/lib/types";
import { formatMontant } from "@/lib/format";
import { formatDateCourte } from "@/lib/dates";
import { ErreurImportBancaire, analyserFichierBancaireXlsx } from "@/lib/bankXlsxAdapter";
import { NormalizedBankTransaction } from "@/lib/bankTransaction";
import {
  ConsistencyIssue,
  ConsistencyIssueType,
  controlerCoherence,
  trierIssuesParImpact,
} from "@/lib/consistencyChecker";
import { useAnalyseSession } from "./AnalyseSessionContext";

interface VerifierMesDonneesProps {
  facturesClients: FactureClient[];
  facturesFournisseurs: FactureFournisseur[];
  autresDepenses: AutreDepense[];
  financements: Financement[];
  onChangeFactureClient: (id: string, patch: Partial<FactureClient>) => void;
  onChangeFactureFournisseur: (id: string, patch: Partial<FactureFournisseur>) => void;
  onChangeAutreDepense: (id: string, patch: Partial<AutreDepense>) => void;
  onChangeFinancement: (id: string, patch: Partial<Financement>) => void;
  pennylaneConnecte?: boolean;
  accessToken?: string | null;
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
  other_expense_maybe_paid: {
    singulier: "dépense potentiellement déjà payée",
    pluriel: "dépenses potentiellement déjà payées",
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
  pennylaneConnecte = false,
  accessToken = null,
}: VerifierMesDonneesProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [chargement, setChargement] = useState(false);
  const [erreur, setErreur] = useState<ErreurImportBancaire | string | null>(null);
  // Formulaire XLSX visible par défaut si Pennylane n'est pas connecté ; sinon masqué derrière
  // "Utiliser un fichier Excel" au profit d'"Analyser Pennylane" en action principale.
  const [afficherXlsx, setAfficherXlsx] = useState(!pennylaneConnecte);

  // Résultat de l'analyse en cours : dans AnalyseSessionContext (monté dans app/layout.tsx), pas
  // dans un useState local — ce composant est démonté à chaque navigation vers /account/billing ou
  // /account/integrations (liens "Abonnement"/"Intégrations"), donc un useState local ne survit pas
  // à l'aller-retour. Voir AnalyseSessionContext.tsx pour la chaîne causale complète.
  const {
    resultatVerification: resultat,
    ignoreesVerification: ignorees,
    definirResultatVerification,
    ignorerVerification,
    reinitialiserVerification,
  } = useAnalyseSession();

  const reinitialiser = () => {
    setErreur(null);
    reinitialiserVerification();
  };

  const executerControle = (transactions: NormalizedBankTransaction[]) => {
    // controlerCoherence filtre lui-même aux 30 derniers jours — les transactions brutes ne sont
    // jamais conservées au-delà de cet appel (aucun état ne les retient une fois le résultat calculé),
    // que la source soit un fichier XLSX ou une récupération Pennylane.
    definirResultatVerification(
      controlerCoherence({
        transactions,
        facturesClients,
        facturesFournisseurs,
        autresDepenses,
        financements,
      })
    );
  };

  const handleFichierSelectionne = async (e: ChangeEvent<HTMLInputElement>) => {
    const fichier = e.target.files?.[0];
    e.target.value = "";
    if (!fichier) return;

    reinitialiser();
    setChargement(true);
    try {
      const analyse = await analyserFichierBancaireXlsx(fichier);
      executerControle(analyse.transactions);
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

  const handleAnalyserPennylane = async () => {
    if (!accessToken) return;
    reinitialiser();
    setChargement(true);
    try {
      const res = await fetch("/api/pennylane/transactions", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ usage: "consistency" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErreur(data.error || "Connexion Pennylane impossible. Vérifiez le token et ses autorisations.");
        return;
      }
      const transactions = data.transactions as NormalizedBankTransaction[];
      if (transactions.length === 0) {
        setErreur("Aucune transaction bancaire n'a été trouvée sur les 30 derniers jours.");
        return;
      }
      executerControle(transactions);
    } catch {
      setErreur("Pennylane est temporairement indisponible. Réessayez.");
    } finally {
      setChargement(false);
    }
  };

  // Tri purement visuel (impact cash décroissant) — le moteur controlerCoherence lui-même n'est pas
  // réordonné, voir trierIssuesParImpact dans lib/consistencyChecker.ts.
  const issuesVisibles = useMemo(
    () => (resultat ? trierIssuesParImpact(resultat.issues.filter((i) => !ignorees.has(i.id))) : []),
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

  const ignorer = ignorerVerification;

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
    } else if (issue.type === "other_expense_maybe_paid") {
      onChangeAutreDepense(issue.entityId, { payee: true });
    } else if (issue.type === "financing_maybe_received") {
      onChangeFinancement(issue.entityId, { verse: true });
    }
    ignorer(issue.id); // traité : disparaît de la liste courante (session en cours uniquement)
  };

  const messageErreur = erreur instanceof ErreurImportBancaire ? erreur.message : erreur;
  const diagnostic = erreur instanceof ErreurImportBancaire ? erreur.diagnostic : undefined;

  return (
    <div className="table-wrapper">
      <div className="import-bancaire-intro">
        <h4>Vérifier la cohérence de mes données</h4>
        <p>
          {pennylaneConnecte
            ? "Novanta analysera uniquement les 30 derniers jours de vos transactions Pennylane et recherchera les écarts potentiels avec vos données actuelles."
            : "Importez un relevé bancaire Excel. Novanta analysera uniquement les 30 derniers jours et recherchera les écarts potentiels avec vos données actuelles."}
        </p>
        <div className="import-boutons">
          {pennylaneConnecte && (
            <button type="button" className="btn-add" onClick={handleAnalyserPennylane} disabled={chargement}>
              {chargement ? "Analyse en cours…" : "Analyser Pennylane"}
            </button>
          )}
          {pennylaneConnecte && !afficherXlsx && (
            <button type="button" className="btn-secondaire" onClick={() => setAfficherXlsx(true)} disabled={chargement}>
              Utiliser un fichier Excel
            </button>
          )}
          {(!pennylaneConnecte || afficherXlsx) && (
            <button
              type="button"
              className={pennylaneConnecte ? "btn-secondaire" : "btn-add"}
              onClick={() => inputRef.current?.click()}
              disabled={chargement}
            >
              {chargement ? "Analyse en cours…" : "Importer un relevé .xlsx"}
            </button>
          )}
        </div>
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
          {diagnostic ? (
            <>
              <p>{diagnostic.totalLignes} ligne(s) détectée(s)</p>
              <ul className="diagnostic-colonnes">
                <li className={diagnostic.date.ok ? "diagnostic-ok" : "diagnostic-echec"}>
                  <span>{diagnostic.date.ok ? "✓" : "✕"}</span> Date transaction :{" "}
                  {diagnostic.date.ok ? `"${diagnostic.date.detail}"` : diagnostic.date.detail}
                </li>
                <li className={diagnostic.libelle.ok ? "diagnostic-ok" : "diagnostic-echec"}>
                  <span>{diagnostic.libelle.ok ? "✓" : "✕"}</span> Libellé :{" "}
                  {diagnostic.libelle.ok ? `"${diagnostic.libelle.detail}"` : diagnostic.libelle.detail}
                </li>
                <li className={diagnostic.montant.ok ? "diagnostic-ok" : "diagnostic-echec"}>
                  <span>{diagnostic.montant.ok ? "✓" : "✕"}</span> Montant :{" "}
                  {diagnostic.montant.ok ? `"${diagnostic.montant.detail}"` : diagnostic.montant.detail}
                </li>
              </ul>
            </>
          ) : (
            <p>{messageErreur}</p>
          )}
          <div className="import-boutons">
            {diagnostic && (
              <button type="button" className="btn-secondaire" onClick={() => inputRef.current?.click()}>
                Choisir un autre fichier
              </button>
            )}
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
                {resultat.totalTransactions > 1 ? "s" : ""} sur la période récupérée)
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
