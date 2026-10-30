"use client";

import { useMemo, useState } from "react";
import { LIGNES_COMPTABLES } from "@/lib/comptaCorrespondance";
import { moisEntre } from "@/lib/comptaExercices";
import { AjustementComptable, erreurAjustement, libelleNature, NATURES_AJUSTEMENT, NatureAjustement, SaisieAjustement } from "@/lib/comptaStocks";
import { formatDateCourte, todayISO } from "@/lib/dates";
import { formatMontantComptable } from "@/lib/format";
import { finDeMois } from "@/lib/pastAdjustments";

interface PasseAjustementsComptablesProps {
  ajustements: AjustementComptable[];
  ecartes: AjustementComptable[];
  aVerifier: AjustementComptable[];
  onAjouter: (ajustements: SaisieAjustement[]) => void;
  onRetirer: (id: string) => void;
}

const LIGNES = LIGNES_COMPTABLES.filter((l) => l.cle !== "inventory_variation");

// Compléments de pilotage, jamais une écriture : rien ne part vers Pennylane. Les montants sont saisis, pas calculés :
// durée et méthode d'amortissement restent hors de Novanta. Les stocks gardent leur écran.
export default function PasseAjustementsComptables({ ajustements, ecartes, aVerifier, onAjouter, onRetirer }: PasseAjustementsComptablesProps) {
  const moisCourant = todayISO().slice(0, 7);
  const [nature, setNature] = useState<NatureAjustement>("amortissement");
  // Pas de ligne par défaut : un cut-off posé sans choix fausserait la cascade sans que rien ne le signale.
  const [ligne, setLigne] = useState<string>("");
  const [libelle, setLibelle] = useState("");
  const [sens, setSens] = useState<"charge" | "produit">("charge");
  const [montant, setMontant] = useState("");
  const [moisDebut, setMoisDebut] = useState(moisCourant);
  const [moisFin, setMoisFin] = useState(moisCourant);
  const [erreur, setErreur] = useState<string | null>(null);

  const estDotation = nature === "amortissement";
  const mois = useMemo(() => (moisDebut && moisFin && moisDebut <= moisFin ? moisEntre(`${moisDebut}-01`, `${moisFin}-01`) : []), [moisDebut, moisFin]);

  const ajouter = () => {
    const valeur = Number(montant.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(valeur) || valeur <= 0) {
      setErreur("Saisissez un montant positif, puis choisissez charge ou produit.");
      return;
    }
    if (mois.length === 0) {
      setErreur("La période est invalide.");
      return;
    }
    if (!estDotation && !ligne) {
      setErreur("Choisissez la ligne du P&L concernée.");
      return;
    }
    const signe = estDotation || sens === "charge" ? -1 : 1;
    const saisies: SaisieAjustement[] = mois.map((m) => ({ date: finDeMois(m), ligne: estDotation ? "depreciation" : ligne, libelle, montant: signe * valeur, nature }));
    const probleme = saisies.map(erreurAjustement).find(Boolean);
    if (probleme) {
      setErreur(probleme);
      return;
    }
    setErreur(null);
    onAjouter(saisies);
    setLibelle("");
    setMontant("");
  };

  const lignes = [...ajustements, ...ecartes].sort((a, b) => a.date.localeCompare(b.date));
  const idsEcartes = new Set(ecartes.map((a) => a.id));
  const idsAVerifier = new Set(aVerifier.map((a) => a.id));

  return (
    <div className="passe-mapping">
      <p className="passe-message">Ces ajustements complètent le reporting mensuel quand une écriture n&apos;est passée qu&apos;à la clôture. Ils ne créent aucune écriture comptable et se retirent à tout moment.</p>
      <div className="compta-saisie">
        <div className="compta-saisie__champ">
          <label className="passe-controle__label" htmlFor="ajust-nature">
            Nature
          </label>
          <select id="ajust-nature" value={nature} onChange={(e) => setNature(e.target.value as NatureAjustement)}>
            {NATURES_AJUSTEMENT.map((n) => (
              <option key={n.cle} value={n.cle}>
                {n.libelle}
              </option>
            ))}
          </select>
        </div>
        {!estDotation && (
          <div className="compta-saisie__champ">
            <label className="passe-controle__label" htmlFor="ajust-ligne">
              Ligne du P&amp;L
            </label>
            <select id="ajust-ligne" value={ligne} onChange={(e) => setLigne(e.target.value)}>
              <option value="" disabled>
                Choisir
              </option>
              {LIGNES.map((l) => (
                <option key={l.cle} value={l.cle}>
                  {l.libelle}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="compta-saisie__champ">
          <label className="passe-controle__label" htmlFor="ajust-libelle">
            Libellé
          </label>
          <input id="ajust-libelle" type="text" value={libelle} onChange={(e) => setLibelle(e.target.value)} />
        </div>
        {!estDotation && (
          <div className="compta-saisie__champ">
            <label className="passe-controle__label" htmlFor="ajust-sens">
              Effet sur le résultat
            </label>
            <select id="ajust-sens" value={sens} onChange={(e) => setSens(e.target.value as "charge" | "produit")}>
              <option value="charge">Charge (diminue)</option>
              <option value="produit">Produit (augmente)</option>
            </select>
          </div>
        )}
        <div className="compta-saisie__champ">
          <label className="passe-controle__label" htmlFor="ajust-montant">
            Montant par mois
          </label>
          <input id="ajust-montant" type="text" inputMode="decimal" value={montant} onChange={(e) => setMontant(e.target.value)} />
        </div>
        <div className="compta-saisie__champ">
          <label className="passe-controle__label" htmlFor="ajust-debut">
            De
          </label>
          <input id="ajust-debut" type="month" value={moisDebut} onChange={(e) => setMoisDebut(e.target.value)} />
        </div>
        <div className="compta-saisie__champ">
          <label className="passe-controle__label" htmlFor="ajust-fin">
            À
          </label>
          <input id="ajust-fin" type="month" value={moisFin} onChange={(e) => setMoisFin(e.target.value)} />
        </div>
        <button type="button" className="btn-add" onClick={ajouter}>
          Ajouter {mois.length > 1 ? `${mois.length} mois` : ""}
        </button>
        {erreur && <p className="login-erreur compta-saisie__erreur">{erreur}</p>}
      </div>

      {lignes.length === 0 ? (
        <div className="passe-etat">Aucun ajustement sur cette période.</div>
      ) : (
        <div className="table-wrapper">
          <table className="passe-table">
            <thead>
              <tr>
                <th>Mois</th>
                <th>Nature</th>
                <th>Libellé</th>
                <th>Ligne du P&amp;L</th>
                <th className="col-montant">Montant</th>
                <th>État</th>
                <th>
                  <span className="passe-visuellement-cache">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lignes.map((a) => (
                <tr key={a.id}>
                  <td className="passe-table__date">{formatDateCourte(a.date)}</td>
                  <td>{libelleNature(a.nature)}</td>
                  <td className="passe-table__libelle">{a.libelle}</td>
                  <td>{LIGNES.find((l) => l.cle === a.ligne)?.libelle}</td>
                  <td className="col-montant passe-table__montant">{formatMontantComptable(a.montant)}</td>
                  <td>{idsEcartes.has(a.id) ? <span className="passe-statut">Écarté : dotation comptable retenue</span> : idsAVerifier.has(a.id) ? <span className="passe-statut passe-statut--a-mapper">À vérifier</span> : <span className="passe-statut">Appliqué</span>}</td>
                  <td className="passe-signes-detail__action">
                    <button type="button" className="passe-lien-ligne" onClick={() => onRetirer(a.id)}>
                      Retirer
                    </button>
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
