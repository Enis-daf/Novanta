"use client";

import MentionTTC from "./MentionTTC";
import { Fragment } from "react";
import PasseEcartCible from "./PasseEcartCible";
import PasseNotesAjustement from "./PasseNotesAjustement";
import PasseStructureChart from "./PasseStructureChart";
import PasseTvaIncomplete from "./PasseTvaIncomplete";
import { formatMontantComptable, formatPourcentage, MENTION_HT_ESTIME, MENTION_TTC } from "@/lib/format";
import { CouvertureTva, IndicateurEconomique, LIBELLE_VOIR_TTC, PnlEnBase } from "@/lib/pastHtEstime";
import { LigneAjustement } from "@/lib/pastAdjustments";
import { EcartsVsCibles } from "@/lib/pastTargets";
import { LIBELLE_ENCAISSEMENTS, libelleEtagePnl } from "@/lib/pastCategoryMapping";
import {
  ETAGES_COUTS,
  ETAGES_REVENUS,
  LIBELLE_CASH_FLOW_OPERATIONNEL,
  LIBELLE_VARIATION_TRESORERIE,
  Pnl,
  structureParCategorie,
} from "@/lib/pastPnl";

interface PasseGeneralProps {
  // P&L dans la lecture choisie (TTC ou HT estimé) : la trésorerie y est toujours TTC.
  pnl: PnlEnBase;
  // Écarts aux cibles de performance de la période, calculés en HT (null par indicateur = aucune
  // cible applicable ; `indisponibles` dit pourquoi un objectif ne se compare pas). null en lecture
  // TTC : les objectifs sont exclusivement HT, aucune cible ni aucun écart n'y est affiché.
  cibles: EcartsVsCibles | null;
  // Ouvre l'écran de diagnostic d'un indicateur, ou la configuration des cibles.
  onOuvrir: (ecran: "marge_brute" | "marge_contributive" | "ebitda") => void;
  onDefinirCible: () => void;
  // Ouvre la correspondance P&L pour renseigner les taux de TVA manquants.
  onConfigurerTva: () => void;
  // Teinte attitrée de chaque catégorie, commune à tous les écrans du module (lib/dataviz.ts).
  teintes: ReadonlyMap<string, string>;
}

function Ligne({
  libelle,
  montant,
  ratio,
  niveau,
  mention = MENTION_TTC,
  incomplet = false,
  texte,
  vide = false,
}: {
  libelle: string;
  montant: number;
  ratio?: number | null;
  niveau?: "titre" | "solde" | "total";
  // Base de l'indicateur principal : « TTC » ou « HT estimé ». La trésorerie reste toujours TTC.
  mention?: string;
  // Lecture HT : TVA non renseignée sur une partie des montants — pas de chiffre trompeur.
  incomplet?: boolean;
  // Lecture HT, au-delà du Cash flow opérationnel : pas de montant. `texte` le remplace (texte
  // secondaire, jamais un montant), `vide` laisse la cellule réellement vide.
  texte?: string;
  vide?: boolean;
}) {
  return (
    <div className={`passe-pnl__ligne${niveau ? ` passe-pnl__ligne--${niveau}` : ""}`}>
      <span className="passe-pnl__libelle">
        {libelle}
        {/* Indicateurs principaux seulement (titre, soldes, total) : ils posent le contexte (TTC ou
            HT estimé) pour les lignes de coûts qui les précèdent, qui restent sans mention. */}
        {niveau && !texte && <MentionTTC libelle={mention} />}
      </span>
      <span className="passe-pnl__montant">
        {vide ? null : texte ? (
          <span className="passe-pnl__texte">{texte}</span>
        ) : incomplet ? (
          <span className="passe-pnl__incomplet">Incomplet</span>
        ) : (
          formatMontantComptable(montant)
        )}
      </span>
      <span className="passe-pnl__ratio">{ratio === undefined || incomplet || vide || texte ? "" : formatPourcentage(ratio)}</span>
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
export default function PasseGeneral({ pnl, teintes, cibles, onOuvrir, onDefinirCible, onConfigurerTva }: PasseGeneralProps) {
  const ht = pnl.base === "ht";
  const mention = ht ? MENTION_HT_ESTIME : MENTION_TTC;
  const incomplet = (indicateur: IndicateurEconomique) => Boolean(ht && pnl.couvertures && !pnl.couvertures[indicateur].complete);
  const couvertureCouts: CouvertureTva | null = pnl.couvertures?.ebitda ?? null;
  const structuresIncompletes = ht && couvertureCouts !== null && !couvertureCouts.complete;
  return (
    <div className="passe-general">
      {/* Colonne gauche : la performance. Un bloc par étage, répartis sur toute la hauteur. */}
      <section className="passe-pnl" aria-label="P&L synthétique">
        <div className="passe-pnl__bloc">
          <Ligne libelle={LIBELLE_ENCAISSEMENTS} montant={pnl.ca} niveau="titre" mention={mention} incomplet={incomplet("ca")} />
          <LignesAjustements lignes={pnl.ajustements.revenue} />
        </div>
        <div className="passe-pnl__bloc">
          <Ligne libelle="Coûts directs" montant={pnl.coutsDirects} />
          <LignesAjustements lignes={pnl.ajustements.gross_margin} />
          <Ligne libelle="Marge brute" montant={pnl.margeBrute} ratio={pnl.ratios.margeBrute} niveau="solde" mention={mention} incomplet={incomplet("margeBrute")} />
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
          <Ligne
            libelle="Marge contributive"
            montant={pnl.margeContributive}
            ratio={pnl.ratios.margeContributive}
            niveau="solde"
            mention={mention}
            incomplet={incomplet("margeContributive")}
          />
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
          <Ligne libelle="EBITDA" montant={pnl.ebitda} ratio={pnl.ratios.ebitda} niveau="solde" mention={mention} incomplet={incomplet("ebitda")} />
          {/* Même lecture que les deux marges : l'EBITDA face à SA cible, dérivée des objectifs de
              Marge contributive et de Coûts de structure — pas une cible de coûts posée là. */}
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
        {ht && pnl.couvertures && !pnl.couvertures.ebitda.complete && (
          <PasseTvaIncomplete couverture={pnl.couvertures.ebitda} onConfigurer={onConfigurerTva} />
        )}
        {/* Trésorerie, à part du P&L opérationnel et sans ratio : ce que l'activité génère après
            l'Extra P&L (sous-total, au rang des marges), puis l'effet des virements internes et du
            financement, jusqu'au total final. */}
        <div className="passe-pnl__bloc passe-pnl__bloc--cash">
          <Ligne libelle={libelleEtagePnl("extra_pnl")} montant={pnl.extraPnl} />
          <LignesAjustements lignes={pnl.ajustements.extra_pnl} />
          {/* TVA payée ou remboursée : présentée en lecture TTC seulement. En HT estimé elle sort de
              la lecture, mais le Cash flow opérationnel (toujours TTC) la compte dans les deux. */}
          {!ht && (
            <>
              <Ligne libelle={libelleEtagePnl("vat")} montant={pnl.tva} />
              <LignesAjustements lignes={pnl.ajustements.vat} />
            </>
          )}
          {/* HT estimé : EBITDA HT + Extra P&L HT, dernier résultat chiffré de cette lecture. */}
          <Ligne
            libelle={LIBELLE_CASH_FLOW_OPERATIONNEL}
            montant={pnl.cashFlowOperationnel}
            niveau="solde"
            mention={mention}
            incomplet={incomplet("cashFlowOperationnel")}
          />
        </div>
        {/* Au-delà, des flux bancaires réels : sans objet en HT, chiffrés en TTC seulement. */}
        <div className="passe-pnl__bloc">
          <Ligne libelle={libelleEtagePnl("financing")} montant={pnl.financements} vide={ht} />
          {!ht && <LignesAjustements lignes={pnl.ajustements.financing} />}
          <Ligne libelle={LIBELLE_VARIATION_TRESORERIE} montant={pnl.variationTresorerie} niveau="total" texte={ht ? LIBELLE_VOIR_TTC : undefined} />
        </div>
      </section>

      {/* Colonne droite : la composition de cette performance, revenus puis coûts. */}
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
