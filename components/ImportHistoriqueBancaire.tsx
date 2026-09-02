"use client";

import { ChangeEvent, useRef, useState } from "react";
import { ChargeFixe } from "@/lib/types";
import { NormalizedBankTransaction } from "@/lib/bankTransaction";
import { formatMontant } from "@/lib/format";
import { formatDateCourte } from "@/lib/dates";
import { ErreurImportBancaire, analyserFichierBancaireXlsx } from "@/lib/bankXlsxAdapter";
import {
  FrequenceDetectee,
  RecurringChargeCandidate,
  detecterChargesRecurrentes,
  trierCandidatsPourAffichage,
} from "@/lib/bankRecurringDetector";
import DateField from "./DateField";

interface ImportHistoriqueBancaireProps {
  onValider: (chargesFixes: ChargeFixe[]) => void;
  pennylaneConnecte?: boolean;
  accessToken?: string | null;
}

interface CandidatBrouillon {
  id: string;
  selectionne: boolean;
  libelle: string;
  montant: number;
  frequence: FrequenceDetectee;
  prochaineOccurrence: string;
  source: RecurringChargeCandidate;
}

// Résumé de la période analysée, indépendant de la source (XLSX ou Pennylane) — alimente le même
// bandeau d'aperçu et le même écran de validation des candidats, quelle que soit l'origine des
// transactions : detecterChargesRecurrentes() ne sait jamais d'où elles viennent.
interface ApercuAnalyse {
  nombreTransactions: number;
  periode: { debut: string; fin: string } | null;
  infoComplementaire: string | null;
}

function candidatVersBrouillon(candidat: RecurringChargeCandidate): CandidatBrouillon {
  return {
    id: candidat.id,
    selectionne: false,
    libelle: candidat.libellePropose,
    montant: candidat.montantPropose,
    frequence: candidat.frequence,
    prochaineOccurrence: candidat.prochaineOccurrenceEstimee,
    source: candidat,
  };
}

function periodeDepuisTransactions(transactions: NormalizedBankTransaction[]): { debut: string; fin: string } | null {
  if (transactions.length === 0) return null;
  const dates = transactions.map((t) => t.date).sort();
  return { debut: dates[0], fin: dates[dates.length - 1] };
}

export default function ImportHistoriqueBancaire({
  onValider,
  pennylaneConnecte = false,
  accessToken = null,
}: ImportHistoriqueBancaireProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [chargement, setChargement] = useState(false);
  const [erreur, setErreur] = useState<ErreurImportBancaire | string | null>(null);
  const [apercu, setApercu] = useState<ApercuAnalyse | null>(null);
  const [candidats, setCandidats] = useState<CandidatBrouillon[]>([]);
  const [creationEnCours, setCreationEnCours] = useState(false);
  // Formulaire XLSX visible par défaut si Pennylane n'est pas connecté ; sinon masqué derrière
  // "Utiliser un fichier Excel" au profit d'"Analyser Pennylane" en action principale.
  const [afficherXlsx, setAfficherXlsx] = useState(!pennylaneConnecte);

  const reinitialiser = () => {
    setErreur(null);
    setApercu(null);
    setCandidats([]);
  };

  const traiterTransactions = (transactions: NormalizedBankTransaction[], infoComplementaire: string | null) => {
    setApercu({
      nombreTransactions: transactions.length,
      periode: periodeDepuisTransactions(transactions),
      infoComplementaire,
    });
    // Même moteur, même tri d'affichage, que la source soit XLSX ou Pennylane — voir
    // lib/pennylaneTransactionAdapter.ts pour la preuve d'équivalence.
    const candidatsDetectes = trierCandidatsPourAffichage(detecterChargesRecurrentes(transactions));
    setCandidats(candidatsDetectes.map(candidatVersBrouillon));
  };

  const handleFichierSelectionne = async (e: ChangeEvent<HTMLInputElement>) => {
    const fichier = e.target.files?.[0];
    e.target.value = "";
    if (!fichier) return;

    reinitialiser();
    setChargement(true);
    try {
      const analyse = await analyserFichierBancaireXlsx(fichier);
      const infoIgnorees = analyse.lignesIgnorees > 0 ? analyse.raisonsIgnorees.join(" ") : null;
      traiterTransactions(analyse.transactions, infoIgnorees);
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
        body: JSON.stringify({ usage: "charges_fixes" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErreur(data.error || "Connexion Pennylane impossible. Vérifiez le token et ses autorisations.");
        return;
      }
      const transactions = data.transactions as NormalizedBankTransaction[];
      if (transactions.length === 0) {
        setErreur("Aucune transaction exploitable n'a été trouvée sur la période.");
        return;
      }
      traiterTransactions(transactions, null);
    } catch {
      setErreur("Pennylane est temporairement indisponible. Réessayez.");
    } finally {
      setChargement(false);
    }
  };

  const patchCandidat = (id: string, patch: Partial<CandidatBrouillon>) => {
    setCandidats((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const nombreSelectionnes = candidats.filter((c) => c.selectionne).length;

  const handleValider = () => {
    if (nombreSelectionnes === 0 || creationEnCours) return;
    setCreationEnCours(true);

    const chargesFixes: ChargeFixe[] = candidats
      .filter((c) => c.selectionne)
      .map((c) => ({
        id: crypto.randomUUID(),
        libelle: c.libelle,
        montant: c.montant,
        datePrevue: c.prochaineOccurrence,
        recurrence: c.frequence,
        dateFin: null,
        modeMontant: "fixe",
        tauxCalcul: null,
        sourceCalculId: null,
        sourceCalculType: null,
        aCouper: false,
      }));

    onValider(chargesFixes);
    // Le flux est réinitialisé immédiatement après validation : impossible de recliquer sur le
    // même écran pour recréer une seconde fois les mêmes charges (double clic / resoumission).
    reinitialiser();
    setCreationEnCours(false);
  };

  const messageErreur = erreur instanceof ErreurImportBancaire ? erreur.message : erreur;
  const diagnostic = erreur instanceof ErreurImportBancaire ? erreur.diagnostic : undefined;

  return (
    <div className="table-wrapper">
      <div className="import-bancaire-intro">
        <p>
          {pennylaneConnecte
            ? "Novanta recherchera les dépenses récurrentes dans vos transactions Pennylane et vous proposera celles à intégrer à vos projections."
            : "Importez votre historique bancaire au format Excel. Novanta recherchera les dépenses récurrentes et vous proposera celles à intégrer à vos projections."}
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

      {apercu && (
        <div className="import-apercu">
          <p>
            {apercu.nombreTransactions} transaction{apercu.nombreTransactions > 1 ? "s" : ""} analysée
            {apercu.nombreTransactions > 1 ? "s" : ""}
            {apercu.periode &&
              ` — Du ${formatDateCourte(apercu.periode.debut)} au ${formatDateCourte(apercu.periode.fin)}`}
            {" — "}
            {candidats.length} charge{candidats.length > 1 ? "s" : ""} récurrente{candidats.length > 1 ? "s" : ""}{" "}
            potentielle{candidats.length > 1 ? "s" : ""} identifiée{candidats.length > 1 ? "s" : ""}
          </p>
          {apercu.infoComplementaire && <p className="import-bancaire-info">{apercu.infoComplementaire}</p>}

          {candidats.length === 0 ? (
            <p className="recherche-vide">Aucune dépense récurrente évidente n&apos;a été identifiée dans ce relevé.</p>
          ) : (
            <>
              <table className="invoice-table">
                <thead>
                  <tr>
                    <th></th>
                    <th>Charge</th>
                    <th className="col-montant">Montant proposé</th>
                    <th>Fréquence</th>
                    <th>Historique</th>
                    <th>Prochaine occurrence</th>
                  </tr>
                </thead>
                <tbody>
                  {candidats.map((c) => (
                    <tr key={c.id}>
                      <td className="col-checkbox">
                        <input
                          type="checkbox"
                          checked={c.selectionne}
                          onChange={(e) => patchCandidat(c.id, { selectionne: e.target.checked })}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={c.libelle}
                          onChange={(e) => patchCandidat(c.id, { libelle: e.target.value })}
                        />
                        <p className="occurrences-periode">
                          {formatMontant(c.source.montantMin)} – {formatMontant(c.source.montantMax)} ·{" "}
                          {c.source.nombreOccurrences} occurrences · dernière opération le{" "}
                          {formatDateCourte(c.source.derniereOccurrence)}
                        </p>
                      </td>
                      <td className="col-montant">
                        <input
                          type="number"
                          value={c.montant}
                          onChange={(e) => patchCandidat(c.id, { montant: Number(e.target.value) })}
                        />
                        <p className="occurrences-periode">
                          {c.source.profilMontant === "stable" ? "Montant stable" : "Montant variable"}
                        </p>
                      </td>
                      <td>
                        <select
                          value={c.frequence}
                          onChange={(e) => patchCandidat(c.id, { frequence: e.target.value as FrequenceDetectee })}
                        >
                          <option value="hebdomadaire">Hebdomadaire</option>
                          <option value="mensuel">Mensuelle</option>
                        </select>
                      </td>
                      <td>{c.source.nombreOccurrences} occurrences</td>
                      <td>
                        <DateField
                          value={c.prochaineOccurrence}
                          onChange={(valeur) => patchCandidat(c.id, { prochaineOccurrence: valeur })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="import-boutons">
                <button type="button" className="btn-secondaire" onClick={reinitialiser}>
                  Annuler
                </button>
                <button
                  type="button"
                  className="btn-add"
                  disabled={nombreSelectionnes === 0 || creationEnCours}
                  onClick={handleValider}
                >
                  {nombreSelectionnes === 0
                    ? "Ajouter des Charges fixes"
                    : `Ajouter ${nombreSelectionnes} Charge${nombreSelectionnes > 1 ? "s" : ""} fixe${
                        nombreSelectionnes > 1 ? "s" : ""
                      }`}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
