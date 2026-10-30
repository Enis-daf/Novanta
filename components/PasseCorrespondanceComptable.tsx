"use client";

import { useMemo, useState } from "react";
import { formatMontant } from "@/lib/format";
import {
  erreurRegle,
  HORS_PERIMETRE,
  indexerRegles,
  LIBELLE_HORS_PERIMETRE,
  libelleDestination,
  LIGNES_COMPTABLES,
  RegleCorrespondance,
} from "@/lib/comptaCorrespondance";
import { filtrerComptes, FiltreComptes, lignesCorrespondance, LigneCompteCorrespondance } from "@/lib/comptaLecture";
import { CompteAnalyse } from "@/lib/comptaPnl";

interface PasseCorrespondanceComptableProps {
  comptes: CompteAnalyse[];
  regles: RegleCorrespondance[];
  // Date de la dernière synchronisation : un compte vu pour la première fois depuis est « Nouveau ».
  nouveauxComptes: ReadonlySet<string>;
  onEnregistrer: (regle: RegleCorrespondance) => void;
  onSupprimer: (prefixe: string) => void;
  onAppliquerModele: () => void;
  erreur: string | null;
}

const formatNombre = new Intl.NumberFormat("fr-FR");

const FILTRES: { cle: FiltreComptes; libelle: string }[] = [
  { cle: "tous", libelle: "Tous les comptes" },
  { cle: "non_affectes", libelle: "Non affectés" },
  { cle: "affectes", libelle: "Affectés" },
  { cle: "hors_perimetre", libelle: "Hors périmètre" },
  { cle: "bilan", libelle: "Comptes de bilan" },
];

function LigneCompte({ ligne, onAffecter }: { ligne: LigneCompteCorrespondance; onAffecter: (compte: string) => void }) {
  return (
    <tr>
      <td className="passe-table__libelle">
        {ligne.compte}
        {ligne.nouveau && <span className="passe-statut passe-statut--a-mapper"> Nouveau</span>}
      </td>
      <td className="passe-table__libelle">{ligne.libelle ?? "—"}</td>
      <td className="col-montant passe-table__montant">{formatNombre.format(ligne.nombreLignes)}</td>
      <td className="col-montant passe-table__montant">{formatMontant(ligne.montant)}</td>
      <td>{ligne.regle ? `${ligne.regle.prefixe} · ${ligne.regle.categorie}` : "—"}</td>
      <td>
        {ligne.statut === "non_affecte" ? (
          <button type="button" className="passe-lien-ligne" onClick={() => onAffecter(ligne.compte)}>
            Affecter
          </button>
        ) : ligne.statut === "bilan" ? (
          <span className="passe-statut">Bilan, hors P&amp;L</span>
        ) : ligne.statut === "hors_perimetre" ? (
          <span className="passe-statut">{LIBELLE_HORS_PERIMETRE}</span>
        ) : (
          <span className="passe-statut">{libelleDestination(ligne.regle!.destination)}</span>
        )}
      </td>
    </tr>
  );
}

// Correspondance comptable : même lecture que « Correspondance P&L » (filtre, tableau, statut), sur un
// autre modèle. La saisie porte sur une racine : elle couvre tous les comptes qui commencent ainsi, et
// la racine la plus longue l'emporte.
export default function PasseCorrespondanceComptable({ comptes, regles, nouveauxComptes, onEnregistrer, onSupprimer, onAppliquerModele, erreur }: PasseCorrespondanceComptableProps) {
  const [filtre, setFiltre] = useState<FiltreComptes>("tous");
  const [saisie, setSaisie] = useState<RegleCorrespondance>({ prefixe: "", destination: "structure_costs", categorie: "" });
  const [tentative, setTentative] = useState(false);
  const lignes = useMemo(() => lignesCorrespondance(comptes, indexerRegles(regles), nouveauxComptes), [comptes, regles, nouveauxComptes]);
  const visibles = useMemo(() => filtrerComptes(lignes, filtre), [lignes, filtre]);
  const reglesTriees = useMemo(() => [...regles].sort((a, b) => a.prefixe.localeCompare(b.prefixe)), [regles]);
  const erreurSaisie = tentative ? erreurRegle(saisie) : null;

  const enregistrer = () => {
    setTentative(true);
    if (erreurRegle(saisie)) return;
    onEnregistrer({ ...saisie, categorie: saisie.categorie.trim() });
    setSaisie({ prefixe: "", destination: saisie.destination, categorie: "" });
    setTentative(false);
  };

  return (
    <div className="passe-mapping">
      {erreur && <p className="login-erreur">{erreur}</p>}
      {regles.length === 0 && (
        <div className="passe-etat">
          <p>Aucune correspondance pour le moment.</p>
          <p>Partez du modèle Novanta, puis ajustez-le à votre plan de comptes.</p>
          <button type="button" className="btn-add" onClick={onAppliquerModele}>
            Appliquer le modèle
          </button>
        </div>
      )}

      <div className="compta-saisie">
        <div className="compta-saisie__champ">
          <label className="passe-controle__label" htmlFor="compta-prefixe">
            Compte ou racine
          </label>
          <input id="compta-prefixe" type="text" inputMode="numeric" placeholder="604" value={saisie.prefixe} onChange={(e) => setSaisie({ ...saisie, prefixe: e.target.value.trim() })} />
        </div>
        <div className="compta-saisie__champ">
          <label className="passe-controle__label" htmlFor="compta-categorie">
            Catégorie
          </label>
          <input id="compta-categorie" type="text" placeholder="Prestations de service" value={saisie.categorie} onChange={(e) => setSaisie({ ...saisie, categorie: e.target.value })} />
        </div>
        <div className="compta-saisie__champ">
          <label className="passe-controle__label" htmlFor="compta-destination">
            Ligne du P&amp;L
          </label>
          <select id="compta-destination" value={saisie.destination} onChange={(e) => setSaisie({ ...saisie, destination: e.target.value as RegleCorrespondance["destination"] })}>
            {LIGNES_COMPTABLES.map((l) => (
              <option key={l.cle} value={l.cle}>
                {l.libelle}
              </option>
            ))}
            <option value={HORS_PERIMETRE}>{LIBELLE_HORS_PERIMETRE}</option>
          </select>
        </div>
        <button type="button" className="btn-add" onClick={enregistrer}>
          Enregistrer
        </button>
        {erreurSaisie && <p className="login-erreur compta-saisie__erreur">{erreurSaisie}</p>}
      </div>

      <div className="passe-controle passe-axe">
        <label className="passe-controle__label" htmlFor="compta-filtre">
          Afficher
        </label>
        <select id="compta-filtre" value={filtre} onChange={(e) => setFiltre(e.target.value as FiltreComptes)}>
          {FILTRES.map((f) => (
            <option key={f.cle} value={f.cle}>
              {f.libelle}
            </option>
          ))}
        </select>
      </div>

      {comptes.length === 0 ? (
        <div className="passe-etat">
          <p>Aucun compte mouvementé sur la période.</p>
        </div>
      ) : visibles.length === 0 ? (
        <div className="passe-etat">Aucun compte ne correspond à ce filtre.</div>
      ) : (
        <div className="table-wrapper">
          <table className="passe-table">
            <thead>
              <tr>
                <th>Compte</th>
                <th>Libellé</th>
                <th className="col-montant">Lignes sur la période</th>
                <th className="col-montant">Montant sur la période</th>
                <th>Racine appliquée</th>
                <th>Affectation</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((ligne) => (
                <LigneCompte key={ligne.compte} ligne={ligne} onAffecter={(compte) => setSaisie({ ...saisie, prefixe: compte })} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reglesTriees.length > 0 && (
        <details className="compta-regles">
          <summary>Règles de correspondance ({formatNombre.format(reglesTriees.length)})</summary>
          <div className="table-wrapper">
            <table className="passe-table">
              <thead>
                <tr>
                  <th>Racine</th>
                  <th>Catégorie</th>
                  <th>Ligne du P&amp;L</th>
                  <th>
                    <span className="passe-visuellement-cache">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {reglesTriees.map((regle) => (
                  <tr key={regle.prefixe}>
                    <td>{regle.prefixe}</td>
                    <td>{regle.categorie}</td>
                    <td>{libelleDestination(regle.destination)}</td>
                    <td className="passe-signes-detail__action">
                      <button type="button" className="btn-secondaire" onClick={() => setSaisie(regle)}>
                        Modifier
                      </button>{" "}
                      <button type="button" className="btn-secondaire" onClick={() => onSupprimer(regle.prefixe)}>
                        Retirer
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
