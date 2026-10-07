"use client";

import PasseStructureChart from "./PasseStructureChart";
import { formatMontantComptable, formatPourcentage } from "@/lib/format";
import { ETAGES_COUTS, ETAGES_REVENUS, Pnl, structureParCategorie } from "@/lib/pastPnl";

interface PasseGeneralProps {
  pnl: Pnl;
  // Teinte attitrée de chaque catégorie, commune à tous les écrans du module (lib/dataviz.ts).
  teintes: ReadonlyMap<string, string>;
}

function Ligne({
  libelle,
  montant,
  ratio,
  niveau,
}: {
  libelle: string;
  montant: number;
  ratio?: number | null;
  niveau?: "titre" | "solde";
}) {
  return (
    <div className={`passe-pnl__ligne${niveau ? ` passe-pnl__ligne--${niveau}` : ""}`}>
      <span className="passe-pnl__libelle">{libelle}</span>
      <span className="passe-pnl__montant">{formatMontantComptable(montant)}</span>
      <span className="passe-pnl__ratio">{ratio === undefined ? "" : formatPourcentage(ratio)}</span>
    </div>
  );
}

// Onglet "Général" : P&L synthétique, Cash flow et structure des revenus / des coûts, sur la
// période du module. Tout est dérivé à la lecture ; rien n'est interrogé chez Pennylane ici.
export default function PasseGeneral({ pnl, teintes }: PasseGeneralProps) {
  return (
    <div className="passe-general">
      {/* Colonne gauche : la performance. Un bloc par étage, répartis sur toute la hauteur. */}
      <section className="passe-pnl" aria-label="P&L synthétique">
        <div className="passe-pnl__bloc">
          <Ligne libelle="Chiffre d'affaires" montant={pnl.ca} niveau="titre" />
        </div>
        <div className="passe-pnl__bloc">
          <Ligne libelle="Coûts directs" montant={pnl.coutsDirects} />
          <Ligne libelle="Marge brute" montant={pnl.margeBrute} ratio={pnl.ratios.margeBrute} niveau="solde" />
        </div>
        <div className="passe-pnl__bloc">
          <Ligne libelle="Coûts commerciaux" montant={pnl.coutsCommerciaux} />
          <Ligne libelle="Marge contributive" montant={pnl.margeContributive} ratio={pnl.ratios.margeContributive} niveau="solde" />
        </div>
        <div className="passe-pnl__bloc">
          <Ligne libelle="Coûts de structure" montant={pnl.coutsStructure} />
          <Ligne libelle="EBITDA" montant={pnl.ebitda} ratio={pnl.ratios.ebitda} niveau="solde" />
        </div>
        {/* Cash flow : présenté à part du P&L opérationnel, sans ratio. */}
        <div className="passe-pnl__bloc passe-pnl__bloc--cash">
          <Ligne libelle="Extra P&L" montant={pnl.extraPnl} />
          <Ligne libelle="Cash flow" montant={pnl.cashFlow} niveau="titre" />
        </div>
      </section>

      {/* Colonne droite : la composition de cette performance, revenus puis coûts. */}
      <div className="passe-general__structures">
        <PasseStructureChart
          titre="Structure des revenus"
          structure={structureParCategorie(pnl.categories, ETAGES_REVENUS, "revenus")}
          messageVide="Aucun revenu mappé sur la période."
          teintes={teintes}
        />
        <PasseStructureChart
          titre="Structure des coûts"
          structure={structureParCategorie(pnl.categories, ETAGES_COUTS, "couts")}
          messageVide="Aucun coût mappé sur la période."
          teintes={teintes}
        />
      </div>
    </div>
  );
}
