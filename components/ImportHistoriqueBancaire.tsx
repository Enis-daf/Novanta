"use client";

import { ChangeEvent, useRef, useState } from "react";
import { ChargeFixe } from "@/lib/types";
import { formatMontant } from "@/lib/format";
import { formatDateCourte } from "@/lib/dates";
import { ErreurImportBancaire, ResultatAnalyseBancaire, analyserFichierBancaireXlsx } from "@/lib/bankXlsxAdapter";
import { FrequenceDetectee, RecurringChargeCandidate, detecterChargesRecurrentes } from "@/lib/bankRecurringDetector";
import DateField from "./DateField";

interface ImportHistoriqueBancaireProps {
  onValider: (chargesFixes: ChargeFixe[]) => void;
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

export default function ImportHistoriqueBancaire({ onValider }: ImportHistoriqueBancaireProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [chargement, setChargement] = useState(false);
  const [erreur, setErreur] = useState<ErreurImportBancaire | null>(null);
  const [resultat, setResultat] = useState<ResultatAnalyseBancaire | null>(null);
  const [candidats, setCandidats] = useState<CandidatBrouillon[]>([]);
  const [creationEnCours, setCreationEnCours] = useState(false);

  const reinitialiser = () => {
    setErreur(null);
    setResultat(null);
    setCandidats([]);
  };

  const handleFichierSelectionne = async (e: ChangeEvent<HTMLInputElement>) => {
    const fichier = e.target.files?.[0];
    e.target.value = "";
    if (!fichier) return;

    reinitialiser();
    setChargement(true);
    try {
      const analyse = await analyserFichierBancaireXlsx(fichier);
      setResultat(analyse);
      setCandidats(detecterChargesRecurrentes(analyse.transactions).map(candidatVersBrouillon));
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

  return (
    <div className="table-wrapper">
      <div className="import-bancaire-intro">
        <p>
          Importez votre historique bancaire au format Excel. Novanta recherchera les dépenses récurrentes et vous
          proposera celles à intégrer à vos projections.
        </p>
        <button
          type="button"
          className="btn-add"
          onClick={() => inputRef.current?.click()}
          disabled={chargement}
        >
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
            {resultat.transactions.length} transaction{resultat.transactions.length > 1 ? "s" : ""} analysée
            {resultat.transactions.length > 1 ? "s" : ""}
            {resultat.periode &&
              ` — Du ${formatDateCourte(resultat.periode.debut)} au ${formatDateCourte(resultat.periode.fin)}`}
            {" — "}
            {candidats.length} charge{candidats.length > 1 ? "s" : ""} récurrente{candidats.length > 1 ? "s" : ""}{" "}
            potentielle{candidats.length > 1 ? "s" : ""} identifiée{candidats.length > 1 ? "s" : ""}
          </p>
          {resultat.lignesIgnorees > 0 && (
            <p className="import-bancaire-info">{resultat.raisonsIgnorees.join(" ")}</p>
          )}

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
