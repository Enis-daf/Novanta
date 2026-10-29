"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { supabase } from "@/lib/supabaseClient";
import { formatDateCourte, toISODate } from "@/lib/dates";
import { formatKiloEuros, formatMontant } from "@/lib/format";
import { graduationsAxe, NEUTRES, TEINTE_SERIE_PRINCIPALE } from "@/lib/dataviz";
import { finDeMois, StockFinDeMois } from "@/lib/pastAdjustments";
import { libelleMois, libelleMoisCourt } from "@/lib/pastDetail";
import {
  FactureBfr,
  LIBELLES_STATUT_BFR,
  LigneBfr,
  photographier,
  photographieDepassee,
  reviser,
  SituationBfr,
  situationBfr,
  SituationValidee,
  StatutBfr,
  statutBfr,
  TotauxBfr,
  totauxRetenus,
  variationBfr,
} from "@/lib/pastBfr";
import { CoteDelai, delaisDeLaCohorte, DelaisCohorte } from "@/lib/pastBfrDelais";
import { CartoucheDelai, MesureDistribution, VueDelais } from "./PasseBfrDelais";
import {
  chargerFacturesBfr,
  chargerSituationsValidees,
  reviserSituationBfr,
  validerSituationBfr,
} from "@/lib/pastBfrRepository";

interface PasseBfrProps {
  organizationId: string;
  accessToken: string;
  // Mois (YYYY-MM) terminés de la période du module : chacun a sa situation de fin de mois.
  mois: string[];
  stocks: StockFinDeMois[];
  sansStock: boolean;
  pennylaneConnecte: boolean | null;
  onOuvrirStocks: () => void;
}

const MAX_APPELS_SYNCHRO = 40;
const LIGNES_VISIBLES = 10;
const VERSION_CALCUL = "bfr-1";

type Action = "creances" | "stocks" | "dettes";

const enK = (montant: number) => `${formatKiloEuros(montant, Math.abs(montant) < 10_000 ? 1 : 0)} HT`;
const signeK = (montant: number) => `${montant > 0.5 ? "+" : ""}${enK(montant)}`;

function moisPrecedent(mois: string): string {
  const annee = Number(mois.slice(0, 4));
  const numero = Number(mois.slice(5, 7));
  return numero === 1 ? `${annee - 1}-12` : `${annee}-${String(numero - 1).padStart(2, "0")}`;
}

// Délais de paiement : cohorte du mois de référence, ou de son trimestre civil.
type PeriodeDelais = "mois" | "trimestre";

function periodeDesDelais(mois: string, type: PeriodeDelais): { debut: string; fin: string; precedente: { debut: string; fin: string }; libelle: string } {
  const annee = Number(mois.slice(0, 4));
  const numero = Number(mois.slice(5, 7));
  if (type === "mois") {
    const prec = moisPrecedent(mois);
    return { debut: `${mois}-01`, fin: finDeMois(mois), precedente: { debut: `${prec}-01`, fin: finDeMois(prec) }, libelle: `en ${libelleMois(mois).toLowerCase()}` };
  }
  const t = Math.floor((numero - 1) / 3);
  const premier = (a: number, q: number) => `${a}-${String(q * 3 + 1).padStart(2, "0")}`;
  const dernier = (a: number, q: number) => `${a}-${String(q * 3 + 3).padStart(2, "0")}`;
  const [ap, tp] = t === 0 ? [annee - 1, 3] : [annee, t - 1];
  return {
    debut: `${premier(annee, t)}-01`,
    fin: finDeMois(dernier(annee, t)),
    precedente: { debut: `${premier(ap, tp)}-01`, fin: finDeMois(dernier(ap, tp)) },
    libelle: `au ${t + 1}${t === 0 ? "er" : "e"} trimestre ${annee}`,
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

interface PointBfr {
  mois: string;
  valeur: number | null;
  statut: StatutBfr;
}

function InfoBulleBfr({ active, payload }: { active?: boolean; payload?: { payload: PointBfr }[] }) {
  if (!active || !payload?.length) return null;
  const { mois, valeur, statut } = payload[0].payload;
  return (
    <div className="passe-structure__infobulle">
      <strong>{libelleMois(mois)}</strong>
      <span>{valeur === null ? "BFR incomplet" : `${formatMontant(valeur)} HT`}</span>
      <span className="passe-structure__note">{LIBELLES_STATUT_BFR[statut]}</span>
    </div>
  );
}

export default function PasseBfr({ organizationId, accessToken, mois, stocks, sansStock, pennylaneConnecte, onOuvrirStocks }: PasseBfrProps) {
  const [factures, setFactures] = useState<FactureBfr[]>([]);
  const [synchroniseesLe, setSynchroniseesLe] = useState<string | null>(null);
  const [validees, setValidees] = useState<SituationValidee[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [syncEnCours, setSyncEnCours] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [enregistrement, setEnregistrement] = useState(false);
  const [moisChoisi, setMoisChoisi] = useState<string | null>(null);
  const [action, setAction] = useState<Action>("creances");
  // Délais de paiement : période de la cohorte, et vue détaillée ouverte (null : synthèse BFR).
  const [periodeDelais, setPeriodeDelais] = useState<PeriodeDelais>("mois");
  const [vueDelais, setVueDelais] = useState<{ cote: CoteDelai; tranche: string | null; mesure: MesureDistribution } | null>(null);

  const charger = useCallback(async () => {
    const [faits, situations] = await Promise.all([chargerFacturesBfr(supabase!, organizationId), chargerSituationsValidees(supabase!, organizationId)]);
    setFactures(faits.factures);
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
  }, [charger, organizationId]);

  // Jour de la synchronisation, en date locale : c'est lui qui se compare à la date de référence.
  const synchroniseLe = synchroniseesLe ? toISODate(new Date(synchroniseesLe)) : null;
  const stockDuMois = useCallback(
    (m: string): number | null => {
      const saisi = stocks.find((s) => s.mois === m);
      if (saisi) return saisi.valeur;
      // Société déclarée sans stock (et aucun stock saisi) : un stock nul est une donnée, pas un manque.
      return sansStock && stocks.length === 0 ? 0 : null;
    },
    [stocks, sansStock]
  );
  const situationDu = useCallback(
    (m: string): SituationBfr => situationBfr({ factures, date: finDeMois(m), stock: stockDuMois(m), synchroniseLe }),
    [factures, stockDuMois, synchroniseLe]
  );
  const valideeDu = useCallback((m: string) => validees.find((v) => v.date === finDeMois(m)) ?? null, [validees]);

  const courant = moisChoisi !== null && mois.includes(moisChoisi) ? moisChoisi : mois[mois.length - 1] ?? null;

  // Délais clients / fournisseurs de la cohorte (factures émises sur la période) et de la période
  // précédente de même durée — lecture analytique, sans effet sur le BFR ni sur les situations validées.
  const aujourdhuiDelais = toISODate(new Date());
  const delais = useMemo(() => {
    if (courant === null) return null;
    const p = periodeDesDelais(courant, periodeDelais);
    const cohorte = (cote: CoteDelai, periode: { debut: string; fin: string }): DelaisCohorte => delaisDeLaCohorte(factures, cote, periode, aujourdhuiDelais);
    return {
      libelle: p.libelle,
      client: cohorte("client", p),
      fournisseur: cohorte("fournisseur", p),
      clientPrecedent: cohorte("client", p.precedente),
      fournisseurPrecedent: cohorte("fournisseur", p.precedente),
    };
  }, [factures, courant, periodeDelais, aujourdhuiDelais]);

  const evolution = useMemo<PointBfr[]>(
    () =>
      mois.map((m) => {
        const situation = situationDu(m);
        const validee = valideeDu(m);
        return { mois: m, valeur: totauxRetenus(situation, validee)?.bfr ?? null, statut: statutBfr(situation, validee) };
      }),
    [mois, situationDu, valideeDu]
  );

  // Deux étapes (voir app/api/passe/bfr/route.ts) : les factures, puis la datation des règlements,
  // rappelée tant qu'il en reste. Le message dit l'étape réellement en cours ; le compteur n'apparaît
  // que lorsque le serveur a donné le nombre de factures à dater. « À jour » seulement à la fin.
  const synchroniser = async () => {
    if (syncEnCours) return;
    setSyncEnCours(true);
    setErreur(null);
    const synchro = crypto.randomUUID();
    const appeler = async (etape: "factures" | "reglements") => {
      const res = await fetch("/api/passe/bfr", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ etape, synchro }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "La synchronisation des factures Pennylane a échoué. Réessayez.");
      return data;
    };
    try {
      setMessage("Récupération des factures Pennylane…");
      const factures = await appeler("factures");
      let restantes: number = factures.aDater ?? 0;
      // Un lot interrompu sans aucune facture datée (Pennylane indisponible) : deux de suite, et la
      // synchronisation s'arrête — ce qui est daté reste acquis, une relance reprendra.
      let lotsVides = 0;
      for (let appel = 0; restantes > 0 && appel < MAX_APPELS_SYNCHRO && lotsVides < 2; appel++) {
        setMessage(`Récupération des règlements : ${restantes} factures à dater…`);
        const lot = await appeler("reglements");
        restantes = lot.restantes ?? 0;
        lotsVides = lot.datees > 0 ? 0 : lotsVides + 1;
      }
      setMessage("Calcul des situations BFR…");
      await charger();
      setMessage(
        restantes > 0
          ? `Synchronisation interrompue : ${restantes} factures restent à dater. Relancez-la pour reprendre.`
          : `${factures.factures ?? 0} factures Pennylane à jour.${
              factures.complete === false ? " Liste très volumineuse : certaines factures anciennes peuvent manquer." : ""
            }`
      );
    } catch (e) {
      setMessage(null);
      setErreur(e instanceof Error && !(e instanceof TypeError) && e.message ? e.message : "Pennylane est temporairement indisponible. Réessayez.");
      await charger().catch(() => undefined);
    } finally {
      setSyncEnCours(false);
    }
  };

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
  const stockPrecedent = stockDuMois(precedent);

  const enregistrer = async (revision: boolean) => {
    const maintenant = new Date().toISOString();
    const photo = photographier(situation, synchroniseLe, maintenant);
    if (photo === null || enregistrement) return;
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

  const plusieursAnnees = new Set(mois.map((m) => m.slice(0, 4))).size > 1;
  const valeurs = evolution.map((p) => p.valeur).filter((v): v is number => v !== null);
  const graduations = graduationsAxe(valeurs.length > 0 ? valeurs : [0]);

  return (
    <div className="passe-bfr">
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
        {pennylaneConnecte !== false && (
          <button type="button" className="btn-secondaire" onClick={synchroniser} disabled={syncEnCours}>
            {syncEnCours ? "Synchronisation…" : "Actualiser les factures Pennylane"}
          </button>
        )}
        <span className="passe-message">
          {synchroniseesLe
            ? `Factures synchronisées le ${formatDateCourte(synchroniseLe as string)}`
            : pennylaneConnecte === false
              ? "Connectez Pennylane pour calculer le BFR."
              : "Factures jamais synchronisées pour le BFR."}
        </span>
      </div>
      {erreur && <p className="login-erreur">{erreur}</p>}
      {message && <p className="passe-message">{message}</p>}

      {vueDelais && delais ? (
        <VueDelais
          cohorte={delais[vueDelais.cote]}
          libellePeriode={delais.libelle}
          mesure={vueDelais.mesure}
          onMesure={(mesure) => setVueDelais({ ...vueDelais, mesure })}
          tranche={vueDelais.tranche}
          onTranche={(tranche) => setVueDelais({ ...vueDelais, tranche })}
          onRetour={() => setVueDelais(null)}
        />
      ) : (
        <>
      <div className="passe-bfr__haut">
        {/* A. Synthèse */}
        <section className="passe-kpi passe-bfr__synthese">
          <p className="eyebrow eyebrow--grand">BFR au {formatDateCourte(finDeMois(courant))}</p>
          <p className="passe-kpi__montant">{totaux ? enK(totaux.bfr) : "Incomplet"}</p>
          {variation && (
            <p className="passe-kpi__ratio">
              {signeK(variation.total)} par rapport au {formatDateCourte(finDeMois(precedent))}
            </p>
          )}
          <p className="passe-bfr__meta">
            <Statut statut={statut} />
            {validee ? (
              <span>
                Validé le {formatDateCourte(toISODate(new Date(validee.valideeLe)))} · factures du{" "}
                {validee.synchroniseLe ? formatDateCourte(validee.synchroniseLe) : "—"}
                {validee.revisions.length > 0 && ` · ${validee.revisions.length} révision${validee.revisions.length > 1 ? "s" : ""}`}
              </span>
            ) : (
              <span>Factures du {synchroniseLe ? formatDateCourte(synchroniseLe) : "—"}</span>
            )}
          </p>

          {/* F. Validation */}
          {validee === null && (
            <button type="button" className="btn-add" onClick={() => enregistrer(false)} disabled={!situation.complete || enregistrement}>
              Valider le BFR
            </button>
          )}
          {validee === null && !situation.complete && <p className="passe-message">Validation impossible tant que le calcul est incomplet.</p>}
          {depassee && (
            <div className="passe-bfr__alerte">
              <p>
                Les données ont changé depuis la validation : BFR recalculé {enK(situation.bfr as number)}. La photographie validée
                reste inchangée tant que vous ne la révisez pas.
              </p>
              <button type="button" className="btn-secondaire" onClick={() => enregistrer(true)} disabled={enregistrement}>
                Réviser la situation validée
              </button>
            </div>
          )}

          {!situation.complete && validee === null && (
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
        {delais && (
          <div className="passe-bfr__delais-periode">
            <span className="passe-message">Délais de paiement des factures émises {delais.libelle}</span>
            <div className="selecteur" role="group" aria-label="Période des délais de paiement">
              {(
                [
                  ["mois", "Mois"],
                  ["trimestre", "Trimestre"],
                ] as [PeriodeDelais, string][]
              ).map(([cle, libelle]) => (
                <button key={cle} type="button" className={`btn-secondaire${periodeDelais === cle ? " btn-module--actif" : ""}`} aria-pressed={periodeDelais === cle} onClick={() => setPeriodeDelais(cle)}>
                  {libelle}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="passe-bfr__decomposition">
          <div className="passe-bfr__terme">
            <span>Créances clients HT</span>
            <strong>{validee ? enK(validee.creances) : enK(situation.totalCreances)}</strong>
            {delais && (
              <CartoucheDelai cohorte={delais.client} precedente={delais.clientPrecedent} onOuvrir={() => setVueDelais({ cote: "client", tranche: null, mesure: "nombre" })} />
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
            {delais && (
              <CartoucheDelai
                cohorte={delais.fournisseur}
                precedente={delais.fournisseurPrecedent}
                onOuvrir={() => setVueDelais({ cote: "fournisseur", tranche: null, mesure: "nombre" })}
              />
            )}
          </div>
          <span className="passe-bfr__operateur" aria-hidden="true">=</span>
          <div className="passe-bfr__terme passe-bfr__terme--total">
            <span>BFR HT</span>
            <strong>{totaux ? enK(totaux.bfr) : "Incomplet"}</strong>
          </div>
        </div>
        </section>
      </div>

      {/* C. Évolution : seuls les mois fiables ont un barreau ; le provisoire est plus clair. */}
      <section className="passe-structure">
        <h3 className="eyebrow eyebrow--encre">Évolution du BFR HT</h3>
        <div style={{ fontFamily: "var(--font-lexend), sans-serif", cursor: "pointer" }}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={evolution}
              margin={{ top: 12, right: 8, left: 0, bottom: 0 }}
              onClick={(etat) => {
                if (typeof etat?.activeLabel === "string") setMoisChoisi(etat.activeLabel);
              }}
            >
              <CartesianGrid vertical={false} stroke={NEUTRES.bordure} />
              <XAxis
                dataKey="mois"
                tickFormatter={(m: string) => libelleMoisCourt(m, plusieursAnnees)}
                fontSize={11}
                tick={{ fill: NEUTRES.secondaire }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(v: number) => formatKiloEuros(v, 0)}
                ticks={graduations}
                domain={[graduations[0], graduations[graduations.length - 1]]}
                width={72}
                fontSize={11}
                tick={{ fill: NEUTRES.secondaire }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<InfoBulleBfr />} cursor={{ fill: NEUTRES.bordure, fillOpacity: 0.5 }} />
              <Bar dataKey="valeur" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false}>
                {evolution.map((p) => (
                  <Cell
                    key={p.mois}
                    fill={TEINTE_SERIE_PRINCIPALE}
                    fillOpacity={p.statut === "validee" ? 1 : 0.4}
                    stroke={p.mois === courant ? NEUTRES.encre : undefined}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="passe-message">
          Barreau plein : validé · clair : provisoire · absent : incomplet (données manquantes ou non fiables), jamais estimé.
        </p>
      </section>

      {/* D. Pourquoi le BFR a-t-il bougé ? */}
      <section className="passe-structure">
        <h3 className="eyebrow eyebrow--encre">Pourquoi le BFR a-t-il bougé ?</h3>
        {variation ? (
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
        {validee === null && situation.incertaines.length > 0 && (
          <div className="passe-bfr__incertaines">
            <p className="passe-message">Factures au solde inconnu à cette date — exclues, jamais estimées :</p>
            <table className="passe-table">
              <tbody>
                {situation.incertaines.slice(0, LIGNES_VISIBLES).map((f) => (
                  <tr key={`${f.type}|${f.pennylaneId}`}>
                    <td className="passe-table__libelle">
                      {f.tiers} · {f.numero}
                    </td>
                    <td>{f.type === "client" ? "Client" : "Fournisseur"}</td>
                    <td className="col-montant passe-table__montant">jusqu&apos;à {formatMontant(f.montantHtMax)} HT</td>
                    <td className="passe-message">{f.raison}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
        </>
      )}
    </div>
  );
}
