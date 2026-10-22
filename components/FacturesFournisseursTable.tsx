"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FactureFournisseur, TriMode } from "@/lib/types";
import {
  decalerDateISO,
  estDateValide,
  estEnRetard,
  estFactureMasquee,
  trierParDate,
  trierParMontant,
} from "@/lib/dates";
import { filtrerFacturesFournisseurs } from "@/lib/recherche";
import { OccurrencesParId } from "@/lib/periodeFiltre";
import { messageSyncPennylane, ResultatSyncPennylane } from "@/lib/pennylaneInvoiceAdapter";
import {
  classerDepense,
  CORRESPONDANCE_VIDE,
  correspondAuFiltreEtage,
  CorrespondanceFutur,
  EtageDepense,
  FiltreEtage,
  idsAAffecter,
} from "@/lib/futurPnl";
import DateField from "./DateField";
import { CaseSelectionLigne, OutilsEtagePnl, SelecteurEtagePnl, useSelectionLignes } from "./EtagePnl";

interface FacturesFournisseursTableProps {
  factures: FactureFournisseur[];
  onChange: (id: string, patch: Partial<FactureFournisseur>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  recherche: string;
  tri: TriMode;
  filtrePeriode?: OccurrencesParId | null;
  pennylaneConnecte?: boolean;
  onSynchroniserPennylane?: () => void;
  syncPennylaneEnCours?: boolean;
  syncPennylaneResultat?: ResultatSyncPennylane | null;
  syncPennylaneErreur?: string | null;
  // Étage P&L (lib/futurPnl.ts) : correspondance partagée et écriture du seul choix manuel.
  correspondance?: CorrespondanceFutur;
  onChangeEtage?: (ids: string[], etage: EtageDepense | null) => void;
}

export default function FacturesFournisseursTable({
  factures,
  onChange,
  onAdd,
  onRemove,
  recherche,
  tri,
  filtrePeriode,
  pennylaneConnecte = false,
  onSynchroniserPennylane,
  syncPennylaneEnCours = false,
  syncPennylaneResultat = null,
  syncPennylaneErreur = null,
  correspondance = CORRESPONDANCE_VIDE,
  onChangeEtage,
}: FacturesFournisseursTableProps) {
  const router = useRouter();
  const [filtreEtage, setFiltreEtage] = useState<FiltreEtage>("tous");
  const { selection, basculer, basculerTout, vider } = useSelectionLignes();
  const facturesTriees = useMemo(() => {
    const actives = factures.filter((f) => !estFactureMasquee(f));
    const dansPeriode = filtrePeriode ? actives.filter((f) => filtrePeriode.has(f.id)) : actives;
    const dansEtage = dansPeriode.filter((f) => correspondAuFiltreEtage(classerDepense(f, correspondance), filtreEtage));
    const filtrees = filtrerFacturesFournisseurs(dansEtage, recherche);
    return tri === "montant"
      ? trierParMontant(filtrees, (f) => f.montant)
      : trierParDate(filtrees, (f) => f.datePaiementPrevue);
  }, [factures, recherche, tri, filtrePeriode, filtreEtage, correspondance]);

  const filtreActif = !!recherche || !!filtrePeriode || filtreEtage !== "tous";
  const idsAffiches = facturesTriees.map((f) => f.id);
  const idsSelectionnes = idsAAffecter(selection, idsAffiches);
  const toutSelectionne = idsAffiches.length > 0 && idsSelectionnes.length === idsAffiches.length;

  return (
    <div className="table-wrapper">
      <h3>Factures fournisseurs</h3>
      {onChangeEtage && (
        <OutilsEtagePnl
          idSection="factures-fournisseurs"
          filtre={filtreEtage}
          onChangeFiltre={setFiltreEtage}
          nombreSelectionnees={idsSelectionnes.length}
          onAffecter={(etage) => {
            onChangeEtage(idsSelectionnes, etage);
            vider();
          }}
          onDeselectionner={vider}
        />
      )}
      {filtreActif && facturesTriees.length === 0 ? (
        <p className="recherche-vide">Aucun résultat dans cette section</p>
      ) : (
      <table className="invoice-table">
        <thead>
          <tr>
            {onChangeEtage && (
              <th className="col-checkbox">
                <input
                  type="checkbox"
                  aria-label="Sélectionner toutes les factures affichées"
                  checked={toutSelectionne}
                  onChange={(e) => basculerTout(idsAffiches, e.target.checked)}
                />
              </th>
            )}
            <th>Facture</th>
            <th>Fournisseur</th>
            <th className="col-montant">Montant</th>
            <th>Échéance</th>
            <th>Paiement prévu</th>
            <th>Décalage rapide</th>
            {onChangeEtage && <th>Étage P&amp;L</th>}
            <th>Litigieuse</th>
            <th>Payée</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {facturesTriees.map((facture) => {
            const enRetard = estEnRetard(facture.datePaiementPrevue, facture.payee, facture.litigieuse);
            const rowClassName = [facture.litigieuse || facture.payee ? "row--litigieuse" : "", enRetard ? "row--en-retard" : ""]
              .filter(Boolean)
              .join(" ");
            return (
            <tr key={facture.id} className={rowClassName}>
              {onChangeEtage && (
                <td className="col-checkbox">
                  <CaseSelectionLigne
                    coche={selection.has(facture.id)}
                    libelleLigne={facture.facture || facture.fournisseur}
                    onChange={(coche) => basculer(facture.id, coche)}
                  />
                </td>
              )}
              <td>
                <input
                  type="text"
                  value={facture.facture}
                  onChange={(e) => onChange(facture.id, { facture: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="text"
                  value={facture.fournisseur}
                  onChange={(e) => onChange(facture.id, { fournisseur: e.target.value })}
                />
              </td>
              <td className="col-montant">
                <input
                  type="number"
                  min="0"
                  value={facture.montant}
                  onChange={(e) => onChange(facture.id, { montant: Math.abs(Number(e.target.value) || 0) })}
                />
              </td>
              <td>
                <DateField
                  value={facture.dateEcheance}
                  onChange={(valeur) => onChange(facture.id, { dateEcheance: valeur })}
                />
              </td>
              <td>
                <DateField
                  className={enRetard ? "date-retard" : ""}
                  value={facture.datePaiementPrevue}
                  onChange={(valeur) => onChange(facture.id, { datePaiementPrevue: valeur })}
                />
                {enRetard && <span className="badge-retard">En retard</span>}
              </td>
              <td className="col-actions">
                {[7, 15, 30].map((jours) => (
                  <button
                    key={jours}
                    type="button"
                    className="btn-shift"
                    disabled={!estDateValide(facture.datePaiementPrevue)}
                    onClick={() =>
                      onChange(facture.id, {
                        datePaiementPrevue: decalerDateISO(facture.datePaiementPrevue, jours),
                      })
                    }
                  >
                    +{jours}j
                  </button>
                ))}
              </td>
              {onChangeEtage && (
                <td>
                  <SelecteurEtagePnl
                    classement={classerDepense(facture, correspondance)}
                    libelleLigne={facture.facture || facture.fournisseur}
                    onChange={(etage) => onChangeEtage([facture.id], etage)}
                  />
                </td>
              )}
              <td className="col-checkbox">
                <span
                  className="checkbox-tooltip"
                  title="Exclut cette facture des projections car son paiement ou son encaissement est incertain."
                >
                  <input
                    type="checkbox"
                    checked={facture.litigieuse}
                    title="Exclut cette facture des projections car son paiement ou son encaissement est incertain."
                    onChange={(e) => onChange(facture.id, { litigieuse: e.target.checked })}
                  />
                </span>
              </td>
              <td className="col-checkbox">
                <span
                  className="checkbox-tooltip"
                  title="Exclut cette facture des projections car elle est déjà comptée dans le Solde bancaire initial."
                >
                  <input
                    type="checkbox"
                    checked={facture.payee}
                    title="Exclut cette facture des projections car elle est déjà comptée dans le Solde bancaire initial."
                    onChange={(e) =>
                      onChange(facture.id, {
                        payee: e.target.checked,
                        paidAt: e.target.checked ? new Date().toISOString() : null,
                      })
                    }
                  />
                </span>
              </td>
              <td className="col-actions">
                <button
                  type="button"
                  className="btn-remove"
                  onClick={() => {
                    if (window.confirm("Supprimer cette facture ?")) onRemove(facture.id);
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
      )}
      <div className="import-actions">
        {onSynchroniserPennylane && (
          <button
            type="button"
            className="btn-add"
            onClick={pennylaneConnecte ? onSynchroniserPennylane : () => router.push("/account/integrations")}
            disabled={syncPennylaneEnCours}
          >
            {!pennylaneConnecte
              ? "Connecter Pennylane"
              : syncPennylaneEnCours
                ? "Synchronisation en cours…"
                : "Synchroniser Pennylane"}
          </button>
        )}
        <button type="button" className="btn-secondaire" onClick={onAdd}>
          + Ajouter une facture fournisseur
        </button>
      </div>

      {syncPennylaneErreur && <p className="login-erreur">{syncPennylaneErreur}</p>}
      {syncPennylaneResultat && (
        <div className="import-apercu">
          <p>{messageSyncPennylane(syncPennylaneResultat)}</p>
          {syncPennylaneResultat.erreurClients && (
            <p className="login-erreur">Factures clients : {syncPennylaneResultat.erreurClients}</p>
          )}
          {syncPennylaneResultat.erreurFournisseurs && (
            <p className="login-erreur">Factures fournisseurs : {syncPennylaneResultat.erreurFournisseurs}</p>
          )}
        </div>
      )}
    </div>
  );
}
