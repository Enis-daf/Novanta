"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { formatDateCourte, toISODate } from "@/lib/dates";
import { formatKiloEuros, formatMontant } from "@/lib/format";
import { finDeMois, StockFinDeMois } from "@/lib/pastAdjustments";
import { libelleMois } from "@/lib/pastDetail";
import {
  exclusionsDevenuesFiables,
  FactureBfr,
  FactureIncertaine,
  facturesExcluesRetenues,
  LIBELLES_STATUT_BFR,
  phraseExclusions,
  resumerExclusions,
  LigneBfr,
  photographier,
  photographieDepassee,
  reviser,
  SituationBfr,
  SituationValidee,
  StatutBfr,
  statutBfr,
  TotauxBfr,
  totauxRetenus,
  variationBfr,
} from "@/lib/pastBfr";
import { CoteDelai, delaisDeLaCohorte, DelaisCohorte, delaisDuMois } from "@/lib/pastBfrDelais";
import {
  avecCategoriesDesTransactions,
  CategoriesParTransaction,
  diagnosticCategories,
  etagesParTransaction,
  etagesProposes,
  FiltresAnalyse,
  filtresInitiaux,
  premiereEmission,
  resoudrePeriode,
  transactionsRapprochees,
} from "@/lib/pastBfrAnalyseDelais";
import { ConfigExercice } from "@/lib/fiscalPeriods";
import { MappingCategorie } from "@/lib/pastCategoryMapping";
import { DelaisVisibles, evolutionBfr, evolutionVisible, PointBfr, situationBfrDuMois, SourcesBfr, stockBfrDuMois, valideeDuMois } from "@/lib/pastBfrLecture";
import PasseBfrEvolutionChart, { bfrAfficheDe, LegendeEvolution } from "./PasseBfrEvolutionChart";
import { CartoucheDelai, MesureDistribution, VueDelais } from "./PasseBfrDelais";
import { chargerCategoriesDesTransactions, chargerFacturesBfr, chargerSituationsValidees, reviserSituationBfr, validerSituationBfr } from "@/lib/pastBfrRepository";

interface PasseBfrProps {
  organizationId: string;
  // Incrémenté après une synchronisation : l'unique bouton « Synchroniser Pennylane » du module met
  // aussi à jour les factures du BFR ; elles sont alors relues.
  rechargement: number;
  // Mois (YYYY-MM) terminés de la période du module : chacun a sa situation de fin de mois.
  mois: string[];
  stocks: StockFinDeMois[];
  sansStock: boolean;
  pennylaneConnecte: boolean | null;
  onOuvrirStocks: () => void;
  // Délais que l'offre de l'organisation ouvre (lib/offres.ts : canViewDSO, canViewDPO).
  delaisVisibles: DelaisVisibles;
  // Analyse des délais : exercice fiscal (périodes Trimestre / Exercice), et axe de référence et
  // correspondance P&L du module, qui donnent l'étage P&L des transactions rapprochées.
  exercice: ConfigExercice;
  axeId: string | null;
  mappings: ReadonlyMap<string, MappingCategorie>;
}

// État d'une analyse des délais (clients ou fournisseurs) : ses filtres, ceux du détail d'une
// tranche (repartis de l'analyse à chaque ouverture de tranche, jamais remontés), et le mois du BFR
// d'où elle a été ouverte — rouverte depuis un autre mois, elle repart de ce mois-là.
interface EtatAnalyse {
  moisBfr: string;
  filtres: FiltresAnalyse;
  filtresDetail: FiltresAnalyse;
  tranche: string | null;
  mesure: MesureDistribution;
}

const LIGNES_VISIBLES = 10;
// bfr-2 : les factures au solde incertain sont exclues et enregistrées, elles ne bloquent plus le calcul.
const VERSION_CALCUL = "bfr-2";

type Action = "creances" | "stocks" | "dettes";

const enK = (montant: number) => `${formatKiloEuros(montant, Math.abs(montant) < 10_000 ? 1 : 0)} HT`;
const signeK = (montant: number) => `${montant > 0.5 ? "+" : ""}${enK(montant)}`;

function moisPrecedent(mois: string): string {
  const annee = Number(mois.slice(0, 4));
  const numero = Number(mois.slice(5, 7));
  return numero === 1 ? `${annee - 1}-12` : `${annee}-${String(numero - 1).padStart(2, "0")}`;
}

// Délais de paiement : cohorte du mois de référence (factures émises ce mois-là), comparée au mois
// civil précédent. L'onglet BFR est mensuel : un seul mois pour tout l'écran.
function periodeDesDelais(mois: string): { debut: string; fin: string; precedente: { debut: string; fin: string }; libelle: string; court: string; courtPrecedent: string } {
  const prec = moisPrecedent(mois);
  return {
    debut: `${mois}-01`,
    fin: finDeMois(mois),
    precedente: { debut: `${prec}-01`, fin: finDeMois(prec) },
    libelle: `en ${libelleMois(mois).toLowerCase()}`,
    court: libelleMois(mois).toLowerCase(),
    courtPrecedent: libelleMois(prec).toLowerCase(),
  };
}

function Statut({ statut }: { statut: StatutBfr }) {
  return <span className={`passe-statut passe-bfr__statut passe-bfr__statut--${statut}`}>{LIBELLES_STATUT_BFR[statut]}</span>;
}

function ListeFactures({ lignes, libelleTiers }: { lignes: LigneBfr[]; libelleTiers: string }) {
  const [tout, setTout] = useState(false);
  if (lignes.length === 0) return <p className="passe-structure__vide">Aucune facture encore due à cette date.</p>;
  const visibles = tout ? lignes : lignes.slice(0, LIGNES_VISIBLES);
  return (
    <>
      <div className="passe-detail__table">
        <table className="passe-table">
          <thead>
            <tr>
              <th>{libelleTiers}</th>
              <th>Facture</th>
              <th className="col-montant">Solde retenu HT</th>
              <th>Échéance</th>
              <th>Réglée le</th>
            </tr>
          </thead>
          <tbody>
            {visibles.map((l) => (
              <tr key={l.pennylaneId}>
                <td className="passe-table__libelle">{l.tiers}</td>
                <td>{l.numero}</td>
                <td className="col-montant passe-table__montant">{formatMontant(l.montantHt)}</td>
                <td className="passe-table__date">{l.echeance ? formatDateCourte(l.echeance) : "—"}</td>
                {/* Règlement EFFECTIF (transaction bancaire) — jamais une date de paiement prévue. */}
                <td className="passe-table__date">{l.dateReglement ? formatDateCourte(l.dateReglement) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lignes.length > LIGNES_VISIBLES && (
        <button type="button" className="btn-secondaire" onClick={() => setTout((t) => !t)}>
          {tout ? "Afficher les principales" : `Voir les ${lignes.length} factures`}
        </button>
      )}
    </>
  );
}

// Réserve du chiffre affiché : combien de factures sont exclues, et le détail à la demande. Pour
// comprendre, pas pour corriger : ces données ne se modifient pas dans Novanta.
function ReserveExclusions({ exclues }: { exclues: FactureIncertaine[] }) {
  const [ouvert, setOuvert] = useState(false);
  const resume = resumerExclusions(exclues);
  return (
    <div className="passe-bfr__alerte">
      <p>{phraseExclusions(resume.nombre)}</p>
      <p className="passe-message">
        {resume.nombre} facture{resume.nombre > 1 ? "s" : ""} exclue{resume.nombre > 1 ? "s" : ""} — montant HT initial cumulé : {enK(resume.montantHtInitial)}
        {resume.sansMontantHt > 0 && ` (hors ${resume.sansMontantHt} sans montant HT)`}. Ordre de grandeur des factures à l&apos;émission, pas leur solde à cette date.
      </p>
      <button type="button" className="passe-lien-ligne" aria-expanded={ouvert} onClick={() => setOuvert((o) => !o)}>
        {ouvert ? "Masquer le détail" : "Voir le détail des factures exclues"}
      </button>
      {ouvert && (
        <div className="passe-detail__table passe-bfr__exclues">
          <table className="passe-table">
            <thead>
              <tr>
                <th>Client / fournisseur</th>
                <th>Facture</th>
                <th className="col-montant">Montant HT initial</th>
                <th>Émise le</th>
                <th>Échéance</th>
                <th>Raison de l&apos;exclusion</th>
                <th>Paiement</th>
              </tr>
            </thead>
            <tbody>
              {exclues.map((f) => (
                <tr key={`${f.type}|${f.pennylaneId}`}>
                  <td className="passe-table__libelle">
                    {f.tiers} <span className="passe-message">· {f.type === "client" ? "client" : "fournisseur"}</span>
                  </td>
                  <td>{f.numero}</td>
                  <td className="col-montant passe-table__montant">{f.montantHtInitial === null ? "—" : formatMontant(f.montantHtInitial)}</td>
                  <td className="passe-table__date">{f.dateEmission ? formatDateCourte(f.dateEmission) : "—"}</td>
                  <td className="passe-table__date">{f.echeance ? formatDateCourte(f.echeance) : "—"}</td>
                  <td>{f.raison}</td>
                  <td className="passe-message">{f.paiement}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function PasseBfr({ organizationId, rechargement, mois, stocks, sansStock, pennylaneConnecte, onOuvrirStocks, delaisVisibles, exercice, axeId, mappings }: PasseBfrProps) {
  const [factures, setFactures] = useState<FactureBfr[]>([]);
  const [synchroniseesLe, setSynchroniseesLe] = useState<string | null>(null);
  const [validees, setValidees] = useState<SituationValidee[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [enregistrement, setEnregistrement] = useState(false);
  const [moisChoisi, setMoisChoisi] = useState<string | null>(null);
  const [action, setAction] = useState<Action>("creances");
  // Analyse des délais ouverte (null : écran du BFR, sans aucun filtre) ; une analyse par côté,
  // indépendantes, gardées le temps de la session.
  const [coteAnalyse, setCoteAnalyse] = useState<CoteDelai | null>(null);
  const [analyses, setAnalyses] = useState<Partial<Record<CoteDelai, EtatAnalyse>>>({});
  // Catégories des transactions rapprochées : lues à la première analyse ouverte, relues après une
  // synchronisation. null : pas encore lues.
  const [categoriesTransactions, setCategoriesTransactions] = useState<CategoriesParTransaction | null>(null);
  const [erreurCategories, setErreurCategories] = useState(false);

  const charger = useCallback(async () => {
    const [faits, situations] = await Promise.all([chargerFacturesBfr(supabase!, organizationId), chargerSituationsValidees(supabase!, organizationId)]);
    setFactures(faits.factures);
    setCategoriesTransactions(null);
    setErreurCategories(false);
    setSynchroniseesLe(faits.synchroniseesLe);
    setValidees(situations);
  }, [organizationId]);

  useEffect(() => {
    let annule = false;
    setChargement(true);
    charger()
      .catch((e) => {
        if (annule) return;
        const code = (e as { code?: string } | null)?.code ?? "inconnu";
        console.error(`[passe/bfr] step=load organization=${organizationId} code=${code}`);
        setErreur("Le BFR n'a pas pu être chargé. Réessayez.");
      })
      .finally(() => {
        if (!annule) setChargement(false);
      });
    return () => {
      annule = true;
    };
  }, [charger, organizationId, rechargement]);

  // Jour de la synchronisation, en date locale : c'est lui qui se compare à la date de référence.
  const synchroniseLe = synchroniseesLe ? toISODate(new Date(synchroniseesLe)) : null;
  // Lecture partagée avec l'export PDF (lib/pastBfrLecture.ts) : mêmes chiffres pour un même mois.
  const sources = useMemo<SourcesBfr>(() => ({ factures, validees, stocks, sansStock, synchroniseLe }), [factures, validees, stocks, sansStock, synchroniseLe]);
  const stockDuMois = useCallback((m: string): number | null => stockBfrDuMois(stocks, sansStock, m), [stocks, sansStock]);
  const situationDu = useCallback((m: string): SituationBfr => situationBfrDuMois(sources, m), [sources]);
  const valideeDu = useCallback((m: string) => valideeDuMois(validees, m), [validees]);

  const courant = moisChoisi !== null && mois.includes(moisChoisi) ? moisChoisi : mois[mois.length - 1] ?? null;

  // Délais clients / fournisseurs de la cohorte (factures émises sur la période) et de la période
  // précédente (mois civil précédent) — lecture analytique, sans effet sur le BFR ni sur les situations validées.
  const aujourdhuiDelais = toISODate(new Date());
  // Écran du BFR : cohorte du mois, toutes les factures — jamais de filtre ici.
  const delais = useMemo(() => {
    if (courant === null) return null;
    const p = periodeDesDelais(courant);
    const cohorte = (cote: CoteDelai, periode: { debut: string; fin: string }): DelaisCohorte => delaisDeLaCohorte(factures, cote, periode, aujourdhuiDelais);
    return {
      court: p.court,
      courtPrecedent: p.courtPrecedent,
      client: delaisDuMois(factures, "client", courant, aujourdhuiDelais),
      fournisseur: delaisDuMois(factures, "fournisseur", courant, aujourdhuiDelais),
      clientPrecedent: cohorte("client", p.precedente),
      fournisseurPrecedent: cohorte("fournisseur", p.precedente),
    };
  }, [factures, courant, aujourdhuiDelais]);

  // Analyse : la population des filtres du niveau affiché (analyse, ou détail d'une tranche).
  const etatAnalyse = coteAnalyse === null ? null : analyses[coteAnalyse] ?? null;
  const filtresVue = etatAnalyse === null ? null : etatAnalyse.tranche === null ? etatAnalyse.filtres : etatAnalyse.filtresDetail;
  const analyseOuverte = coteAnalyse !== null;
  useEffect(() => {
    if (!analyseOuverte || categoriesTransactions !== null) return;
    let annule = false;
    chargerCategoriesDesTransactions(supabase!, organizationId, transactionsRapprochees(factures))
      .then((parTransaction) => {
        if (!annule) setCategoriesTransactions(parTransaction);
      })
      .catch((e) => {
        // Sans elles, le filtre de catégorie reste indisponible ; l'analyse fonctionne.
        console.error(`[passe/bfr] step=transaction-categories organization=${organizationId} code=${(e as { code?: string } | null)?.code ?? "inconnu"}`);
        if (annule) return;
        setErreurCategories(true);
        setCategoriesTransactions(new Map());
      });
    return () => {
      annule = true;
    };
  }, [analyseOuverte, categoriesTransactions, factures, organizationId]);
  // Factures de l'analyse, avec l'étage P&L de leurs transactions rapprochées (correspondance P&L
  // courante : la modifier relit tout l'historique). Le BFR lit `factures`, jamais celles-ci.
  const facturesAnalyse = useMemo(
    () => (analyseOuverte ? avecCategoriesDesTransactions(factures, etagesParTransaction(categoriesTransactions ?? new Map(), axeId, mappings)) : factures),
    [analyseOuverte, factures, categoriesTransactions, axeId, mappings]
  );
  const analyse = useMemo(() => {
    if (coteAnalyse === null || filtresVue === null) return null;
    const resolue = resoudrePeriode(filtresVue.periode, exercice);
    // Seules des périodes valides sont enregistrées ; par sûreté, une période illisible n'analyse rien.
    if (!resolue.ok) return null;
    return {
      resolue,
      cohorte: delaisDeLaCohorte(facturesAnalyse, coteAnalyse, resolue.periode, aujourdhuiDelais, { seuilHt: filtresVue.seuilHt, categorie: filtresVue.categorie }),
      etages: etagesProposes(facturesAnalyse, coteAnalyse),
      diagnostic: diagnosticCategories(facturesAnalyse, coteAnalyse, categoriesTransactions, erreurCategories, axeId !== null),
      premiere: premiereEmission(facturesAnalyse, coteAnalyse),
    };
  }, [facturesAnalyse, coteAnalyse, filtresVue, exercice, axeId, aujourdhuiDelais, categoriesTransactions, erreurCategories]);

  const ouvrirAnalyse = (cote: CoteDelai) => {
    const existante = analyses[cote];
    if (!existante || existante.moisBfr !== courant) {
      const initiaux = filtresInitiaux(courant as string);
      setAnalyses({ ...analyses, [cote]: { moisBfr: courant as string, filtres: initiaux, filtresDetail: initiaux, tranche: null, mesure: "nombre" } });
    }
    setCoteAnalyse(cote);
  };
  const majAnalyse = (changement: Partial<EtatAnalyse>) => {
    if (coteAnalyse === null || !etatAnalyse) return;
    setAnalyses({ ...analyses, [coteAnalyse]: { ...etatAnalyse, ...changement } });
  };

  // Évolution : les 12 derniers mois glissants jusqu'au mois choisi (lib/pastBfrLecture.ts).
  const evolution = useMemo<PointBfr[]>(
    () => (courant === null ? [] : evolutionVisible(evolutionBfr(sources, courant, aujourdhuiDelais), delaisVisibles)),
    [courant, sources, aujourdhuiDelais, delaisVisibles.clients, delaisVisibles.fournisseurs]
  );

  if (chargement) return <div className="passe-etat">Chargement du BFR…</div>;
  if (courant === null) {
    return <div className="passe-etat">Aucun mois terminé sur la période : le BFR se calcule à la fin de chaque mois.</div>;
  }

  const situation = situationDu(courant);
  const validee = valideeDu(courant);
  const statut = statutBfr(situation, validee);
  const totaux = totauxRetenus(situation, validee);
  const precedent = moisPrecedent(courant);
  const totauxPrecedents: TotauxBfr | null = totauxRetenus(situationDu(precedent), valideeDu(precedent));
  const variation = totaux && totauxPrecedents ? variationBfr(totauxPrecedents, totaux) : null;
  const creances = validee ? validee.creancesRetenues : situation.creances;
  const dettes = validee ? validee.dettesRetenues : situation.dettes;
  const depassee = validee !== null && photographieDepassee(validee, situation);
  const devenuesFiables = validee !== null ? exclusionsDevenuesFiables(validee, situation) : [];
  const exclues = facturesExcluesRetenues(situation, validee);
  const excluesPrecedent = facturesExcluesRetenues(situationDu(precedent), valideeDu(precedent));
  const stockPrecedent = stockDuMois(precedent);

  const enregistrer = async (revision: boolean) => {
    const maintenant = new Date().toISOString();
    const photo = photographier(situation, synchroniseLe, maintenant);
    if (photo === null || enregistrement) return;
    // Réserve enregistrée dans la photographie : confirmée explicitement, jamais par défaut.
    const nombreExclues = photo.facturesExclues.length;
    const objet = revision ? "Cette révision sera validée" : "Ce BFR sera validé";
    if (nombreExclues > 0 && !window.confirm(`${objet} avec ${nombreExclues} facture${nombreExclues > 1 ? "s" : ""} exclue${nombreExclues > 1 ? "s" : ""} du calcul.`)) return;
    setEnregistrement(true);
    setErreur(null);
    const provenance = {
      source: "pennylane",
      calcul: VERSION_CALCUL,
      factures_synchronisees_le: synchroniseesLe,
      stock: sansStock && stocks.length === 0 ? "societe_sans_stock" : "inventaire_saisi",
      nombre_creances: photo.creancesRetenues.length,
      nombre_dettes: photo.dettesRetenues.length,
    };
    try {
      if (revision && validee) await reviserSituationBfr(supabase!, organizationId, reviser(validee, photo, maintenant), provenance);
      else await validerSituationBfr(supabase!, organizationId, photo, provenance);
      await charger();
      setMessage(revision ? "Situation révisée ; la version précédente est conservée." : "BFR validé : la photographie est figée.");
    } catch (e) {
      const code = (e as { code?: string } | null)?.code ?? "inconnu";
      console.error(`[passe/bfr] step=${revision ? "revise" : "validate"} organization=${organizationId} code=${code}`);
      setErreur("La situation n'a pas pu être enregistrée. Réessayez.");
    } finally {
      setEnregistrement(false);
    }
  };

  const bfrAffiche = bfrAfficheDe(evolution);

  return (
    <div className="passe-bfr">
      {/* La date de référence pilote le BFR seul : l'analyse des délais a sa propre période. */}
      {etatAnalyse === null && (
      <div className="passe-bfr__barre">
        <label className="passe-controle__label" htmlFor="passe-bfr-mois">
          Date de référence
        </label>
        <select id="passe-bfr-mois" value={courant} onChange={(e) => setMoisChoisi(e.target.value)}>
          {[...mois].reverse().map((m) => (
            <option key={m} value={m}>
              {formatDateCourte(finDeMois(m))}
            </option>
          ))}
        </select>
        <span className="passe-message">
          {synchroniseesLe
            ? `Factures synchronisées le ${formatDateCourte(synchroniseLe as string)}`
            : pennylaneConnecte === false
              ? "Connectez Pennylane pour calculer le BFR."
              : "Factures jamais synchronisées pour le BFR."}
        </span>
      </div>
      )}
      {erreur && <p className="login-erreur">{erreur}</p>}
      {message && <p className="passe-message">{message}</p>}

      {etatAnalyse && analyse && filtresVue ? (
        <VueDelais
          cohorte={analyse.cohorte}
          filtres={filtresVue}
          // Chaque niveau modifie ses seuls filtres : le détail ne remonte jamais vers l'analyse.
          onFiltres={(filtres) => majAnalyse(etatAnalyse.tranche === null ? { filtres } : { filtresDetail: filtres })}
          libellePeriode={analyse.resolue.libelle}
          periodeResolue={analyse.resolue.periode}
          exercice={exercice}
          premiere={analyse.premiere}
          aujourdhui={aujourdhuiDelais}
          etages={analyse.etages}
          diagnosticCategories={analyse.diagnostic}
          mesure={etatAnalyse.mesure}
          onMesure={(mesure) => majAnalyse({ mesure })}
          tranche={etatAnalyse.tranche}
          // Ouvrir une tranche : le détail part des filtres de l'analyse ; revenir garde ceux de l'analyse.
          onTranche={(tranche) => majAnalyse(tranche === null ? { tranche } : { tranche, filtresDetail: etatAnalyse.filtres })}
          onRetour={() => {
            majAnalyse({ tranche: null });
            setCoteAnalyse(null);
          }}
        />
      ) : (
        <>
      <div className="passe-bfr__haut">
        {/* A. Synthèse */}
        <section className="passe-kpi passe-bfr__synthese">
          <p className="eyebrow eyebrow--grand">BFR au {formatDateCourte(finDeMois(courant))}</p>
          <p className="passe-kpi__montant">{totaux ? enK(totaux.bfr) : "Indisponible"}</p>
          {variation && (
            <p className="passe-kpi__ratio">
              {signeK(variation.total)} par rapport au {formatDateCourte(finDeMois(precedent))}
            </p>
          )}
          <p className="passe-bfr__meta">
            <Statut statut={statut} />
            {validee && exclues.length > 0 && <Statut statut="reserves" />}
            {validee && (
              <span>
                Validé le {formatDateCourte(toISODate(new Date(validee.valideeLe)))} · factures du{" "}
                {validee.synchroniseLe ? formatDateCourte(validee.synchroniseLe) : "—"}
                {validee.revisions.length > 0 && ` · ${validee.revisions.length} révision${validee.revisions.length > 1 ? "s" : ""}`}
              </span>
            )}
          </p>

          {/* Sans chiffre (indisponible), il n'y a rien dont ces factures seraient exclues. */}
          {totaux !== null && exclues.length > 0 && <ReserveExclusions key={courant} exclues={exclues} />}

          {/* F. Validation */}
          {validee === null && (
            <button type="button" className="btn-add" onClick={() => enregistrer(false)} disabled={situation.bfr === null || enregistrement}>
              Valider le BFR
            </button>
          )}
          {depassee && (
            <div className="passe-bfr__alerte">
              <p>
                {devenuesFiables.length > 0
                  ? `Données nouvelles : ${devenuesFiables.length > 1 ? `${devenuesFiables.length} factures exclues à la validation sont désormais établies` : "1 facture exclue à la validation est désormais établie"}`
                  : "Les données ont changé depuis la validation"}{" "}
                : BFR recalculé {enK(situation.bfr as number)}. La photographie validée reste inchangée tant que vous ne la révisez pas.
              </p>
              <button type="button" className="btn-secondaire" onClick={() => enregistrer(true)} disabled={enregistrement}>
                Réviser la situation validée
              </button>
            </div>
          )}

          {situation.raisons.length > 0 && validee === null && (
            <div className="passe-bfr__alerte">
              <ul>
                {situation.raisons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {situation.stock === null && (
                <button type="button" className="btn-secondaire" onClick={onOuvrirStocks}>
                  Renseigner le stock →
                </button>
              )}
            </div>
          )}
        </section>

        {/* B. Décomposition — chaque délai sous la composante qu'il explique. */}
        <section className="passe-bfr__decomposition-zone" aria-label="Décomposition du BFR">
        <div className="passe-bfr__decomposition">
          <div className="passe-bfr__terme">
            <span>Créances clients HT</span>
            <strong>{validee ? enK(validee.creances) : enK(situation.totalCreances)}</strong>
            {delais && delaisVisibles.clients && (
              <CartoucheDelai
                cohorte={delais.client}
                precedente={delais.clientPrecedent}
                periode={delais.court}
                periodePrecedente={delais.courtPrecedent}
                onOuvrir={() => ouvrirAnalyse("client")}
              />
            )}
          </div>
          <span className="passe-bfr__operateur" aria-hidden="true">+</span>
          <div className="passe-bfr__terme">
            <span>Stocks HT</span>
            <strong>{validee ? enK(validee.stock) : situation.stock === null ? "Non renseigné" : enK(situation.stock)}</strong>
          </div>
          <span className="passe-bfr__operateur" aria-hidden="true">−</span>
          <div className="passe-bfr__terme">
            <span>Dettes fournisseurs HT</span>
            <strong>{validee ? enK(validee.dettes) : enK(situation.totalDettes)}</strong>
            {delais && delaisVisibles.fournisseurs && (
              <CartoucheDelai
                cohorte={delais.fournisseur}
                precedente={delais.fournisseurPrecedent}
                periode={delais.court}
                periodePrecedente={delais.courtPrecedent}
                onOuvrir={() => ouvrirAnalyse("fournisseur")}
              />
            )}
          </div>
          <span className="passe-bfr__operateur" aria-hidden="true">=</span>
          <div className="passe-bfr__terme passe-bfr__terme--total">
            <span>BFR HT</span>
            <strong>{totaux ? enK(totaux.bfr) : "Indisponible"}</strong>
          </div>
        </div>
        </section>
      </div>

      {/* C. Évolution : 12 derniers mois jusqu'au mois consulté — BFR en barres, délais en courbes. */}
      <section className="passe-structure">
        <h3 className="eyebrow eyebrow--encre">
          {delaisVisibles.clients || delaisVisibles.fournisseurs ? "Évolution sur 12 mois — BFR HT et délais de paiement" : "Évolution sur 12 mois — BFR HT"}
        </h3>
        <LegendeEvolution bfrAffiche={bfrAffiche} delaiClients={delaisVisibles.clients} delaiFournisseurs={delaisVisibles.fournisseurs} />
        <PasseBfrEvolutionChart
          evolution={evolution}
          courant={courant}
          // Clic sur un mois de la période du module : il devient le mois consulté.
          onSelect={(m) => {
            if (mois.includes(m)) setMoisChoisi(m);
          }}
        />
        <p className="passe-message">
          {bfrAffiche
            ? "BFR (barres, axe de gauche, k€) : barre pleine = validé, barre claire = provisoire ou avec réserves, pas de barre = indisponible, jamais estimé ; le mois consulté est encadré. "
            : "BFR non affiché : aucun des 12 mois n'a de situation calculable (stock HT non renseigné ou factures non synchronisées). "}
          {(delaisVisibles.clients || delaisVisibles.fournisseurs) &&
            "Délais (courbes, axe de droite, jours) : délai moyen réel des factures émises chaque mois, pondéré par le montant HT — le même chiffre que le KPI du mois ; pas de point sans facture réglée. "}
          Chaque mois est daté à son dernier jour.
        </p>
      </section>

      {/* D. Pourquoi le BFR a-t-il bougé ? */}
      <section className="passe-structure">
        <h3 className="eyebrow eyebrow--encre">Pourquoi le BFR a-t-il bougé ?</h3>
        {variation ? (
          <>
          <table className="passe-table passe-bfr__variation">
            <tbody>
              <tr>
                <td>Variation des créances clients</td>
                <td className="col-montant passe-table__montant">{signeK(variation.creances)}</td>
              </tr>
              <tr>
                <td>Variation des stocks</td>
                <td className="col-montant passe-table__montant">{signeK(variation.stock)}</td>
              </tr>
              <tr>
                <td>Variation des dettes fournisseurs (une hausse réduit le BFR)</td>
                <td className="col-montant passe-table__montant">{signeK(variation.dettes)}</td>
              </tr>
              <tr className="passe-bfr__variation-total">
                <td>
                  Variation du BFR depuis le {formatDateCourte(finDeMois(precedent))}
                </td>
                <td className="col-montant passe-table__montant">{signeK(variation.total)}</td>
              </tr>
            </tbody>
          </table>
          {(exclues.length > 0 || excluesPrecedent.length > 0) && (
            <p className="passe-reserve">À lire avec réserve : les factures exclues du calcul ne sont pas les mêmes d&apos;un mois à l&apos;autre.</p>
          )}
          </>
        ) : (
          <p className="passe-structure__vide">
            Variation indisponible : il faut un BFR fiable au {formatDateCourte(finDeMois(precedent))} et au{" "}
            {formatDateCourte(finDeMois(courant))}.
          </p>
        )}
      </section>

      {/* E. Sur quoi agir ? */}
      <section className="passe-structure">
        <h3 className="eyebrow eyebrow--encre">Sur quoi agir ?</h3>
        <div className="passe-tri" role="group" aria-label="Composante du BFR">
          {(
            [
              ["creances", `Créances clients (${creances.length})`],
              ["stocks", "Stocks"],
              ["dettes", `Dettes fournisseurs (${dettes.length})`],
            ] as [Action, string][]
          ).map(([cle, libelle]) => (
            <button
              key={cle}
              type="button"
              className={`btn-secondaire${action === cle ? " btn-module--actif" : ""}`}
              aria-pressed={action === cle}
              onClick={() => setAction(cle)}
            >
              {libelle}
            </button>
          ))}
        </div>
        {action === "creances" && <ListeFactures lignes={creances} libelleTiers="Client" />}
        {action === "dettes" && <ListeFactures lignes={dettes} libelleTiers="Fournisseur" />}
        {action === "stocks" && (
          <div className="passe-bfr__stocks">
            {(validee ? validee.stock : situation.stock) === null ? (
              <p className="passe-structure__vide">Stock HT non renseigné pour {libelleMois(courant).toLowerCase()}.</p>
            ) : (
              <p>
                Stock HT au {formatDateCourte(finDeMois(courant))} : <strong>{formatMontant((validee ? validee.stock : situation.stock) as number)}</strong>
                {stockPrecedent !== null && (
                  <span className="passe-message">
                    {" "}
                    · {signeK((validee ? validee.stock : (situation.stock as number)) - stockPrecedent)} par rapport à l&apos;inventaire précédent
                  </span>
                )}
              </p>
            )}
            <button type="button" className="btn-secondaire" onClick={onOuvrirStocks}>
              Ouvrir les stocks →
            </button>
          </div>
        )}
      </section>
        </>
      )}
    </div>
  );
}
