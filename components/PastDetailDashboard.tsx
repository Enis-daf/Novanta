"use client";

import { useEffect, useMemo, useState } from "react";
import PasseCategoriesChart from "./PasseCategoriesChart";
import PasseEvolutionChart from "./PasseEvolutionChart";
import PasseNotesAjustement from "./PasseNotesAjustement";
import PasseStructureChart from "./PasseStructureChart";
import { formatDateCourte } from "@/lib/dates";
import { formatMontant, formatKiloEuros, formatPourcentage } from "@/lib/format";
import { AjustementGestion } from "@/lib/pastAdjustments";
import {
  calculerDetail,
  FiltresDetail,
  libelleMois,
  METRIQUES_DETAIL,
  MetriqueDetail,
  PartMappee,
  TRI_TRANSACTIONS_PAR_DEFAUT,
  trierTransactions,
  TriTransactions,
} from "@/lib/pastDetail";
import { Periode } from "@/lib/pastTransactions";

interface PastDetailDashboardProps {
  metrique: MetriqueDetail;
  // Parts mappées de la période globale du module (voir partsMappees) : ce composant ne charge
  // rien et n'appelle aucun service — toute l'exploration se fait sur ces données.
  parts: PartMappee[];
  periode: Periode;
  // Ajustements de gestion de la période (non bancaires) : ils entrent dans le KPI et
  // l'histogramme, et s'affichent à part des transactions.
  ajustements: AjustementGestion[];
  // Teinte attitrée de chaque catégorie, commune à tous les écrans du module (lib/dataviz.ts).
  teintes: ReadonlyMap<string, string>;
  // Informe le parent des filtres locaux en cours (pour l'export PDF, qui reprend ceux de l'écran
  // affiché). Lecture seule : les filtres restent décidés ici.
  onFiltresChange?: (filtres: FiltresDetail) => void;
}

const PAS_AFFICHAGE = 100;
const SANS_FILTRE: FiltresDetail = { categorie: null, mois: null };
// Le sens de chaque tri est fixe (voir trierTransactions) : on choisit le critère, pas l'ordre.
const TRIS: { cle: TriTransactions; libelle: string }[] = [
  { cle: "montant", libelle: "Montant" },
  { cle: "date", libelle: "Date" },
];

// Écran de détail générique, commun à CA, Marge brute, Marge contributive, EBITDA et Cash flow :
// KPI -> répartition par catégorie -> évolution mensuelle -> transactions. Seule la forme de la
// répartition varie : un camembert, ou un histogramme par catégorie pour le Cash flow, dont
// l'Extra P&L mêle encaissements et décaissements (voir METRIQUES_DETAIL). Les filtres locaux
// (catégorie, mois) vivent ICI, en un seul état que les quatre blocs consomment ; ils s'ajoutent
// à la période globale. Le parent remonte ce composant à chaque changement d'onglet (prop `key`),
// ce qui réinitialise les filtres locaux sans toucher à la période.
export default function PastDetailDashboard({ metrique, parts, periode, ajustements, teintes, onFiltresChange }: PastDetailDashboardProps) {
  const config = METRIQUES_DETAIL[metrique];
  const [filtres, setFiltres] = useState<FiltresDetail>(SANS_FILTRE);
  const [nombreAffiche, setNombreAffiche] = useState(PAS_AFFICHAGE);
  // État local de l'écran, jamais enregistré : conservé quand un filtre change, remis à
  // « Montant » quand on change d'onglet (l'écran est remonté).
  const [tri, setTri] = useState<TriTransactions>(TRI_TRANSACTIONS_PAR_DEFAUT);

  useEffect(() => {
    onFiltresChange?.(filtres);
  }, [filtres, onFiltresChange]);

  const changerTri = (suivant: TriTransactions) => {
    setTri(suivant);
    setNombreAffiche(PAS_AFFICHAGE);
  };

  const changerFiltres = (suivant: FiltresDetail) => {
    setFiltres(suivant);
    setNombreAffiche(PAS_AFFICHAGE);
  };
  // Recliquer sur la sélection active la retire.
  const basculerCategorie = (cle: string) => changerFiltres({ ...filtres, categorie: filtres.categorie === cle ? null : cle });
  const basculerMois = (mois: string) => changerFiltres({ ...filtres, mois: filtres.mois === mois ? null : mois });

  const vue = useMemo(
    () => calculerDetail(parts, metrique, filtres, periode, ajustements),
    [parts, metrique, filtres, periode, ajustements]
  );

  const filtreActif = filtres.categorie !== null || filtres.mois !== null;
  // Tri sur TOUTES les transactions qui correspondent aux filtres, puis découpage en lots.
  const transactionsTriees = useMemo(() => trierTransactions(vue.transactions, tri), [vue.transactions, tri]);
  const transactionsAffichees = transactionsTriees.slice(0, nombreAffiche);
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

        {/* Histogramme et, à côté, les ajustements de gestion compris dans ses barreaux. Le bloc suit
            les filtres (période, mois) mais n'en crée pas. */}
        <div className="passe-detail__evolution">
          <PasseEvolutionChart
            titre={titreEvolution}
            evolution={vue.evolution}
            enValeurAbsolue={vue.evolutionAbsolue}
            selection={filtres.mois}
            onSelect={basculerMois}
          />
          {vue.ajustements.lignes.length > 0 && (
            <section className="passe-ajustements">
              <h3 className="eyebrow eyebrow--encre">Ajustements de gestion</h3>
              <ul>
                {vue.ajustements.lignes.map((ligne) => (
                  <li key={ligne.cle}>
                    <div>
                      {ligne.label}
                      <PasseNotesAjustement notes={ligne.notes} />
                    </div>
                    <span className="passe-ajustements__montant">{formatKiloEuros(ligne.montant)}</span>
                  </li>
                ))}
              </ul>
              {vue.ajustements.nombreMasques > 0 && (
                <p className="passe-structure__note">
                  + {vue.ajustements.nombreMasques} autre{vue.ajustements.nombreMasques > 1 ? "s" : ""}
                </p>
              )}
            </section>
          )}
        </div>

      </div>

      <section className="passe-detail__droite">
        <h3 className="eyebrow eyebrow--encre">
          Transactions · {config.libelleDetail}
          <span className="passe-detail__compte"> {vue.transactions.length}</span>
        </h3>
        {/* Ajustements de gestion de l'étage : à part, pour ne jamais passer pour des transactions bancaires. */}
        {vue.ajustementsDetail.length > 0 && (
          <div className="passe-detail__ajustements">
            <p className="passe-message">Ajustements de gestion (hors banque)</p>
            <table className="passe-table">
              <tbody>
                {vue.ajustementsDetail.map((ajustement) => (
                  <tr key={ajustement.id}>
                    <td className="passe-table__date">{formatDateCourte(ajustement.date)}</td>
                    <td className="passe-table__libelle">
                      {ajustement.label}
                      <PasseNotesAjustement notes={ajustement.notes ? [ajustement.notes] : []} />
                    </td>
                    <td className="col-montant passe-table__montant">{formatMontant(ajustement.montant)}</td>
                    <td>
                      <span className="passe-statut">Ajustement de gestion</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {vue.transactions.length === 0 ? (
          <p className="passe-structure__vide">
            {filtreActif ? "Aucune transaction ne correspond aux filtres actifs." : "Aucune transaction sur la période."}
          </p>
        ) : (
          <>
            <div className="passe-tri" role="group" aria-label="Trier les transactions">
              <span className="passe-filtres-actifs__titre">Trier par :</span>
              {TRIS.map((option) => (
                <button
                  key={option.cle}
                  type="button"
                  className={`btn-secondaire${tri === option.cle ? " btn-module--actif" : ""}`}
                  aria-pressed={tri === option.cle}
                  onClick={() => changerTri(option.cle)}
                >
                  {option.libelle}
                </button>
              ))}
            </div>
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
