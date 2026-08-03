"use client";

import { formatMontantK } from "@/lib/format";
import { ResultatControleMensuel } from "@/lib/controleMensuel";

interface ControleMensuelProps {
  controle: ResultatControleMensuel;
}

function formatMontantSigne(montant: number): string {
  const base = formatMontantK(montant);
  return montant > 0 ? `+${base}` : base;
}

export default function ControleMensuel({ controle }: ControleMensuelProps) {
  const { mois, totauxParMois } = controle;

  return (
    <div className="controle-mensuel">
      <p className="controle-mensuel__sous-titre">
        Comparez les totaux Novanta des derniers mois avec vos relevés bancaires.
      </p>
      <div className="controle-mensuel__scroll">
        <table className="controle-mensuel__table">
          <thead>
            <tr>
              <th></th>
              {mois.map((m) => (
                <th key={m.cle} className="col-montant">
                  {m.libelle}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Entrées Novanta</td>
              {totauxParMois.map((t, index) => (
                <td key={mois[index].cle} className="col-montant">
                  {formatMontantSigne(t.entrees)}
                </td>
              ))}
            </tr>
            <tr>
              <td>Sorties Novanta</td>
              {totauxParMois.map((t, index) => (
                <td key={mois[index].cle} className="col-montant">
                  {formatMontantSigne(t.sorties)}
                </td>
              ))}
            </tr>
            <tr>
              <td>Net Novanta</td>
              {totauxParMois.map((t, index) => (
                <td key={mois[index].cle} className="col-montant controle-mensuel__net">
                  {formatMontantSigne(t.net)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="controle-mensuel__aide">
        Comparez ces totaux avec vos relevés bancaires. Si un écart important apparaît, utilisez la recherche, le tri
        par montant ou les filtres pour retrouver les lignes à ajuster.
      </p>
    </div>
  );
}
