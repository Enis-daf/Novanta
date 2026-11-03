"use client";

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatDateCourte } from "@/lib/dates";
import { formatKiloEuros, formatMontant } from "@/lib/format";
import { NEUTRES, TEINTE_SERIE_PRINCIPALE } from "@/lib/dataviz";
import {
  CoteDelai,
  DelaisCohorte,
  LIBELLES_EXCLUSION,
  libelleEcartEcheance,
  libelleRetardOuverte,
  libelleSeuil,
  libelleTrancheDansPhrase,
  libelleVariationJours,
  comparerAvecPrecedente,
  nombreDelaisIncertains,
  NiveauDispersion,
  RaisonExclusion,
  SEUIL_DISPERSION,
  SEUILS_MONTANT_PROPOSES,
  seuilValide,
  Volume,
} from "@/lib/pastBfrDelais";

/*
 * Délai clients / délai fournisseurs de l'onglet BFR : un cartouche sous la composante qu'il explique
 * (créances clients, dettes fournisseurs), puis, au clic, la distribution des délais de la cohorte —
 * avec les factures encore ouvertes à part — et le détail d'une tranche. Calculs :
 * lib/pastBfrDelais.ts. Aucune donnée n'est écrite ici.
 *
 * Chaque niveau (cartouche, distribution, détail d'une tranche) a son propre seuil de montant : le
 * parent donne la valeur de départ au niveau suivant, un changement dans un enfant ne remonte jamais.
 */

export type MesureDistribution = "nombre" | "montant";

// Clé de la barre des factures encore ouvertes, à côté des tranches de délais réglés.
export const CLE_OUVERTES = "ouvertes";

const TITRES: Record<CoteDelai, string> = { client: "Délai clients", fournisseur: "Délai fournisseurs" };
const TIERS: Record<CoteDelai, string> = { client: "Client", fournisseur: "Fournisseur" };
const QUALIFICATION = "Moyenne pondérée par les montants HT des factures réglées";
const INFOBULLE_DISPERSION = "La dispersion indique si les délais de paiement sont homogènes ou très variables autour de la moyenne.";
const LIBELLES_DISPERSION: Record<NiveauDispersion, string> = { faible: "Dispersion faible", moderee: "Dispersion modérée", forte: "Dispersion forte" };

const jours = (valeur: number) => `${Math.round(valeur)} j`;
const pourcent = (part: number) => `${Math.round(part * 100)} %`;
const enK = (montant: number) => `${formatKiloEuros(montant, Math.abs(montant) < 10_000 ? 1 : 0)} HT`;
// Chaque mot d'une expression prend la marque du pluriel : « 2 factures encore ouvertes ».
const pluriel = (n: number, expression: string) =>
  `${n} ${n > 1 ? expression.split(" ").map((mot) => (mot === "encore" || mot === "sans" ? mot : `${mot}s`)).join(" ") : expression}`;

/**
 * Seuil de montant HT des factures analysées : Toutes, > 1 000 €, > 5 000 €, > 10 000 €, ou un seuil
 * saisi (strictement au-dessus, comme les seuils proposés). Le clic ne se propage pas au cartouche.
 */
export function FiltreMontant({ id, seuil, onSeuil }: { id: string; seuil: number | null; onSeuil: (seuil: number | null) => void }) {
  const proposes: readonly number[] = SEUILS_MONTANT_PROPOSES;
  const [perso, setPerso] = useState(seuil !== null && !proposes.includes(seuil));
  const [saisie, setSaisie] = useState(seuil !== null && !proposes.includes(seuil) ? String(seuil) : "");
  const appliquer = () => {
    const valeur = seuilValide(saisie);
    if (valeur !== null && valeur !== seuil) onSeuil(valeur);
  };
  return (
    <span className="passe-bfr__filtre" onClick={(e) => e.stopPropagation()}>
      <label htmlFor={id}>Factures analysées</label>
      <select
        id={id}
        value={perso ? "perso" : seuil === null ? "toutes" : String(seuil)}
        onChange={(e) => {
          const choix = e.target.value;
          if (choix === "perso") {
            setPerso(true);
            setSaisie(seuil === null ? "" : String(seuil));
            return;
          }
          setPerso(false);
          onSeuil(choix === "toutes" ? null : Number(choix));
        }}
      >
        <option value="toutes">Toutes</option>
        {proposes.map((s) => (
          <option key={s} value={String(s)}>
            {libelleSeuil(s)}
          </option>
        ))}
        <option value="perso">{perso && seuil !== null && !proposes.includes(seuil) ? `${libelleSeuil(seuil)} (personnalisé)` : "Personnalisé…"}</option>
      </select>
      {perso && (
        <span className="passe-bfr__filtre-saisie">
          &gt;
          <input
            type="text"
            inputMode="decimal"
            aria-label="Montant HT au-dessus duquel les factures sont analysées"
            placeholder="7 500"
            value={saisie}
            autoFocus
            onChange={(e) => setSaisie(e.target.value)}
            onBlur={appliquer}
            onKeyDown={(e) => {
              if (e.key === "Enter") appliquer();
            }}
          />
          € HT
        </span>
      )}
    </span>
  );
}

/** Ce que le seuil retient : rien à dire sans seuil ; sinon volume analysé, couverture, factures écartées. */
function Couverture({ cohorte }: { cohorte: DelaisCohorte }) {
  const { filtre } = cohorte;
  if (filtre.seuilHt === null) return null;
  const analyse = cohorte.reglees.reduce((s, f) => s + f.montantHt, 0);
  return (
    <>
      <span className="passe-bfr__delai-note">
        {pluriel(cohorte.reglees.length, "facture réglée")} · {enK(analyse)} analysés
        {filtre.couverture !== null && ` · ${pourcent(filtre.couverture)} des montants réglés de la période`}
      </span>
      {filtre.regleesSousSeuil.nombre > 0 && (
        <span className="passe-bfr__delai-note">
          {pluriel(filtre.regleesSousSeuil.nombre, "facture réglée")} sous le seuil, écartée{filtre.regleesSousSeuil.nombre > 1 ? "s" : ""} ·{" "}
          {enK(filtre.regleesSousSeuil.montant)}
        </span>
      )}
    </>
  );
}

/**
 * Cartouche compact, sous Créances clients HT ou Dettes fournisseurs HT. Ordre de lecture : moyenne,
 * qualification, dispersion, factures ouvertes. Un clic ouvre la distribution.
 */
export function CartoucheDelai({
  cohorte,
  precedente,
  periode,
  periodePrecedente,
  onOuvrir,
  onSeuil,
}: {
  // Cohortes au même seuil : la comparaison ne mélange jamais deux populations.
  cohorte: DelaisCohorte;
  precedente: DelaisCohorte;
  periode: string; // « septembre 2026 », « T3 2026 » : exactement la cohorte affichée
  periodePrecedente: string; // « août 2026 », « T2 2026 »
  onOuvrir: () => void;
  onSeuil: (seuil: number | null) => void;
}) {
  // Un delta par indicateur, à côté de lui : délai vs délai, écart vs écart.
  const comparaison = comparerAvecPrecedente(cohorte, precedente);
  const delta = (valeur: number | null) =>
    valeur === null ? `comparaison avec ${periodePrecedente} indisponible` : `${libelleVariationJours(valeur)} vs ${periodePrecedente}`;
  return (
    // Tout le cartouche ouvre la distribution ; le titre est le bouton accessible au clavier.
    <div className="passe-bfr__delai" onClick={onOuvrir}>
      <button
        type="button"
        className="passe-bfr__delai-titre"
        onClick={(e) => {
          e.stopPropagation();
          onOuvrir();
        }}
        aria-label={`${TITRES[cohorte.cote]} : voir la distribution des délais`}
      >
        {TITRES[cohorte.cote]}
      </button>
      <FiltreMontant id={`passe-bfr-seuil-${cohorte.cote}`} seuil={cohorte.filtre.seuilHt} onSeuil={onSeuil} />
      {cohorte.delaiMoyen === null ? (
        <span>{cohorte.filtre.seuilHt === null ? "Aucune facture réglée sur cette période." : "Aucune facture réglée au-dessus du seuil sur cette période."}</span>
      ) : (
        <>
          <span className="passe-bfr__delai-moyenne">
            <strong>{jours(cohorte.delaiMoyen)}</strong> en moyenne sur {periode}
          </span>
          <span className="passe-bfr__delai-note">{QUALIFICATION}</span>
          <span className="passe-bfr__delai-note">Délai : {delta(comparaison.delai)}</span>
          {cohorte.ecartEcheanceMoyen !== null && (
            <>
              <span>
                {libelleEcartEcheance(cohorte.ecartEcheanceMoyen)}
                {cohorte.sansEcheance > 0 && (
                  <span className="passe-bfr__delai-note"> · sur {pluriel(cohorte.reglees.length - cohorte.sansEcheance, "facture")} avec échéance</span>
                )}
              </span>
              <span className="passe-bfr__delai-note">Écart à l&apos;échéance : {delta(comparaison.ecartEcheance)}</span>
            </>
          )}
          {cohorte.niveauDispersion !== null && cohorte.ecartType !== null ? (
            <span className={`passe-bfr__dispersion passe-bfr__dispersion--${cohorte.niveauDispersion}`} title={INFOBULLE_DISPERSION}>
              {LIBELLES_DISPERSION[cohorte.niveauDispersion]} <span className="passe-bfr__delai-note">· σ {jours(cohorte.ecartType)}</span>
            </span>
          ) : (
            <span className="passe-bfr__delai-note">Seulement {pluriel(cohorte.reglees.length, "facture réglée")} : moyenne peu représentative.</span>
          )}
          {cohorte.trancheDominante && cohorte.reglees.length >= 3 && (
            <span>
              {pourcent(cohorte.trancheDominante.part)} des factures réglées {libelleTrancheDansPhrase(cohorte.trancheDominante.tranche)}
            </span>
          )}
        </>
      )}
      <Couverture cohorte={cohorte} />
      {/* Paiement impossible à dater : hors de la moyenne, dit ici ; le détail est dans la distribution. */}
      {nombreDelaisIncertains(cohorte) > 0 && (
        <span className="passe-bfr__delai-note">{pluriel(nombreDelaisIncertains(cohorte), "facture exclue")} : délai impossible à établir</span>
      )}
      {cohorte.ouvertes.length > 0 && (
        <>
          <span className="passe-bfr__delai-ouvertes">
            {pluriel(cohorte.ouvertes.length, "facture encore ouverte")} · {enK(cohorte.montantOuvertes)}
          </span>
          <span className="passe-bfr__delai-note">Ancienneté moyenne actuelle : {jours(cohorte.ancienneteMoyenneOuvertes as number)}</span>
        </>
      )}
    </div>
  );
}

interface PointTranche {
  cle: string;
  libelle: string;
  valeur: number;
  nombre: number;
  montant: number;
  ouvertes: boolean;
}

function InfoBulleTranche({ active, payload }: { active?: boolean; payload?: { payload: PointTranche }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="passe-structure__infobulle">
      <strong>{p.ouvertes ? "Encore ouvertes (délai en cours)" : `Réglées ${p.libelle}`}</strong>
      <span>{pluriel(p.nombre, "facture")}</span>
      <span>{formatMontant(p.montant)} HT</span>
    </div>
  );
}

export function VueDelais({
  cohorte,
  libellePeriode,
  periode,
  mesure,
  onMesure,
  tranche,
  onTranche,
  onRetour,
  onSeuil,
}: {
  // Cohorte au seuil du niveau affiché : celui de la distribution, ou celui du détail d'une tranche.
  cohorte: DelaisCohorte;
  libellePeriode: string;
  periode: string; // « septembre 2026 », « T3 2026 »
  mesure: MesureDistribution;
  onMesure: (mesure: MesureDistribution) => void;
  tranche: string | null;
  onTranche: (cle: string | null) => void;
  onRetour: () => void;
  onSeuil: (seuil: number | null) => void;
}) {
  const filtre = cohorte.filtre;
  const ecartees = (
    [
      [filtre.regleesSousSeuil, "facture réglée"],
      [filtre.ouvertesSousSeuil, "facture encore ouverte"],
    ] as [Volume, string][]
  )
    .filter(([v]) => v.nombre > 0)
    .map(([v, libelle]) => `${pluriel(v.nombre, libelle)} (${enK(v.montant)})`);
  // Valeurs absolues (nombre de factures, montant HT) : la barre « Encore ouvertes » se compare
  // directement aux tranches réglées, sans entrer dans leurs parts (calculées sur les seules réglées).
  const points: PointTranche[] = [
    ...cohorte.tranches.map((t) => {
      const montant = t.factures.reduce((s, f) => s + f.montantHt, 0);
      return { cle: t.cle, libelle: t.libelle, valeur: mesure === "nombre" ? t.factures.length : montant, nombre: t.factures.length, montant, ouvertes: false };
    }),
    {
      cle: CLE_OUVERTES,
      libelle: "Encore ouvertes",
      valeur: mesure === "nombre" ? cohorte.ouvertes.length : cohorte.montantOuvertes,
      nombre: cohorte.ouvertes.length,
      montant: cohorte.montantOuvertes,
      ouvertes: true,
    },
  ];
  const ouvertesChoisies = tranche === CLE_OUVERTES;
  const choisie = tranche === null || ouvertesChoisies ? null : cohorte.tranches.find((t) => t.cle === tranche) ?? null;
  const exclusions = new Map<RaisonExclusion, number>();
  for (const f of cohorte.exclues) exclusions.set(f.raison, (exclusions.get(f.raison) ?? 0) + 1);
  const formater = (v: unknown) => (typeof v !== "number" || v === 0 ? "" : mesure === "nombre" ? String(v) : formatKiloEuros(v, v < 10_000 ? 1 : 0));

  return (
    <section className="passe-bfr__vue-delais">
      <div className="passe-bfr__barre">
        <button type="button" className="btn-secondaire" onClick={tranche !== null ? () => onTranche(null) : onRetour}>
          {tranche !== null ? "← Distribution" : "← Retour au BFR"}
        </button>
        <span className="passe-message">
          Factures émises {libellePeriode} · {cohorte.statut === "provisoire" ? "provisoire" : "stabilisé"}
        </span>
      </div>
      <p className="eyebrow eyebrow--grand">
        {TITRES[cohorte.cote]}
        {ouvertesChoisies ? " · encore ouvertes" : choisie ? ` · réglées ${choisie.libelle}` : ""}
      </p>
      {cohorte.delaiMoyen !== null && (
        <p className="passe-kpi__montant">
          {jours(cohorte.delaiMoyen)} <span className="passe-kpi__contexte">en moyenne sur {periode}</span>
        </p>
      )}
      <p className="passe-kpi__ratio">
        {QUALIFICATION}
        {cohorte.ecartEcheanceMoyen !== null && ` · ${libelleEcartEcheance(cohorte.ecartEcheanceMoyen)}`}
        {cohorte.niveauDispersion !== null && cohorte.ecartType !== null && (
          <>
            {" · "}
            <span className={`passe-bfr__dispersion passe-bfr__dispersion--${cohorte.niveauDispersion}`} title={INFOBULLE_DISPERSION}>
              {LIBELLES_DISPERSION[cohorte.niveauDispersion]} · σ {jours(cohorte.ecartType)}
            </span>
          </>
        )}
      </p>
      {cohorte.reglees.length > 0 && !cohorte.representatif && (
        <p className="passe-reserve">Seulement {pluriel(cohorte.reglees.length, "facture réglée")} sur cette période : moyenne peu représentative, dispersion non qualifiée.</p>
      )}
      {/* Clé distincte par niveau : le détail repart du seuil hérité, sans la saisie de la distribution. */}
      <div className="passe-bfr__filtre-ligne">
        <FiltreMontant key={tranche === null ? "distribution" : "detail"} id="passe-bfr-seuil-vue" seuil={filtre.seuilHt} onSeuil={onSeuil} />
        {filtre.seuilHt !== null && (
          <span className="passe-message">
            {pluriel(cohorte.reglees.length, "facture réglée")} · {enK(cohorte.reglees.reduce((s, f) => s + f.montantHt, 0))} analysés
            {filtre.couverture !== null && ` · ${pourcent(filtre.couverture)} des montants réglés de la période`}
            {ecartees.length > 0 && ` · sous le seuil, écartées : ${ecartees.join(" et ")}`}
          </span>
        )}
      </div>

      {tranche === null ? (
        <>
          <div className="selecteur" role="group" aria-label="Lecture de la distribution">
            {(
              [
                ["nombre", "Nombre de factures"],
                ["montant", "Montants HT"],
              ] as [MesureDistribution, string][]
            ).map(([cle, libelle]) => (
              <button key={cle} type="button" className={`btn-secondaire${mesure === cle ? " btn-module--actif" : ""}`} aria-pressed={mesure === cle} onClick={() => onMesure(cle)}>
                {libelle}
              </button>
            ))}
          </div>
          {cohorte.reglees.length + cohorte.ouvertes.length === 0 ? (
            <p className="passe-structure__vide">
              {filtre.seuilHt === null ? "Aucune facture émise sur cette période." : "Aucune facture au-dessus du seuil sur cette période."}
            </p>
          ) : (
            <div style={{ fontFamily: "var(--font-lexend), sans-serif", cursor: "pointer" }}>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart
                  data={points}
                  margin={{ top: 20, right: 8, left: 0, bottom: 0 }}
                  onClick={(etat) => {
                    const point = points.find((p) => p.libelle === etat?.activeLabel);
                    if (point && point.nombre > 0) onTranche(point.cle);
                  }}
                >
                  <defs>
                    {/* Hachures : population différente — délais encore en cours, pas des délais réglés. */}
                    <pattern id="passe-bfr-hachures" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                      <rect width="6" height="6" fill={NEUTRES.bordure} />
                      <line x1="0" y1="0" x2="0" y2="6" stroke={NEUTRES.secondaire} strokeWidth="2" />
                    </pattern>
                  </defs>
                  <CartesianGrid vertical={false} stroke={NEUTRES.bordure} />
                  <XAxis dataKey="libelle" fontSize={11} tick={{ fill: NEUTRES.secondaire }} axisLine={false} tickLine={false} />
                  <YAxis
                    tickFormatter={(v: number) => (mesure === "nombre" ? String(v) : formatKiloEuros(v, 0))}
                    allowDecimals={false}
                    width={56}
                    fontSize={11}
                    tick={{ fill: NEUTRES.secondaire }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip content={<InfoBulleTranche />} cursor={{ fill: NEUTRES.bordure, fillOpacity: 0.5 }} />
                  <Bar dataKey="valeur" radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false}>
                    {points.map((p) => (
                      <Cell key={p.cle} fill={p.ouvertes ? "url(#passe-bfr-hachures)" : TEINTE_SERIE_PRINCIPALE} stroke={p.ouvertes ? NEUTRES.secondaire : undefined} />
                    ))}
                    <LabelList dataKey="valeur" position="top" formatter={formater} fontSize={10} fill={NEUTRES.encre} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <table className="passe-table passe-bfr__tranches">
            <thead>
              <tr>
                <th>Délai réel</th>
                <th className="col-montant">Factures</th>
                <th className="col-montant">Montant HT</th>
                <th className="col-montant" title="Part des factures réglées">
                  Part des factures
                </th>
                <th className="col-montant" title="Part des montants HT réglés">
                  Part des montants
                </th>
              </tr>
            </thead>
            <tbody>
              {cohorte.tranches.map((t) => (
                <tr key={t.cle}>
                  <td>
                    {t.factures.length > 0 ? (
                      <button type="button" className="passe-lien-ligne" onClick={() => onTranche(t.cle)}>
                        {t.libelle}
                      </button>
                    ) : (
                      t.libelle
                    )}
                  </td>
                  <td className="col-montant passe-table__montant">{t.factures.length}</td>
                  <td className="col-montant passe-table__montant">{formatMontant(t.factures.reduce((s, f) => s + f.montantHt, 0))}</td>
                  <td className="col-montant passe-table__montant">{pourcent(t.partNombre)}</td>
                  <td className="col-montant passe-table__montant">{pourcent(t.partMontant)}</td>
                </tr>
              ))}
              <tr className="passe-bfr__ligne-ouvertes">
                <td>
                  {cohorte.ouvertes.length > 0 ? (
                    <button type="button" className="passe-lien-ligne" onClick={() => onTranche(CLE_OUVERTES)}>
                      Encore ouvertes
                    </button>
                  ) : (
                    "Encore ouvertes"
                  )}
                </td>
                <td className="col-montant passe-table__montant">{cohorte.ouvertes.length}</td>
                <td className="col-montant passe-table__montant">{formatMontant(cohorte.montantOuvertes)}</td>
                <td className="col-montant passe-table__montant" colSpan={2}>
                  délai en cours, hors parts et moyenne
                </td>
              </tr>
            </tbody>
          </table>
          <p className="passe-message">
            {cohorte.dispersion
              ? `${Math.round(cohorte.dispersion.part * 100)} % des factures réglées l'ont été entre ${cohorte.dispersion.min} et ${cohorte.dispersion.max} jours (10e et 90e centiles).`
              : `Pas assez de factures réglées pour un intervalle de dispersion (il en faut au moins ${SEUIL_DISPERSION}).`}
          </p>
          {cohorte.ouvertes.length > 0 && (
            <p className="passe-message">
              Ancienneté moyenne actuelle des factures ouvertes : {jours(cohorte.ancienneteMoyenneOuvertes as number)} — une durée encore en cours, pas un délai
              de paiement.
            </p>
          )}
          {cohorte.sansEcheance > 0 && <p className="passe-message">{pluriel(cohorte.sansEcheance, "facture réglée")} sans échéance : hors écart à l&apos;échéance.</p>}
          {exclusions.size > 0 && (
            <div className="passe-bfr__incertaines">
              <p className="passe-message">{pluriel(cohorte.exclues.length, "facture exclue")} du calcul — délai impossible à établir :</p>
              <ul className="passe-message">
                {[...exclusions].map(([raison, nombre]) => (
                  <li key={raison}>
                    {LIBELLES_EXCLUSION[raison]} : {nombre}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : ouvertesChoisies && cohorte.ouvertes.length === 0 ? (
        <p className="passe-structure__vide">Aucune facture encore ouverte au-dessus du seuil.</p>
      ) : ouvertesChoisies ? (
        <div className="passe-detail__table">
          <table className="passe-table">
            <thead>
              <tr>
                <th>{TIERS[cohorte.cote]}</th>
                <th>N° de facture</th>
                <th className="col-montant">Montant HT</th>
                <th>Émission</th>
                <th>Échéance</th>
                <th>Paiement</th>
                <th className="col-montant">Ancienneté actuelle</th>
                <th className="col-montant">Par rapport à l&apos;échéance</th>
              </tr>
            </thead>
            <tbody>
              {[...cohorte.ouvertes]
                .sort((a, b) => b.anciennete - a.anciennete)
                .map((f) => (
                  <tr key={f.pennylaneId}>
                    <td className="passe-table__libelle">{f.tiers}</td>
                    <td>{f.numero}</td>
                    <td className="col-montant passe-table__montant">{formatMontant(f.montantHt)}</td>
                    <td className="passe-table__date">{formatDateCourte(f.dateEmission)}</td>
                    <td className="passe-table__date">{f.echeance ? formatDateCourte(f.echeance) : "—"}</td>
                    <td className="passe-table__date">—</td>
                    <td className="col-montant passe-table__montant">{jours(f.anciennete)}</td>
                    <td className="col-montant passe-table__montant">{f.retardEcheance === null ? "—" : libelleRetardOuverte(f.retardEcheance)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="passe-message">Factures non soldées : ancienneté et retard calculés à ce jour. Tri par ancienneté décroissante.</p>
        </div>
      ) : choisie && choisie.factures.length === 0 ? (
        <p className="passe-structure__vide">Aucune facture réglée {choisie.libelle} au-dessus du seuil.</p>
      ) : (
        choisie && (
          <div className="passe-detail__table">
            <table className="passe-table">
              <thead>
                <tr>
                  <th>{TIERS[cohorte.cote]}</th>
                  <th>N° de facture</th>
                  <th className="col-montant">Montant HT</th>
                  <th>Émission</th>
                  <th>Échéance</th>
                  <th>Paiement</th>
                  <th className="col-montant">Délai réel</th>
                  <th className="col-montant" title="+ : payée après l'échéance · − : payée avant l'échéance">
                    Écart à l&apos;échéance
                  </th>
                </tr>
              </thead>
              <tbody>
                {choisie.factures.map((f) => (
                  <tr key={f.pennylaneId}>
                    <td className="passe-table__libelle">{f.tiers}</td>
                    <td>{f.numero}</td>
                    <td className="col-montant passe-table__montant">{formatMontant(f.montantHt)}</td>
                    <td className="passe-table__date">{formatDateCourte(f.dateEmission)}</td>
                    <td className="passe-table__date">{f.echeance ? formatDateCourte(f.echeance) : "—"}</td>
                    <td className="passe-table__date">{formatDateCourte(f.dateReglement)}</td>
                    <td className="col-montant passe-table__montant">{jours(f.delai)}</td>
                    <td className="col-montant passe-table__montant" title={f.ecartEcheance === null ? "Pas d'échéance" : libelleEcartEcheance(f.ecartEcheance)}>
                      {f.ecartEcheance === null ? "—" : `${f.ecartEcheance > 0 ? "+" : f.ecartEcheance < 0 ? "−" : ""}${Math.abs(f.ecartEcheance)} j`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="passe-message">+ : payée après l&apos;échéance · − : payée avant l&apos;échéance. Tri par délai réel décroissant.</p>
          </div>
        )
      )}
    </section>
  );
}
