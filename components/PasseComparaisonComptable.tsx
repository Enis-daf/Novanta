"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReponseCompta } from "@/lib/comptaClient";
import { ExerciceComptable } from "@/lib/comptaExercices";
import { lignesDeComparaison } from "@/lib/comptaLecture";
import { formatDateCourte, todayISO } from "@/lib/dates";
import { formatMontantComptable } from "@/lib/format";
import { Periode } from "@/lib/pastTransactions";

interface PasseComparaisonComptableProps {
  exercices: ExerciceComptable[];
  charger: (periode: Periode) => Promise<ReponseCompta>;
}

const nomExercice = (e: ExerciceComptable) => `${formatDateCourte(e.debut)} → ${formatDateCourte(e.fin)}`;

// Deux exercices côte à côte : mêmes lignes que le rapport, sans nouveau calcul. Un exercice commencé mais non
// terminé se compare tel quel : il n'est pas ramené à la même durée.
export default function PasseComparaisonComptable({ exercices, charger }: PasseComparaisonComptableProps) {
  const proposes = useMemo(() => exercices.filter((e) => e.debut <= todayISO()).sort((a, b) => b.debut.localeCompare(a.debut)), [exercices]);
  const [idA, setIdA] = useState(proposes[1]?.idSource ?? proposes[0]?.idSource ?? "");
  const [idB, setIdB] = useState(proposes[0]?.idSource ?? "");
  const [vues, setVues] = useState<{ a: ReponseCompta; b: ReponseCompta } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const a = proposes.find((e) => e.idSource === idA);
  const b = proposes.find((e) => e.idSource === idB);

  useEffect(() => {
    if (!a || !b) return;
    let annule = false;
    setErreur(null);
    Promise.all([charger({ debut: a.debut, fin: a.fin }), charger({ debut: b.debut, fin: b.fin })])
      .then(([va, vb]) => {
        if (!annule) setVues({ a: va, b: vb });
      })
      .catch((e: Error) => {
        if (!annule) setErreur(e.message);
      });
    return () => {
      annule = true;
    };
  }, [a, b, charger]);

  if (proposes.length === 0) return <div className="passe-etat">Importez un FEC ou connectez Pennylane pour comparer des exercices.</div>;

  const incomplet = vues ? !vues.a.pnl.complet || !vues.b.pnl.complet : false;
  return (
    <div className="passe-mapping">
      <div className="compta-saisie">
        {[
          { id: "compare-a", libelle: "Exercice A", valeur: idA, changer: setIdA },
          { id: "compare-b", libelle: "Exercice B", valeur: idB, changer: setIdB },
        ].map((c) => (
          <div key={c.id} className="compta-saisie__champ">
            <label className="passe-controle__label" htmlFor={c.id}>
              {c.libelle}
            </label>
            <select id={c.id} value={c.valeur} onChange={(e) => c.changer(e.target.value)}>
              {proposes.map((e) => (
                <option key={e.idSource} value={e.idSource}>
                  {nomExercice(e)}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      {erreur && <p className="login-erreur">{erreur}</p>}
      {incomplet && <p className="passe-message">Au moins un exercice est incomplet : comptes sans correspondance, ou source à choisir. Voir l&apos;onglet P&amp;L comptable.</p>}
      {vues && a && b && (
        <div className="table-wrapper">
          <table className="passe-table">
            <thead>
              <tr>
                <th>Ligne</th>
                <th className="col-montant">{nomExercice(a)}</th>
                <th className="col-montant">{nomExercice(b)}</th>
                <th className="col-montant">Écart</th>
              </tr>
            </thead>
            <tbody>
              {lignesDeComparaison(vues.a.pnl, vues.b.pnl).map((l) => (
                <tr key={l.cle} className={l.niveau ? "compta-comparaison__solde" : undefined}>
                  <td className="passe-table__libelle">{l.libelle}</td>
                  <td className="col-montant passe-table__montant">{formatMontantComptable(l.a)}</td>
                  <td className="col-montant passe-table__montant">{formatMontantComptable(l.b)}</td>
                  <td className="col-montant passe-table__montant">{formatMontantComptable(l.b - l.a)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
