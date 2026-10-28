"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatDateCourte } from "@/lib/dates";
import { formatMontant } from "@/lib/format";
import { NEUTRES, TEINTE_SERIE_PRINCIPALE } from "@/lib/dataviz";
import {
  CoteDelai,
  DelaisCohorte,
  LIBELLES_EXCLUSION,
  libelleEcartEcheance,
  libelleVariationJours,
  RaisonExclusion,
  SEUIL_DISPERSION,
} from "@/lib/pastBfrDelais";

/*
 * Délai clients / délai fournisseurs de l'onglet BFR : deux indicateurs dans la synthèse, puis, au
 * clic, la distribution des délais de la cohorte et le détail d'une tranche. Calculs :
 * lib/pastBfrDelais.ts. Aucune donnée n'est écrite ici.
 */

export type MesureDistribution = "nombre" | "montant";

const TITRES: Record<CoteDelai, string> = { client: "Délai clients", fournisseur: "Délai fournisseurs" };
const TIERS: Record<CoteDelai, string> = { client: "Client", fournisseur: "Fournisseur" };
const INFOBULLE = "Délai moyen de règlement, pondéré par le montant HT des factures émises sur la période.";

const jours = (valeur: number) => `${Math.round(valeur)} j`;
const pourcent = (part: number) => `${Math.round(part * 100)} %`;
// Chaque mot d'une expression prend la marque du pluriel : « 2 factures encore ouvertes ».
const pluriel = (n: number, expression: string) => `${n} ${n > 1 ? expression.split(" ").map((mot) => (mot === "encore" || mot === "sans" ? mot : `${mot}s`)).join(" ") : expression}`;

function KpiDelai({ cohorte, precedente, onOuvrir }: { cohorte: DelaisCohorte; precedente: DelaisCohorte | null; onOuvrir: () => void }) {
  const variation = cohorte.delaiMoyen !== null && precedente?.delaiMoyen != null ? cohorte.delaiMoyen - precedente.delaiMoyen : null;
  return (
    <button type="button" className="passe-bfr__delai" onClick={onOuvrir} title={INFOBULLE}>
      <span className="passe-bfr__delai-titre">{TITRES[cohorte.cote]}</span>
      <strong>{cohorte.delaiMoyen === null ? "—" : jours(cohorte.delaiMoyen)}</strong>
      {variation !== null && <span>{libelleVariationJours(variation)} vs période précédente</span>}
      {cohorte.ecartEcheanceMoyen !== null && <span>{libelleEcartEcheance(cohorte.ecartEcheanceMoyen)}</span>}
      {cohorte.reglees.length === 0 ? (
        <span>Aucune facture réglée sur cette période.</span>
      ) : (
        !cohorte.representatif && <span>Seulement {pluriel(cohorte.reglees.length, "facture réglée")} sur cette période.</span>
      )}
      {cohorte.ouvertes.length > 0 && (
        <span>
          {pluriel(cohorte.ouvertes.length, "facture encore ouverte")} · ancienneté moyenne {jours(cohorte.ancienneteMoyenneOuvertes as number)}
        </span>
      )}
      <span className={`passe-statut passe-bfr__statut passe-bfr__statut--${cohorte.statut === "provisoire" ? "provisoire" : "validee"}`}>
        {cohorte.statut === "provisoire" ? "Provisoire" : "Stabilisé"}
      </span>
    </button>
  );
}

export function KpisDelais({
  clients,
  fournisseurs,
  clientsPrecedents,
  fournisseursPrecedents,
  libellePeriode,
  onOuvrir,
}: {
  clients: DelaisCohorte;
  fournisseurs: DelaisCohorte;
  clientsPrecedents: DelaisCohorte | null;
  fournisseursPrecedents: DelaisCohorte | null;
  libellePeriode: string;
  onOuvrir: (cote: CoteDelai) => void;
}) {
  return (
    <section className="passe-bfr__delais" aria-label="Délais de paiement">
      <p className="passe-message">Délais réels de paiement des factures émises {libellePeriode}</p>
      <div className="passe-bfr__delais-cartes">
        <KpiDelai cohorte={clients} precedente={clientsPrecedents} onOuvrir={() => onOuvrir("client")} />
        <KpiDelai cohorte={fournisseurs} precedente={fournisseursPrecedents} onOuvrir={() => onOuvrir("fournisseur")} />
      </div>
    </section>
  );
}

interface PointTranche {
  cle: string;
  libelle: string;
  valeur: number;
  nombre: number;
  montant: number;
}

function InfoBulleTranche({ active, payload }: { active?: boolean; payload?: { payload: PointTranche }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="passe-structure__infobulle">
      <strong>{p.libelle}</strong>
      <span>{pluriel(p.nombre, "facture")}</span>
      <span>{formatMontant(p.montant)} HT</span>
    </div>
  );
}

export function VueDelais({
  cohorte,
  libellePeriode,
  mesure,
  onMesure,
  tranche,
  onTranche,
  onRetour,
}: {
  cohorte: DelaisCohorte;
  libellePeriode: string;
  mesure: MesureDistribution;
  onMesure: (mesure: MesureDistribution) => void;
  tranche: string | null;
  onTranche: (cle: string | null) => void;
  onRetour: () => void;
}) {
  const points: PointTranche[] = cohorte.tranches.map((t) => ({
    cle: t.cle,
    libelle: t.libelle,
    valeur: mesure === "nombre" ? t.partNombre : t.partMontant,
    nombre: t.factures.length,
    montant: t.factures.reduce((s, f) => s + f.montantHt, 0),
  }));
  const choisie = tranche === null ? null : cohorte.tranches.find((t) => t.cle === tranche) ?? null;
  const exclusions = new Map<RaisonExclusion, number>();
  for (const f of cohorte.exclues) exclusions.set(f.raison, (exclusions.get(f.raison) ?? 0) + 1);

  return (
    <section className="passe-bfr__vue-delais">
      <div className="passe-bfr__barre">
        <button type="button" className="btn-secondaire" onClick={choisie ? () => onTranche(null) : onRetour}>
          {choisie ? "← Distribution" : "← Retour au BFR"}
        </button>
        <span className="passe-message">
          Factures émises {libellePeriode} · {cohorte.statut === "provisoire" ? "provisoire" : "stabilisé"}
        </span>
      </div>
      <p className="eyebrow eyebrow--grand">
        {TITRES[cohorte.cote]}
        {choisie ? ` · ${choisie.libelle}` : ""}
      </p>
      <p className="passe-kpi__montant">{cohorte.delaiMoyen === null ? "—" : jours(cohorte.delaiMoyen)}</p>
      <p className="passe-kpi__ratio">
        {INFOBULLE}
        {cohorte.ecartEcheanceMoyen !== null && ` En moyenne ${libelleEcartEcheance(cohorte.ecartEcheanceMoyen)}.`}
      </p>

      {choisie === null ? (
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
          {cohorte.reglees.length === 0 ? (
            <p className="passe-structure__vide">Aucune facture réglée sur cette période : pas de distribution des délais.</p>
          ) : (
            <div style={{ fontFamily: "var(--font-lexend), sans-serif", cursor: "pointer" }}>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart
                  data={points}
                  margin={{ top: 20, right: 8, left: 0, bottom: 0 }}
                  onClick={(etat) => {
                    const cle = points.find((p) => p.libelle === etat?.activeLabel)?.cle;
                    if (cle && points.find((p) => p.cle === cle)!.nombre > 0) onTranche(cle);
                  }}
                >
                  <CartesianGrid vertical={false} stroke={NEUTRES.bordure} />
                  <XAxis dataKey="libelle" fontSize={11} tick={{ fill: NEUTRES.secondaire }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={(v: number) => pourcent(v)} domain={[0, 1]} width={48} fontSize={11} tick={{ fill: NEUTRES.secondaire }} axisLine={false} tickLine={false} />
                  <Tooltip content={<InfoBulleTranche />} cursor={{ fill: NEUTRES.bordure, fillOpacity: 0.5 }} />
                  <Bar dataKey="valeur" radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false}>
                    {points.map((p) => (
                      <Cell key={p.cle} fill={TEINTE_SERIE_PRINCIPALE} />
                    ))}
                    <LabelList dataKey="valeur" position="top" formatter={(v: unknown) => (typeof v === "number" && v > 0 ? pourcent(v) : "")} fontSize={10} fill={NEUTRES.encre} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <table className="passe-table passe-bfr__tranches">
            <thead>
              <tr>
                <th>Délai réel</th>
                <th className="col-montant">Part des factures</th>
                <th className="col-montant">Part des montants HT</th>
                <th className="col-montant">Factures</th>
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
                  <td className="col-montant passe-table__montant">{pourcent(t.partNombre)}</td>
                  <td className="col-montant passe-table__montant">{pourcent(t.partMontant)}</td>
                  <td className="col-montant passe-table__montant">{t.factures.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="passe-message">
            {cohorte.dispersion
              ? `${Math.round(cohorte.dispersion.part * 100)} % des factures sont payées entre ${cohorte.dispersion.min} et ${cohorte.dispersion.max} jours (10e et 90e centiles).`
              : `Pas assez de factures pour mesurer la dispersion (il en faut au moins ${SEUIL_DISPERSION} réglées).`}
          </p>
          {cohorte.ouvertes.length > 0 && (
            <p className="passe-message">
              {pluriel(cohorte.ouvertes.length, "facture encore ouverte")}, hors distribution · ancienneté moyenne actuelle{" "}
              {jours(cohorte.ancienneteMoyenneOuvertes as number)} (indicateur provisoire, pas un délai de paiement).
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
      ) : (
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
      )}
    </section>
  );
}
