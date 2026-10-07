"use client";

import { useMemo, useState } from "react";
import PasseCategoriesChart from "./PasseCategoriesChart";
import PasseEvolutionChart from "./PasseEvolutionChart";
import PasseStructureChart from "./PasseStructureChart";
import { formatDateCourte } from "@/lib/dates";
import { formatMontant, formatPourcentage } from "@/lib/format";
import {
  calculerDetail,
  FiltresDetail,
  libelleMois,
  METRIQUES_DETAIL,
  MetriqueDetail,
  PartMappee,
} from "@/lib/pastDetail";
import { Periode } from "@/lib/pastTransactions";

interface PastDetailDashboardProps {
  metrique: MetriqueDetail;
  // Parts mappées de la période globale du module (voir partsMappees) : ce composant ne charge
  // rien et n'appelle aucun service — toute l'exploration se fait sur ces données.
  parts: PartMappee[];
  periode: Periode;
  // Teinte attitrée de chaque catégorie, commune à tous les écrans du module (lib/dataviz.ts).
  teintes: ReadonlyMap<string, string>;
}

const PAS_AFFICHAGE = 100;
const SANS_FILTRE: FiltresDetail = { categorie: null, mois: null };

// Écran de détail générique, commun à CA, Marge brute, Marge contributive, EBITDA et Cash flow :
// KPI -> répartition par catégorie -> évolution mensuelle -> transactions. Seule la forme de la
// répartition varie : un camembert, ou un histogramme par catégorie pour le Cash flow, dont
// l'Extra P&L mêle encaissements et décaissements (voir METRIQUES_DETAIL). Les filtres locaux
// (catégorie, mois) vivent ICI, en un seul état que les quatre blocs consomment ; ils s'ajoutent
// à la période globale. Le parent remonte ce composant à chaque changement d'onglet (prop `key`),
// ce qui réinitialise les filtres locaux sans toucher à la période.
export default function PastDetailDashboard({ metrique, parts, periode, teintes }: PastDetailDashboardProps) {
  const config = METRIQUES_DETAIL[metrique];
  const [filtres, setFiltres] = useState<FiltresDetail>(SANS_FILTRE);
  const [nombreAffiche, setNombreAffiche] = useState(PAS_AFFICHAGE);

  const changerFiltres = (suivant: FiltresDetail) => {
    setFiltres(suivant);
    setNombreAffiche(PAS_AFFICHAGE);
  };
  // Recliquer sur la sélection active la retire.
  const basculerCategorie = (cle: string) => changerFiltres({ ...filtres, categorie: filtres.categorie === cle ? null : cle });
  const basculerMois = (mois: string) => changerFiltres({ ...filtres, mois: filtres.mois === mois ? null : mois });

  const vue = useMemo(() => calculerDetail(parts, metrique, filtres, periode), [parts, metrique, filtres, periode]);

  const filtreActif = filtres.categorie !== null || filtres.mois !== null;
  const transactionsAffichees = vue.transactions.slice(0, nombreAffiche);
  const titreEvolution = vue.kpi.categorie
    ? `${vue.kpi.categorie} par mois (en valeur absolue)`
    : `${config.libelle} par mois`;

  return (
    <div className="passe-detail">
      <div className="passe-detail__gauche">
        <section className="passe-kpi">
          <p className="eyebrow eyebrow--grand">
            {vue.kpi.categorie ?? config.libelle}
            {vue.kpi.categorie && <span className="passe-kpi__contexte"> · {config.libelleDetail}</span>}
          </p>
          <p className="passe-kpi__montant">{formatMontant(vue.kpi.montant)}</p>
          {vue.kpi.ratio !== undefined && <p className="passe-kpi__ratio">{formatPourcentage(vue.kpi.ratio)} du CA</p>}

          {/* L'état de filtrage est toujours visible, jamais implicite. */}
          {filtreActif && (
            <div className="passe-filtres-actifs">
              <span className="passe-filtres-actifs__titre">Filtres actifs :</span>
              {filtres.mois !== null && (
                <button type="button" className="btn-secondaire btn-module--actif" onClick={() => changerFiltres({ ...filtres, mois: null })}>
                  {libelleMois(filtres.mois)} <span aria-hidden="true">×</span>
                  <span className="passe-visuellement-cache"> — retirer ce filtre</span>
                </button>
              )}
              {filtres.categorie !== null && (
                <button type="button" className="btn-secondaire btn-module--actif" onClick={() => changerFiltres({ ...filtres, categorie: null })}>
                  {vue.kpi.categorie ?? "Catégorie"} <span aria-hidden="true">×</span>
                  <span className="passe-visuellement-cache"> — retirer ce filtre</span>
                </button>
              )}
              <button type="button" className="btn-secondaire" onClick={() => changerFiltres(SANS_FILTRE)}>
                Réinitialiser
              </button>
            </div>
          )}
        </section>

        {vue.structure && (
          <PasseStructureChart
            titre={`${config.libelleDetail} par catégorie`}
            structure={vue.structure}
            messageVide={
              filtres.mois !== null
                ? `Aucune catégorie mappée en ${config.libelleDetail} sur ce mois.`
                : `Aucune catégorie mappée en ${config.libelleDetail} sur la période.`
            }
            selection={filtres.categorie}
            onSelect={basculerCategorie}
            teintes={teintes}
          />
        )}

        {vue.barresCategories && (
          <PasseCategoriesChart
            titre={`${config.libelleDetail} par catégorie`}
            categories={vue.barresCategories}
            messageVide={
              filtres.mois !== null
                ? `Aucune catégorie mappée en ${config.libelleDetail} sur ce mois.`
                : `Aucune catégorie mappée en ${config.libelleDetail} sur la période.`
            }
            selection={filtres.categorie}
            onSelect={basculerCategorie}
          />
        )}

        <PasseEvolutionChart
          titre={titreEvolution}
          evolution={vue.evolution}
          enValeurAbsolue={vue.evolutionAbsolue}
          selection={filtres.mois}
          onSelect={basculerMois}
        />

      </div>

      <section className="passe-detail__droite">
        <h3 className="eyebrow eyebrow--encre">
          Transactions · {config.libelleDetail}
          <span className="passe-detail__compte"> {vue.transactions.length}</span>
        </h3>
        {vue.transactions.length === 0 ? (
          <p className="passe-structure__vide">
            {filtreActif ? "Aucune transaction ne correspond aux filtres actifs." : "Aucune transaction sur la période."}
          </p>
        ) : (
          <>
            <div className="passe-detail__table">
              <table className="passe-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Libellé</th>
                    <th className="col-montant">Montant</th>
                    <th>Catégorie</th>
                  </tr>
                </thead>
                <tbody>
                  {transactionsAffichees.map((part) => (
                    <tr key={`${part.transactionId}:${part.sourceCategoryId}`}>
                      <td className="passe-table__date">{formatDateCourte(part.transactionDate)}</td>
                      <td className="passe-table__libelle">{part.label || "—"}</td>
                      <td className="col-montant passe-table__montant">
                        {formatMontant(part.montant)}
                        {/* Transaction ventilée : la ligne porte la part de la catégorie, le montant bancaire reste visible. */}
                        {part.weight !== 1 && (
                          <span className="passe-detail__source">
                            {formatPourcentage(part.weight)} de {formatMontant(part.montantSource)}
                          </span>
                        )}
                      </td>
                      <td>{part.sourceCategoryName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {vue.transactions.length > nombreAffiche && (
              <button type="button" className="btn-secondaire" onClick={() => setNombreAffiche((n) => n + PAS_AFFICHAGE)}>
                Afficher {PAS_AFFICHAGE} de plus
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
