"use client";

import { ChangeEvent, useRef, useState } from "react";
import { FactureClient, FactureFournisseur } from "@/lib/types";
import { formatMontant } from "@/lib/format";
import {
  ResultatImport,
  genererModeleXLSX,
  lireFichierImport,
  validerLignesImport,
} from "@/lib/importFactures";

interface ImportFacturesProps {
  onImporter: (facturesClients: FactureClient[], facturesFournisseurs: FactureFournisseur[]) => void;
}

export default function ImportFactures({ onImporter }: ImportFacturesProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [resultat, setResultat] = useState<ResultatImport | null>(null);
  const [erreurLecture, setErreurLecture] = useState<string | null>(null);

  const handleFichierSelectionne = async (e: ChangeEvent<HTMLInputElement>) => {
    const fichier = e.target.files?.[0];
    e.target.value = "";
    if (!fichier) return;

    setErreurLecture(null);
    setResultat(null);

    try {
      const lignesBrutes = await lireFichierImport(fichier);
      setResultat(validerLignesImport(lignesBrutes));
    } catch {
      setErreurLecture("Impossible de lire ce fichier. Vérifiez qu'il s'agit bien d'un CSV ou Excel valide.");
    }
  };

  const handleTelechargerModele = () => {
    const blob = genererModeleXLSX();
    const url = URL.createObjectURL(blob);
    const lien = document.createElement("a");
    lien.href = url;
    lien.download = "modele-import-factures.xlsx";
    lien.click();
    URL.revokeObjectURL(url);
  };

  const handleAnnuler = () => {
    setResultat(null);
    setErreurLecture(null);
  };

  const handleConfirmerImport = () => {
    if (!resultat) return;
    const facturesClients = resultat.lignesValides
      .filter((l) => l.type === "client")
      .map((l) => l.facture as FactureClient);
    const facturesFournisseurs = resultat.lignesValides
      .filter((l) => l.type === "fournisseur")
      .map((l) => l.facture as FactureFournisseur);
    onImporter(facturesClients, facturesFournisseurs);
    setResultat(null);
  };

  return (
    <div className="table-wrapper">
      <h3>Import de factures</h3>
      <div className="import-actions">
        <button type="button" className="btn-add" onClick={() => inputRef.current?.click()}>
          Importer des factures
        </button>
        <button type="button" className="btn-secondaire" onClick={handleTelechargerModele}>
          Télécharger le modèle Excel
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx,.xls"
          onChange={handleFichierSelectionne}
          style={{ display: "none" }}
        />
      </div>

      {erreurLecture && <div className="login-erreur">{erreurLecture}</div>}

      {resultat && (
        <div className="import-apercu">
          <p>
            {resultat.totalLignes} ligne(s) détectée(s) — {resultat.nombreClients} facture(s) client(s),{" "}
            {resultat.nombreFournisseurs} facture(s) fournisseur(s).
          </p>

          {resultat.lignesErreur.length > 0 && (
            <>
              <p className="login-erreur">{resultat.lignesErreur.length} ligne(s) en erreur :</p>
              <table className="invoice-table">
                <thead>
                  <tr>
                    <th>Ligne</th>
                    <th>Motif</th>
                  </tr>
                </thead>
                <tbody>
                  {resultat.lignesErreur.map((erreur) => (
                    <tr key={erreur.ligne}>
                      <td>{erreur.ligne}</td>
                      <td>{erreur.motifs.join("; ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {resultat.lignesValides.length > 0 && (
            <>
              <p>Lignes valides :</p>
              <table className="invoice-table">
                <thead>
                  <tr>
                    <th>Ligne</th>
                    <th>Type</th>
                    <th>Facture</th>
                    <th>Tiers</th>
                    <th className="col-montant">Montant</th>
                  </tr>
                </thead>
                <tbody>
                  {resultat.lignesValides.map((ligneValide) => (
                    <tr key={ligneValide.ligne}>
                      <td>{ligneValide.ligne}</td>
                      <td>{ligneValide.type === "client" ? "Client" : "Fournisseur"}</td>
                      <td>{ligneValide.facture.facture}</td>
                      <td>
                        {ligneValide.type === "client"
                          ? (ligneValide.facture as FactureClient).client
                          : (ligneValide.facture as FactureFournisseur).fournisseur}
                      </td>
                      <td className="col-montant">{formatMontant(ligneValide.facture.montant)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <div className="import-boutons">
            <button type="button" className="btn-secondaire" onClick={handleAnnuler}>
              Annuler
            </button>
            <button
              type="button"
              className="btn-add"
              disabled={resultat.lignesValides.length === 0}
              onClick={handleConfirmerImport}
            >
              Importer les lignes valides ({resultat.lignesValides.length})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
