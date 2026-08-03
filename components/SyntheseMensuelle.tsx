"use client";

import { formatMontantK } from "@/lib/format";
import { ResultatSyntheseMensuelle } from "@/lib/syntheseMensuelle";

interface SyntheseMensuelleProps {
  synthese: ResultatSyntheseMensuelle;
}

function formatMontantSigne(montant: number): string {
  const base = formatMontantK(montant);
  return montant > 0 ? `+${base}` : base;
}

export default function SyntheseMensuelle({ synthese }: SyntheseMensuelleProps) {
  const { mois, lignes } = synthese;

  if (mois.length === 0) return null;

  return (
    <div className="synthese-mensuelle">
      <h3>Synthèse mensuelle</h3>
      <div className="synthese-mensuelle__scroll">
        <table className="synthese-mensuelle__table">
          <thead>
            <tr>
              <th></th>
              {mois.map((m) => (
                <th key={m.cle} className="col-montant">
                  {m.libelle}
                </th>
              ))}
              <th className="col-montant">Total</th>
            </tr>
          </thead>
          <tbody>
            {lignes.map((ligne) => (
              <tr key={ligne.libelle}>
                <td>{ligne.libelle}</td>
                {ligne.montantsParMois.map((montant, index) => (
                  <td key={mois[index].cle} className="col-montant">
                    {formatMontantSigne(montant)}
                  </td>
                ))}
                <td className="col-montant synthese-mensuelle__total">{formatMontantSigne(ligne.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
