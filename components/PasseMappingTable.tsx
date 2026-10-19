"use client";

import MentionTTC from "./MentionTTC";
import { useState } from "react";
import { formatMontant } from "@/lib/format";
import { estEtageConvertiEnHt, estTauxTvaValide, LIBELLE_TVA_NON_APPLICABLE, LIBELLE_TVA_SANS_OBJET, TAUX_TVA_PROPOSES } from "@/lib/pastHtEstime";
import {
  EtagePnl,
  ETAGES_PNL,
  FiltreMapping,
  filtrerLignesMapping,
  LigneMapping,
} from "@/lib/pastCategoryMapping";

interface PasseMappingTableProps {
  lignes: LigneMapping[];
  filtre: FiltreMapping;
  onChangeFiltre: (filtre: FiltreMapping) => void;
  onChangeEtage: (sourceCategoryId: string, etage: EtagePnl) => void;
  // Taux de TVA estimé (null = « Non défini ») : sert à la lecture HT estimé du reporting.
  onChangeTva: (sourceCategoryId: string, taux: number | null) => void;
}

const formatTaux = (taux: number) => `${taux.toLocaleString("fr-FR")} %`;
const AUTRE = "autre";

/**
 * Taux de TVA estimé d'une catégorie : « Non défini » par défaut (jamais prérempli), un taux
 * courant, ou un autre taux saisi. Sans objet pour Virements internes & Financement (jamais converti)
 * et pour la TVA (exclue du HT).
 */
function SelecteurTva({ ligne, onChange }: { ligne: LigneMapping; onChange: (taux: number | null) => void }) {
  const taux = ligne.vatRate ?? null;
  const tauxPropose = taux !== null && (TAUX_TVA_PROPOSES as readonly number[]).includes(taux);
  const [saisieLibre, setSaisieLibre] = useState(taux !== null && !tauxPropose);
  const [brouillon, setBrouillon] = useState(taux !== null && !tauxPropose ? String(taux).replace(".", ",") : "");

  // Étage TVA : le mouvement EST de la TVA — exclu du HT, repris tel quel en TTC. Aucun taux à
  // saisir, et jamais « 0 % » pour contourner.
  if (ligne.pnlStage === "vat") {
    return (
      <span className="passe-mapping__tva-sans-objet" title={LIBELLE_TVA_NON_APPLICABLE}>
        — <span className="passe-visuellement-cache">{LIBELLE_TVA_NON_APPLICABLE}</span>
      </span>
    );
  }
  if (ligne.pnlStage !== null && !estEtageConvertiEnHt(ligne.pnlStage)) {
    return <span className="passe-mapping__tva-sans-objet" title={LIBELLE_TVA_SANS_OBJET}>Sans objet</span>;
  }
  const valider = () => {
    const valeur = Number(brouillon.replace(",", ".").trim());
    if (brouillon.trim() !== "" && estTauxTvaValide(valeur)) onChange(Math.round(valeur * 100) / 100);
  };
  return (
    <span className="passe-mapping__tva">
      <select
        aria-label={`TVA estimée de la catégorie ${ligne.sourceCategoryName}`}
        value={saisieLibre ? AUTRE : taux === null ? "" : String(taux)}
        onChange={(e) => {
          const valeur = e.target.value;
          if (valeur === AUTRE) {
            setSaisieLibre(true);
            return;
          }
          setSaisieLibre(false);
          onChange(valeur === "" ? null : Number(valeur));
        }}
      >
        <option value="">Non défini</option>
        {TAUX_TVA_PROPOSES.map((t) => (
          <option key={t} value={String(t)}>
            {formatTaux(t)}
          </option>
        ))}
        <option value={AUTRE}>Autre…</option>
      </select>
      {saisieLibre && (
        <input
          type="text"
          inputMode="decimal"
          className="passe-mapping__tva-libre"
          aria-label={`Autre taux de TVA pour ${ligne.sourceCategoryName}, en %`}
          placeholder="%"
          value={brouillon}
          onChange={(e) => setBrouillon(e.target.value)}
          onBlur={valider}
          onKeyDown={(e) => e.key === "Enter" && valider()}
        />
      )}
    </span>
  );
}

const formatNombre = new Intl.NumberFormat("fr-FR");

// Table de correspondance catégorie source -> étage P&L. Toujours accessible et modifiable : ce
// n'est pas un écran d'onboarding. Le nombre et le montant suivent la période affichée ; le
// mapping lui-même en est indépendant.
export default function PasseMappingTable({ lignes, filtre, onChangeFiltre, onChangeEtage, onChangeTva }: PasseMappingTableProps) {
  const lignesFiltrees = filtrerLignesMapping(lignes, filtre);

  return (
    <div className="passe-mapping">
      <div className="passe-controle passe-axe">
        <label className="passe-controle__label" htmlFor="passe-mapping-filtre">
          Afficher
        </label>
        <select
          id="passe-mapping-filtre"
          value={filtre}
          onChange={(e) => onChangeFiltre(e.target.value as FiltreMapping)}
        >
          <option value="toutes">Toutes les catégories</option>
          <option value="a_mapper">À mapper</option>
          <option value="mappees">Mappées</option>
          <optgroup label="Par étage P&L">
            {ETAGES_PNL.map((etage) => (
              <option key={etage.cle} value={etage.cle}>
                {etage.libelle}
              </option>
            ))}
          </optgroup>
        </select>
      </div>

      {lignes.length === 0 ? (
        <div className="passe-etat">
          <p>Aucune catégorie connue pour le moment.</p>
          <p>Les catégories apparaissent ici après une synchronisation.</p>
        </div>
      ) : lignesFiltrees.length === 0 ? (
        <div className="passe-etat">Aucune catégorie ne correspond à ce filtre.</div>
      ) : (
        <div className="table-wrapper">
          <table className="passe-table">
            <thead>
              <tr>
                <th>Catégorie</th>
                <th className="col-montant">Transactions sur la période</th>
                <th className="col-montant">
                  Montant sur la période
                  <MentionTTC />
                </th>
                <th>Étage P&amp;L</th>
                <th>TVA estimée</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {lignesFiltrees.map((ligne) => (
                <tr key={ligne.sourceCategoryId}>
                  <td className="passe-table__libelle">{ligne.sourceCategoryName}</td>
                  <td className="col-montant passe-table__montant">{formatNombre.format(ligne.nombreTransactions)}</td>
                  <td className="col-montant passe-table__montant">{formatMontant(ligne.montantTotal)}</td>
                  <td className="passe-axe">
                    <select
                      aria-label={`Étage P&L de la catégorie ${ligne.sourceCategoryName}`}
                      value={ligne.pnlStage ?? ""}
                      onChange={(e) => e.target.value && onChangeEtage(ligne.sourceCategoryId, e.target.value as EtagePnl)}
                    >
                      {ligne.pnlStage === null && <option value="">À choisir…</option>}
                      {ETAGES_PNL.map((etage) => (
                        <option key={etage.cle} value={etage.cle}>
                          {etage.libelle}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <SelecteurTva key={`${ligne.sourceCategoryId}:${ligne.vatRate ?? "nd"}`} ligne={ligne} onChange={(taux) => onChangeTva(ligne.sourceCategoryId, taux)} />
                  </td>
                  <td>
                    {ligne.pnlStage === null ? (
                      <span className="passe-statut passe-statut--a-mapper">À mapper</span>
                    ) : (
                      <span className="passe-statut">Mappé</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
