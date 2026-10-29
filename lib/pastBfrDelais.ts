import { FactureBfr, TypeFactureBfr } from "./pastBfr";
import { SEUIL_COUVERTURE_REGLEMENT } from "./pennylaneInvoiceAdapter";

/**
 * Délai clients / délai fournisseurs de l'onglet BFR — fonctions pures, sur les mêmes faits Pennylane
 * que le BFR (past_bfr_invoices). Ce ne sont pas des DSO / DPO comptables : on mesure le délai
 * RÉEL de paiement des factures.
 *
 *  - Cohorte : les factures ÉMISES sur la période (date d'émission), quelle que soit la date de leur
 *    règlement — une facture de septembre payée en novembre reste dans septembre.
 *  - Facture réglée : soldée aujourd'hui chez Pennylane (règle du projet : reste dû nul ; côté
 *    fournisseurs, couverte à SEUIL_COUVERTURE_REGLEMENT comme pour la synchronisation des
 *    factures). Sa date de règlement est celle de sa DERNIÈRE transaction bancaire rapprochée : la
 *    date où son solde est apuré. Jamais l'échéance, jamais une date prévue, jamais un statut seul.
 *  - Délai réel = date de règlement − date d'émission, en jours calendaires.
 *  - Moyenne pondérée par le montant HT de la facture ; écart à l'échéance de même.
 *  - Une facture encore ouverte n'entre jamais dans la moyenne : elle a son ancienneté, à part.
 *  - Une facture dont le délai ne peut pas être établi (pas de date de règlement, règlement avant
 *    émission, montant HT absent, facture annulée ou remplacée) est exclue ET comptée, avec sa raison.
 *
 * Avoirs, brouillons, devis : ce ne sont pas des factures émises, ils n'entrent pas dans la cohorte.
 */

export type CoteDelai = TypeFactureBfr;

export const SEUIL_REPRESENTATIF = 3; // en dessous, la moyenne est affichée mais signalée
export const SEUIL_DISPERSION = 10; // en dessous, pas d'intervalle de dispersion (10e–90e centiles)

/**
 * Niveau de dispersion des délais réglés, lu sur le coefficient de variation : écart-type pondéré
 * HT / moyenne pondérée HT — relatif à la moyenne, pour qu'un écart-type de 20 j ne se lise pas pareil
 * autour de 15 j et autour de 90 j. Seuils (documentés, à revoir sur données réelles) :
 *   ≤ 0,25 faible · ≤ 0,50 modérée · au-delà forte.
 * Repères : 100 % à 45 j -> 0 (faible) ; moitié à 30 j, moitié à 60 j -> 0,33 (modérée) ;
 * moitié à 5 j, moitié à 85 j -> 0,89 (forte).
 * Au moins SEUIL_REPRESENTATIF factures réglées, sinon pas de niveau.
 */
export const SEUILS_DISPERSION = { faible: 0.25, moderee: 0.5 } as const;
export type NiveauDispersion = "faible" | "moderee" | "forte";

export type RaisonExclusion =
  | "annulee"
  | "remplacee"
  | "sans_date_reglement"
  | "reglements_non_recuperes"
  | "reglement_avant_emission"
  | "montant_ht_absent";

export const LIBELLES_EXCLUSION: Record<RaisonExclusion, string> = {
  annulee: "Facture annulée",
  remplacee: "Version remplacée (archivée chez Pennylane)",
  sans_date_reglement: "Réglée sans transaction bancaire rapprochée : date de règlement inconnue",
  reglements_non_recuperes: "Règlements pas encore récupérés de Pennylane",
  reglement_avant_emission: "Règlement antérieur à l'émission : anomalie de données",
  montant_ht_absent: "Montant HT absent ou nul",
};

interface FactureCohorte {
  pennylaneId: string;
  numero: string;
  tiers: string;
  montantHt: number;
  dateEmission: string;
  echeance: string | null;
}

export interface FactureReglee extends FactureCohorte {
  dateReglement: string;
  delai: number; // jours, ≥ 0
  ecartEcheance: number | null; // règlement − échéance : + après, − avant ; null sans échéance
}

export interface FactureOuverte extends FactureCohorte {
  anciennete: number; // jours depuis l'émission, à la date de référence
  // Date de référence − échéance : + en retard, − pas encore échue ; null sans échéance.
  retardEcheance: number | null;
}

export interface FactureExclue extends Omit<FactureCohorte, "montantHt"> {
  montantHt: number | null;
  raison: RaisonExclusion;
}

export interface TrancheDelai {
  cle: string;
  libelle: string;
  min: number;
  max: number | null; // null : sans borne haute
  factures: FactureReglee[];
  partNombre: number; // 0..1
  partMontant: number; // 0..1
}

export const BORNES_TRANCHES: readonly { min: number; max: number | null }[] = [
  { min: 0, max: 15 },
  { min: 16, max: 30 },
  { min: 31, max: 45 },
  { min: 46, max: 60 },
  { min: 61, max: 90 },
  { min: 91, max: null },
];

export interface Dispersion {
  part: number; // 0,8 : 80 % des factures
  min: number; // P10
  max: number; // P90
}

export interface DelaisCohorte {
  cote: CoteDelai;
  reglees: FactureReglee[];
  ouvertes: FactureOuverte[];
  exclues: FactureExclue[];
  delaiMoyen: number | null; // pondéré HT, null sans facture réglée
  ecartEcheanceMoyen: number | null; // pondéré HT, sur les factures réglées qui ont une échéance
  sansEcheance: number; // factures réglées sans échéance (exclues de l'écart seulement)
  ancienneteMoyenneOuvertes: number | null; // pondérée HT
  montantOuvertes: number; // total HT des factures encore ouvertes
  // Écart-type pondéré HT des délais réglés, et son niveau relatif à la moyenne (voir SEUILS_DISPERSION).
  ecartType: number | null;
  niveauDispersion: NiveauDispersion | null;
  // Tranche qui regroupe le plus de factures réglées, et sa part (lecture « 67 % en ≤ 15 j »).
  trancheDominante: { tranche: TrancheDelai; part: number } | null;
  tranches: TrancheDelai[];
  dispersion: Dispersion | null; // null sous SEUIL_DISPERSION factures réglées
  representatif: boolean; // au moins SEUIL_REPRESENTATIF factures réglées
  // Provisoire : des factures de la cohorte sont encore ouvertes, ou leurs règlements pas encore
  // récupérés — la moyenne peut encore bouger. Stabilisé sinon.
  statut: "provisoire" | "stabilise";
}

const MS_JOUR = 86_400_000;

/** Jours calendaires entre deux dates YYYY-MM-DD (b − a), sans effet d'heure d'été. */
export function joursEntre(a: string, b: string): number {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / MS_JOUR);
}

const EPSILON = 0.01;

/** Facture soldée aujourd'hui chez Pennylane, avoirs déduits — mêmes seuils que la synchronisation. */
function estSoldee(f: FactureBfr, avoirsTtc: number): boolean {
  const du = f.montantTtc - avoirsTtc;
  if (f.resteTtc <= EPSILON) return true;
  return f.type === "fournisseur" && du > 0 && du - f.resteTtc >= SEUIL_COUVERTURE_REGLEMENT * du;
}

const moyennePonderee = (lignes: { poids: number; valeur: number }[]): number | null => {
  const poids = lignes.reduce((s, l) => s + l.poids, 0);
  return poids > 0 ? lignes.reduce((s, l) => s + l.poids * l.valeur, 0) / poids : null;
};

/** Rang le plus proche : la valeur au rang ceil(p·n) des délais triés. Stable, sans interpolation. */
function percentile(trie: number[], p: number): number {
  return trie[Math.min(trie.length, Math.max(1, Math.ceil(p * trie.length))) - 1];
}

export interface PeriodeDelai {
  debut: string; // YYYY-MM-DD inclus
  fin: string; // YYYY-MM-DD inclus
}

export function delaisDeLaCohorte(factures: FactureBfr[], cote: CoteDelai, periode: PeriodeDelai, aujourdhui: string): DelaisCohorte {
  const avoirsTtc = new Map<string, number>();
  for (const f of factures) {
    if (f.exclusion === "avoir" && f.factureAvoireeId !== null && f.type === cote) {
      avoirsTtc.set(f.factureAvoireeId, (avoirsTtc.get(f.factureAvoireeId) ?? 0) + f.montantTtc);
    }
  }

  const reglees: FactureReglee[] = [];
  const ouvertes: FactureOuverte[] = [];
  const exclues: FactureExclue[] = [];
  for (const f of factures) {
    if (f.type !== cote || f.dateEmission === null || f.dateEmission < periode.debut || f.dateEmission > periode.fin) continue;
    if (f.exclusion === "avoir" || f.exclusion === "brouillon" || f.exclusion === "hors_facture") continue;
    const base = { pennylaneId: f.pennylaneId, numero: f.numero, tiers: f.tiers, dateEmission: f.dateEmission, echeance: f.echeance };
    const exclure = (raison: RaisonExclusion) => exclues.push({ ...base, montantHt: f.montantHt, raison });

    if (f.exclusion === "annulee") {
      exclure("annulee");
      continue;
    }
    if (f.exclusion === "archivee") {
      exclure("remplacee");
      continue;
    }
    const avoirs = avoirsTtc.get(f.pennylaneId) ?? 0;
    if (avoirs >= f.montantTtc - EPSILON) {
      exclure("annulee"); // entièrement annulée par avoir : jamais payée, pas de délai
      continue;
    }
    if (f.montantHt === null || f.montantHt <= 0) {
      exclure("montant_ht_absent");
      continue;
    }
    if (!estSoldee(f, avoirs)) {
      ouvertes.push({
        ...base,
        montantHt: f.montantHt,
        anciennete: Math.max(0, joursEntre(f.dateEmission, aujourdhui)),
        retardEcheance: f.echeance ? joursEntre(f.echeance, aujourdhui) : null,
      });
      continue;
    }
    if (f.reglements === null) {
      exclure("reglements_non_recuperes");
      continue;
    }
    if (f.reglements.length === 0) {
      exclure("sans_date_reglement");
      continue;
    }
    const dateReglement = f.reglements.reduce((max, r) => (r.date > max ? r.date : max), f.reglements[0].date);
    const delai = joursEntre(f.dateEmission, dateReglement);
    if (delai < 0) {
      exclure("reglement_avant_emission");
      continue;
    }
    reglees.push({ ...base, montantHt: f.montantHt, dateReglement, delai, ecartEcheance: f.echeance ? joursEntre(f.echeance, dateReglement) : null });
  }

  const totalNombre = reglees.length;
  const totalMontant = reglees.reduce((s, f) => s + f.montantHt, 0);
  const tranches = BORNES_TRANCHES.map(({ min, max }) => {
    const dedans = reglees.filter((f) => f.delai >= min && (max === null || f.delai <= max)).sort((a, b) => b.delai - a.delai);
    return {
      cle: max === null ? `${min}+` : `${min}-${max}`,
      libelle: max === null ? `+${min - 1} j` : `${min}–${max} j`,
      min,
      max,
      factures: dedans,
      partNombre: totalNombre > 0 ? dedans.length / totalNombre : 0,
      partMontant: totalMontant > 0 ? dedans.reduce((s, f) => s + f.montantHt, 0) / totalMontant : 0,
    };
  });

  const delaisTries = reglees.map((f) => f.delai).sort((a, b) => a - b);
  const avecEcheance = reglees.filter((f) => f.ecartEcheance !== null);
  const delaiMoyen = moyennePonderee(reglees.map((f) => ({ poids: f.montantHt, valeur: f.delai })));
  // Écart-type pondéré HT (population) : √(Σ w·(x − μ)² / Σ w). Factures ouvertes jamais comprises.
  const ecartType =
    delaiMoyen === null ? null : Math.sqrt(moyennePonderee(reglees.map((f) => ({ poids: f.montantHt, valeur: (f.delai - delaiMoyen) ** 2 }))) as number);
  const dominante = tranches.reduce<TrancheDelai | null>((max, t) => (t.factures.length > (max?.factures.length ?? 0) ? t : max), null);
  return {
    cote,
    reglees,
    ouvertes,
    exclues,
    delaiMoyen,
    ecartEcheanceMoyen: moyennePonderee(avecEcheance.map((f) => ({ poids: f.montantHt, valeur: f.ecartEcheance as number }))),
    sansEcheance: reglees.length - avecEcheance.length,
    ancienneteMoyenneOuvertes: moyennePonderee(ouvertes.map((f) => ({ poids: f.montantHt, valeur: f.anciennete }))),
    montantOuvertes: ouvertes.reduce((s, f) => s + f.montantHt, 0),
    ecartType,
    niveauDispersion: reglees.length >= SEUIL_REPRESENTATIF && delaiMoyen !== null && ecartType !== null ? niveauDeDispersion(delaiMoyen, ecartType) : null,
    trancheDominante: dominante ? { tranche: dominante, part: dominante.partNombre } : null,
    tranches,
    dispersion:
      delaisTries.length >= SEUIL_DISPERSION ? { part: 0.8, min: percentile(delaisTries, 0.1), max: percentile(delaisTries, 0.9) } : null,
    representatif: reglees.length >= SEUIL_REPRESENTATIF,
    statut: ouvertes.length > 0 || exclues.some((f) => f.raison === "reglements_non_recuperes") ? "provisoire" : "stabilise",
  };
}

/**
 * Évolution de CHAQUE indicateur par rapport à la période précédente comparable (mois civil
 * précédent, ou trimestre précédent) : la même métrique des deux côtés, jamais le délai d'une période
 * contre l'écart à l'échéance de l'autre.
 *   délai :  délai moyen actuel − délai moyen précédent ;
 *   écart :  écart moyen à l'échéance actuel − écart moyen précédent.
 * Les deux bougent différemment dès que les conditions de paiement (échéance − émission) changent
 * d'une cohorte à l'autre : écart = délai − terme moyen, à pondération égale.
 * null quand la période précédente n'a pas au moins SEUIL_REPRESENTATIF factures réglées (avec
 * échéance, pour l'écart) : pas de delta trompeur.
 */
export interface ComparaisonDelais {
  delai: number | null;
  ecartEcheance: number | null;
}

export function comparerAvecPrecedente(actuelle: DelaisCohorte, precedente: DelaisCohorte): ComparaisonDelais {
  const avecEcheance = (c: DelaisCohorte) => c.reglees.length - c.sansEcheance;
  return {
    delai:
      actuelle.delaiMoyen !== null && precedente.delaiMoyen !== null && precedente.reglees.length >= SEUIL_REPRESENTATIF
        ? actuelle.delaiMoyen - precedente.delaiMoyen
        : null,
    ecartEcheance:
      actuelle.ecartEcheanceMoyen !== null && precedente.ecartEcheanceMoyen !== null && avecEcheance(precedente) >= SEUIL_REPRESENTATIF
        ? actuelle.ecartEcheanceMoyen - precedente.ecartEcheanceMoyen
        : null,
  };
}

/** Niveau de dispersion d'après le coefficient de variation σ / μ ; moyenne nulle : faible si σ nul. */
export function niveauDeDispersion(moyenne: number, ecartType: number): NiveauDispersion {
  if (moyenne <= 0) return ecartType === 0 ? "faible" : "forte";
  const cv = ecartType / moyenne;
  return cv <= SEUILS_DISPERSION.faible ? "faible" : cv <= SEUILS_DISPERSION.moderee ? "moderee" : "forte";
}

/** « en ≤ 15 j », « entre 31 et 45 j », « en plus de 90 j » : lecture d'une tranche. */
export function libelleTrancheDansPhrase(t: { min: number; max: number | null }): string {
  if (t.max === null) return `en plus de ${t.min - 1} j`;
  return t.min === 0 ? `en ≤ ${t.max} j` : `entre ${t.min} et ${t.max} j`;
}

/** « +42 j de retard », « échéance dans 12 j », « échue aujourd'hui ». */
export function libelleRetardOuverte(retard: number): string {
  if (retard > 0) return `+${retard} j de retard`;
  return retard === 0 ? "échue aujourd'hui" : `échéance dans ${-retard} j`;
}

/** « +8 j après échéance », « 6 j avant échéance », « à l'échéance ». */
export function libelleEcartEcheance(jours: number): string {
  const arrondi = Math.round(jours);
  if (arrondi === 0) return "à l'échéance";
  return arrondi > 0 ? `+${arrondi} j après échéance` : `${-arrondi} j avant échéance`;
}

/** « +4 j », « −2 j », « 0 j » : variation d'un délai moyen. */
export function libelleVariationJours(jours: number): string {
  const arrondi = Math.round(jours);
  return arrondi > 0 ? `+${arrondi} j` : arrondi < 0 ? `−${-arrondi} j` : "0 j";
}
