"use client";

import { Fragment } from "react";
import PasseNotesAjustement from "./PasseNotesAjustement";
import PasseStructureChart from "./PasseStructureChart";
import { formatMontantComptable, formatPourcentage } from "@/lib/format";
import { LigneAjustement } from "@/lib/pastAdjustments";
import { libelleEtagePnl } from "@/lib/pastCategoryMapping";
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

// Ajustements de gestion d'un étage : chacun sur sa propre ligne, jamais fondu dans les coûts.
function LignesAjustements({ lignes }: { lignes: LigneAjustement[] }) {
  return (
    <>
      {lignes.map((ligne) => (
        <Fragment key={ligne.cle}>
          <Ligne libelle={ligne.label} montant={ligne.montant} />
          <PasseNotesAjustement notes={ligne.notes} />
        </Fragment>
      ))}
    </>
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
          <LignesAjustements lignes={pnl.ajustements.revenue} />
        </div>
        <div className="passe-pnl__bloc">
          <Ligne libelle="Coûts directs" montant={pnl.coutsDirects} />
          <LignesAjustements lignes={pnl.ajustements.gross_margin} />
          <Ligne libelle="Marge brute" montant={pnl.margeBrute} ratio={pnl.ratios.margeBrute} niveau="solde" />
        </div>
        <div className="passe-pnl__bloc">
          <Ligne libelle={libelleEtagePnl("contribution_margin")} montant={pnl.coutsCommerciaux} />
          <LignesAjustements lignes={pnl.ajustements.contribution_margin} />
          <Ligne libelle="Marge contributive" montant={pnl.margeContributive} ratio={pnl.ratios.margeContributive} niveau="solde" />
        </div>
        <div className="passe-pnl__bloc">
          <Ligne libelle="Coûts de structure" montant={pnl.coutsStructure} />
          <LignesAjustements lignes={pnl.ajustements.ebitda} />
          <Ligne libelle="EBITDA" montant={pnl.ebitda} ratio={pnl.ratios.ebitda} niveau="solde" />
        </div>
        {/* Cash flow : présenté à part du P&L opérationnel, sans ratio. */}
        <div className="passe-pnl__bloc passe-pnl__bloc--cash">
          <Ligne libelle={libelleEtagePnl("extra_pnl")} montant={pnl.extraPnl} />
          <LignesAjustements lignes={pnl.ajustements.extra_pnl} />
          <Ligne libelle={libelleEtagePnl("financing")} montant={pnl.financements} />
          <LignesAjustements lignes={pnl.ajustements.financing} />
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
