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
import {
  calculerSynchronisation,
  candidatVersFactureClient,
  candidatVersFactureFournisseur,
} from "@/lib/pennylaneInvoiceAdapter";

interface ImportFacturesProps {
  onImporter: (facturesClients: FactureClient[], facturesFournisseurs: FactureFournisseur[]) => void;
  facturesClients: FactureClient[];
  facturesFournisseurs: FactureFournisseur[];
  onSynchroniserPennylane: (
    nouvellesFacturesClients: FactureClient[],
    nouvellesFacturesFournisseurs: FactureFournisseur[],
    idsClientsAMettreAJourPayee: string[],
    idsFournisseursAMettreAJourPayee: string[]
  ) => void;
  pennylaneConnecte?: boolean;
  accessToken?: string | null;
}

interface ResultatSyncPennylane {
  nombreClientsAjoutes: number;
  nombreFournisseursAjoutes: number;
  nombreMarquesPayees: number;
  erreurClients: string | null;
  erreurFournisseurs: string | null;
}

export default function ImportFactures({
  onImporter,
  facturesClients,
  facturesFournisseurs,
  onSynchroniserPennylane,
  pennylaneConnecte = false,
  accessToken = null,
}: ImportFacturesProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [resultat, setResultat] = useState<ResultatImport | null>(null);
  const [erreurLecture, setErreurLecture] = useState<string | null>(null);
  const [syncEnCours, setSyncEnCours] = useState(false);
  const [syncResultat, setSyncResultat] = useState<ResultatSyncPennylane | null>(null);
  const [syncErreur, setSyncErreur] = useState<string | null>(null);

  const handleSynchroniserPennylane = async () => {
    if (!accessToken || syncEnCours) return;
    setSyncEnCours(true);
    setSyncErreur(null);
    setSyncResultat(null);

    try {
      const res = await fetch("/api/pennylane/invoices", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          facturesClientsConnues: facturesClients
            .filter((f) => f.pennylaneId)
            .map((f) => ({ pennylaneId: f.pennylaneId as string, payee: f.payee })),
          facturesFournisseursConnues: facturesFournisseurs
            .filter((f) => f.pennylaneId)
            .map((f) => ({ pennylaneId: f.pennylaneId as string, payee: f.payee })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSyncErreur(data.error || "Synchronisation Pennylane impossible. Vérifiez le token et ses autorisations.");
        return;
      }

      const facturesClientsExistantesPourSync = facturesClients.map((f) => ({
        id: f.id,
        pennylaneId: f.pennylaneId,
        payee: f.payee,
      }));
      const facturesFournisseursExistantesPourSync = facturesFournisseurs.map((f) => ({
        id: f.id,
        pennylaneId: f.pennylaneId,
        payee: f.payee,
      }));

      let nombreClientsAjoutes = 0;
      let nombreFournisseursAjoutes = 0;
      let idsClientsAMettreAJourPayee: string[] = [];
      let idsFournisseursAMettreAJourPayee: string[] = [];
      let nouvellesFacturesClients: FactureClient[] = [];
      let nouvellesFacturesFournisseurs: FactureFournisseur[] = [];

      if (data.clientCandidates) {
        const { aInserer, idsAMettreAJourPayee } = calculerSynchronisation(
          data.clientCandidates,
          facturesClientsExistantesPourSync
        );
        nouvellesFacturesClients = aInserer.map(candidatVersFactureClient);
        idsClientsAMettreAJourPayee = idsAMettreAJourPayee;
        nombreClientsAjoutes = nouvellesFacturesClients.length;
      }

      if (data.fournisseurCandidates) {
        const { aInserer, idsAMettreAJourPayee } = calculerSynchronisation(
          data.fournisseurCandidates,
          facturesFournisseursExistantesPourSync
        );
        nouvellesFacturesFournisseurs = aInserer.map(candidatVersFactureFournisseur);
        idsFournisseursAMettreAJourPayee = idsAMettreAJourPayee;
        nombreFournisseursAjoutes = nouvellesFacturesFournisseurs.length;
      }

      onSynchroniserPennylane(
        nouvellesFacturesClients,
        nouvellesFacturesFournisseurs,
        idsClientsAMettreAJourPayee,
        idsFournisseursAMettreAJourPayee
      );

      setSyncResultat({
        nombreClientsAjoutes,
        nombreFournisseursAjoutes,
        nombreMarquesPayees: idsClientsAMettreAJourPayee.length + idsFournisseursAMettreAJourPayee.length,
        erreurClients: data.erreurClients ?? null,
        erreurFournisseurs: data.erreurFournisseurs ?? null,
      });
    } catch {
      setSyncErreur("Pennylane est temporairement indisponible. Réessayez.");
    } finally {
      setSyncEnCours(false);
    }
  };

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
    const facturesClientsImportees = resultat.lignesValides
      .filter((l) => l.type === "client")
      .map((l) => l.facture as FactureClient);
    const facturesFournisseursImportees = resultat.lignesValides
      .filter((l) => l.type === "fournisseur")
      .map((l) => l.facture as FactureFournisseur);
    onImporter(facturesClientsImportees, facturesFournisseursImportees);
    setResultat(null);
  };

  return (
    <div className="table-wrapper">
      <div className="import-actions">
        {pennylaneConnecte && (
          <button type="button" className="btn-add" onClick={handleSynchroniserPennylane} disabled={syncEnCours}>
            {syncEnCours ? "Synchronisation en cours…" : "Synchroniser Pennylane"}
          </button>
        )}
        <button type="button" className="btn-secondaire" onClick={() => inputRef.current?.click()}>
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

      {syncErreur && <div className="login-erreur">{syncErreur}</div>}

      {syncResultat && (
        <div className="import-apercu">
          <p>
            Pennylane synchronisé — {syncResultat.nombreClientsAjoutes} facture{syncResultat.nombreClientsAjoutes > 1 ? "s" : ""} client
            {syncResultat.nombreClientsAjoutes > 1 ? "s" : ""} ajoutée{syncResultat.nombreClientsAjoutes > 1 ? "s" : ""},{" "}
            {syncResultat.nombreFournisseursAjoutes} facture{syncResultat.nombreFournisseursAjoutes > 1 ? "s" : ""} fournisseur
            {syncResultat.nombreFournisseursAjoutes > 1 ? "s" : ""} ajoutée{syncResultat.nombreFournisseursAjoutes > 1 ? "s" : ""},{" "}
            {syncResultat.nombreMarquesPayees} facture{syncResultat.nombreMarquesPayees > 1 ? "s" : ""} marquée
            {syncResultat.nombreMarquesPayees > 1 ? "s" : ""} payée{syncResultat.nombreMarquesPayees > 1 ? "s" : ""}.
          </p>
          {syncResultat.erreurClients && (
            <p className="login-erreur">Factures clients : {syncResultat.erreurClients}</p>
          )}
          {syncResultat.erreurFournisseurs && (
            <p className="login-erreur">Factures fournisseurs : {syncResultat.erreurFournisseurs}</p>
          )}
        </div>
      )}

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
