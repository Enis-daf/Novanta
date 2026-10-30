"use client";

import PasseEcartCible from "./PasseEcartCible";
import PasseFluxHorsPnl from "./PasseFluxHorsPnl";
import { Ligne, LignesAjustements } from "./PasseGeneral";
import PasseStructureChart from "./PasseStructureChart";
import PasseTvaIncomplete from "./PasseTvaIncomplete";
import { IndicateurEconomique } from "@/lib/pastHtEstime";
import { libelleEtagePnl } from "@/lib/pastCategoryMapping";
import { ETAGES_COUTS, ETAGES_REVENUS, structureParCategorie } from "@/lib/pastPnl";
import {
  LIBELLE_AUTRES_ELEMENTS,
  LIBELLE_REVENUS_HT_ESTIMES,
  LIBELLE_SOLDE_GESTION_ESTIME,
  PnlCashEstime,
  TITRE_PNL_CASH_ESTIME,
} from "@/lib/pastPnlCashEstime";
import { EcartsVsCibles } from "@/lib/pastTargets";

interface PassePnlCashEstimeProps {
  pnl: PnlCashEstime;
  cibles: EcartsVsCibles | null;
  onOuvrir: (ecran: "marge_brute" | "marge_contributive" | "ebitda") => void;
  onDefinirCible: () => void;
  onConfigurer: () => void;
  teintes: ReadonlyMap<string, string>;
}

// Onglet « Général » de la nouvelle présentation : la cascade s'arrête au Solde de gestion estimé.
// Le titre pose le contexte HT estimé une fois pour toutes : les lignes de marge ne le répètent pas.
export default function PassePnlCashEstime({ pnl, cibles, onOuvrir, onDefinirCible, onConfigurer, teintes }: PassePnlCashEstimeProps) {
  const incomplet = (indicateur: IndicateurEconomique) => Boolean(pnl.couvertures && !pnl.couvertures[indicateur].complete);
  const couvertureCouts = pnl.couvertures?.ebitda ?? null;
  const structuresIncompletes = couvertureCouts !== null && !couvertureCouts.complete;
  return (
    <div className="passe-general">
      <section className="passe-pnl" aria-label={TITRE_PNL_CASH_ESTIME}>
        <h2 className="passe-pnl__titre">{TITRE_PNL_CASH_ESTIME}</h2>
        <div className="passe-pnl__bloc">
          <Ligne libelle={LIBELLE_REVENUS_HT_ESTIMES} montant={pnl.ca} niveau="titre" mention="" incomplet={incomplet("ca")} />
          <LignesAjustements lignes={pnl.ajustements.revenue} />
        </div>
        <div className="passe-pnl__bloc">
          <Ligne libelle="Coûts directs" montant={pnl.coutsDirects} />
          <LignesAjustements lignes={pnl.ajustements.gross_margin} />
          <Ligne libelle="Marge brute" montant={pnl.margeBrute} ratio={pnl.ratios.margeBrute} niveau="solde" mention="" incomplet={incomplet("margeBrute")} />
          {cibles && (
            <PasseEcartCible
              ecart={{ type: "marge", valeur: cibles.margeBrute }}
              motif={cibles.indisponibles.margeBrute}
              onOuvrir={() => onOuvrir("marge_brute")}
              onDefinir={onDefinirCible}
              libelleLien="Ouvrir l'écran Marge brute"
            />
          )}
        </div>
        <div className="passe-pnl__bloc">
          <Ligne libelle={libelleEtagePnl("contribution_margin")} montant={pnl.coutsCommerciaux} />
          <LignesAjustements lignes={pnl.ajustements.contribution_margin} />
          <Ligne libelle="Marge contributive" montant={pnl.margeContributive} ratio={pnl.ratios.margeContributive} niveau="solde" mention="" incomplet={incomplet("margeContributive")} />
          {cibles && (
            <PasseEcartCible
              ecart={{ type: "marge", valeur: cibles.margeContributive }}
              motif={cibles.indisponibles.margeContributive}
              onOuvrir={() => onOuvrir("marge_contributive")}
              onDefinir={onDefinirCible}
              libelleLien="Ouvrir l'écran Marge contributive"
            />
          )}
        </div>
        <div className="passe-pnl__bloc">
          <Ligne libelle="Coûts de structure" montant={pnl.coutsStructure} />
          <LignesAjustements lignes={pnl.ajustements.ebitda} />
          <Ligne libelle="EBITDA" montant={pnl.ebitda} ratio={pnl.ratios.ebitda} niveau="solde" mention="" incomplet={incomplet("ebitda")} />
          {cibles && (
            <PasseEcartCible
              ecart={{ type: "ebitda", valeur: cibles.ebitda, incomplet: cibles.ebitdaIncomplet }}
              motif={cibles.indisponibles.ebitda}
              onOuvrir={() => onOuvrir("ebitda")}
              onDefinir={onDefinirCible}
              libelleLien="Ouvrir l'écran EBITDA"
            />
          )}
        </div>
        {couvertureCouts && !couvertureCouts.complete && <PasseTvaIncomplete couverture={couvertureCouts} onConfigurer={onConfigurer} />}
        <div className="passe-pnl__bloc passe-pnl__bloc--cash">
          <Ligne libelle={LIBELLE_AUTRES_ELEMENTS} montant={pnl.extraPnl} />
          <LignesAjustements lignes={pnl.ajustements.extra_pnl} />
          <Ligne libelle={LIBELLE_SOLDE_GESTION_ESTIME} montant={pnl.soldeGestionEstime} niveau="total" mention="" incomplet={incomplet("cashFlowOperationnel")} />
        </div>
        <PasseFluxHorsPnl flux={pnl.flux} onConfigurer={onConfigurer} />
      </section>

      <div className="passe-general__structures">
        {structuresIncompletes ? (
          <p className="passe-structure__vide">
            Répartition HT non affichée : la TVA n&apos;est pas renseignée pour toutes les catégories de la période.
          </p>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
