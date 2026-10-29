import { formatDateCourte } from "./dates";
import { libelleMois } from "./pastDetail";

/**
 * BFR historique du module "Passé" — fonctions pures, sans réseau ni base.
 *
 *   BFR HT = Créances clients HT + Stocks HT − Dettes fournisseurs HT, à une date de référence
 *   (la fin d'un mois, date de l'inventaire).
 *
 * Sources : les factures RÉELLES de Pennylane (jamais les factures prévisionnelles du module Futur,
 * ni ses dates de paiement prévues) et les stocks de fin de mois saisis dans Passé, déjà HT. Aucun
 * taux de TVA n'est appliqué : les montants HT sont ceux que Pennylane porte sur la facture.
 *
 * Ce que l'API Pennylane permet de savoir, et donc ce que ce fichier s'autorise (voir l'audit dans
 * lib/pastBfrPennylane.ts) :
 *  - le montant HT et TTC de chaque facture, sa date d'émission, son reste dû ACTUEL (HT et TTC) ;
 *  - les DATES des transactions bancaires rapprochées de la facture — pas la part de chaque
 *    transaction affectée à la facture, et rien d'HT.
 * Le solde d'une facture à une date passée n'est donc reconstitué que lorsqu'il se déduit sans
 * approximation de ces faits (voir soldeALaDate). Sinon la facture est « au solde inconnu » et la
 * situation est incomplète : jamais un montant estimé présenté comme exact.
 */

export type TypeFactureBfr = "client" | "fournisseur";

/** Pourquoi une facture Pennylane n'est pas une créance ou une dette réelle. */
export type ExclusionFacture = "brouillon" | "archivee" | "annulee" | "avoir" | "hors_facture";

/** Transaction bancaire rapprochée d'une facture dans Pennylane : sa date est celle du règlement. */
export interface ReglementBfr {
  date: string; // YYYY-MM-DD, date de la transaction
  montant: number; // montant de la TRANSACTION (TTC, éventuellement partagée entre plusieurs factures)
}

export interface FactureBfr {
  pennylaneId: string;
  type: TypeFactureBfr;
  numero: string;
  tiers: string;
  dateEmission: string | null; // date métier de la facture (YYYY-MM-DD), jamais sa date d'import
  echeance: string | null;
  devise: string;
  // Montants en euros, toujours positifs (un avoir est reconnu par `exclusion`, pas par son signe).
  montantTtc: number;
  montantHt: number | null; // null : Pennylane ne fournit pas le montant HT
  // Reste dû AUJOURD'HUI selon Pennylane — jamais une donnée historique en soi.
  resteTtc: number;
  resteHt: number | null;
  exclusion: ExclusionFacture | null;
  // Avoir client : la facture qu'il crédite (son pennylaneId), sinon null.
  factureAvoireeId: string | null;
  // Transactions rapprochées. null : pas encore récupérées (ou inutiles : rien n'est réglé).
  reglements: ReglementBfr[] | null;
}

export type SoldeALaDate =
  | { etat: "hors" }
  | { etat: "due"; montantHt: number; dateReglement: string | null }
  | { etat: "inconnue"; montantHtMax: number; raison: string };

const EPSILON = 0.01;

const somme = (valeurs: number[]) => valeurs.reduce((total, v) => total + v, 0);

/**
 * Solde HT d'une facture à la date D (fin de journée incluse). Règles, dans l'ordre :
 *  1. Document exclu (brouillon, archivé, annulé, avoir, devis...) ou émis après D : hors BFR.
 *  2. Rien n'est réglé aujourd'hui (reste dû = montant, avoirs déduits) : rien ne l'était à D —
 *     un reste dû ne fait que baisser. Due à D : montant HT − avoirs HT émis au plus tard à D.
 *  3. Quelque chose est réglé : il faut DATER les règlements, par les transactions rapprochées.
 *     - toutes après D : rien n'était réglé à D → même montant qu'en 2 ;
 *     - toutes au plus tard à D (et avoirs aussi) : la situation à D est celle d'aujourd'hui →
 *       reste dû HT actuel selon Pennylane, et facture hors BFR si elle est soldée ;
 *     - les unes avant, les autres après : la part réglée avant D n'est connue qu'en TTC, sur des
 *       transactions parfois partagées → solde inconnu, jamais approché.
 *     Réglée sans transaction rapprochée (règlement hors banque, marquée payée à la main) : la date
 *     du règlement est inconnue → solde inconnu.
 */
export function soldeALaDate(facture: FactureBfr, avoirs: FactureBfr[], date: string): SoldeALaDate {
  if (facture.exclusion !== null) return { etat: "hors" };
  if (facture.dateEmission === null || facture.dateEmission > date) return { etat: "hors" };

  const inconnue = (raison: string, montantHtMax: number): SoldeALaDate => ({ etat: "inconnue", montantHtMax, raison });
  const plafond = facture.montantHt ?? facture.montantTtc;
  if (facture.montantHt === null) return inconnue("montant HT absent de Pennylane", plafond);
  if (avoirs.some((a) => a.dateEmission === null || a.montantHt === null)) return inconnue("avoir sans date ou sans montant HT", plafond);

  const avoirsAvant = avoirs.filter((a) => (a.dateEmission as string) <= date);
  const montantHtADate = facture.montantHt - somme(avoirsAvant.map((a) => a.montantHt as number));
  const due = (montantHt: number, dateReglement: string | null): SoldeALaDate =>
    montantHt > EPSILON ? { etat: "due", montantHt, dateReglement } : { etat: "hors" };

  const resteSiRienRegle = facture.montantTtc - somme(avoirs.map((a) => a.montantTtc));
  if (facture.resteTtc >= resteSiRienRegle - EPSILON) return due(montantHtADate, null);

  if (facture.devise !== "EUR") return inconnue("facture en devise partiellement réglée", montantHtADate);
  if (facture.reglements === null) return inconnue("règlements pas encore récupérés de Pennylane", montantHtADate);
  if (facture.reglements.length === 0) {
    return inconnue("réglée sans transaction bancaire rapprochée : date de règlement inconnue", montantHtADate);
  }

  const dates = facture.reglements.map((r) => r.date);
  const soldee = facture.resteTtc <= EPSILON;
  if (dates.every((d) => d > date)) {
    return due(montantHtADate, soldee ? dates.reduce((max, d) => (d > max ? d : max)) : null);
  }
  if (dates.every((d) => d <= date)) {
    if (avoirs.length !== avoirsAvant.length) return inconnue("avoir émis après la date de référence", montantHtADate);
    if (soldee) return { etat: "hors" };
    if (facture.resteHt === null) return inconnue("reste dû HT absent de Pennylane", montantHtADate);
    return due(facture.resteHt, null);
  }
  return inconnue(`réglée en partie avant, en partie après le ${formatDateCourte(date)}`, montantHtADate);
}

// --- Situation à une date ---

export interface LigneBfr {
  pennylaneId: string;
  numero: string;
  tiers: string;
  echeance: string | null;
  montantHt: number; // solde HT retenu à la date de référence
  // Date de règlement EFFECTIF (transaction bancaire), quand la facture est soldée depuis.
  dateReglement: string | null;
}

export interface FactureIncertaine {
  pennylaneId: string;
  type: TypeFactureBfr;
  numero: string;
  tiers: string;
  montantHtMax: number;
  raison: string;
}

export interface SituationBfr {
  date: string; // YYYY-MM-DD, fin du mois de référence
  creances: LigneBfr[];
  dettes: LigneBfr[];
  totalCreances: number;
  totalDettes: number;
  stock: number | null; // null : stock non renseigné
  incertaines: FactureIncertaine[];
  // Pourquoi la situation n'est pas fiable ([] = complète).
  raisons: string[];
  complete: boolean;
  bfr: number | null; // null tant que la situation n'est pas complète : jamais un total faussement exact
}

export interface SourcesSituationBfr {
  factures: FactureBfr[];
  date: string;
  stock: number | null;
  // Jour (YYYY-MM-DD) de la dernière synchronisation des factures Pennylane, null si jamais.
  synchroniseLe: string | null;
}

const parMontant = (a: LigneBfr, b: LigneBfr) => b.montantHt - a.montantHt || a.numero.localeCompare(b.numero, "fr");

export function situationBfr({ factures, date, stock, synchroniseLe }: SourcesSituationBfr): SituationBfr {
  const avoirsParFacture = new Map<string, FactureBfr[]>();
  for (const f of factures) {
    if (f.exclusion === "avoir" && f.factureAvoireeId !== null) {
      const cle = `${f.type}|${f.factureAvoireeId}`;
      avoirsParFacture.set(cle, [...(avoirsParFacture.get(cle) ?? []), f]);
    }
  }

  const creances: LigneBfr[] = [];
  const dettes: LigneBfr[] = [];
  const incertaines: FactureIncertaine[] = [];
  for (const f of factures) {
    const solde = soldeALaDate(f, avoirsParFacture.get(`${f.type}|${f.pennylaneId}`) ?? [], date);
    if (solde.etat === "hors") continue;
    if (solde.etat === "inconnue") {
      incertaines.push({ pennylaneId: f.pennylaneId, type: f.type, numero: f.numero, tiers: f.tiers, montantHtMax: solde.montantHtMax, raison: solde.raison });
      continue;
    }
    const ligne = { pennylaneId: f.pennylaneId, numero: f.numero, tiers: f.tiers, echeance: f.echeance, montantHt: solde.montantHt, dateReglement: solde.dateReglement };
    (f.type === "client" ? creances : dettes).push(ligne);
  }
  creances.sort(parMontant);
  dettes.sort(parMontant);
  incertaines.sort((a, b) => b.montantHtMax - a.montantHtMax);

  const raisons: string[] = [];
  if (synchroniseLe === null) raisons.push("Factures Pennylane jamais synchronisées pour le BFR.");
  else if (synchroniseLe <= date) {
    raisons.push(
      `Factures synchronisées le ${formatDateCourte(synchroniseLe)}, au plus tard à la date de référence : celles émises ce jour-là peuvent manquer.`
    );
  }
  if (stock === null) raisons.push(`Stock HT non renseigné pour ${libelleMois(date.slice(0, 7)).toLowerCase()}.`);
  if (incertaines.length > 0) {
    raisons.push(
      `${incertaines.length > 1 ? `${incertaines.length} factures dont le solde` : "1 facture dont le solde"} à cette date ne peut pas être établi exactement.`
    );
  }

  const totalCreances = somme(creances.map((l) => l.montantHt));
  const totalDettes = somme(dettes.map((l) => l.montantHt));
  const complete = raisons.length === 0;
  return {
    date,
    creances,
    dettes,
    totalCreances,
    totalDettes,
    stock,
    incertaines,
    raisons,
    complete,
    bfr: complete ? totalCreances + (stock as number) - totalDettes : null,
  };
}

// --- Situations validées, variation ---

export interface TotauxBfr {
  creances: number;
  stock: number;
  dettes: number;
  bfr: number;
}

/** Révision d'une situation validée : la version remplacée, conservée telle quelle. */
export interface RevisionBfr {
  revisee: string; // horodatage ISO de la révision
  precedente: TotauxBfr & { valideeLe: string; calculeeLe: string };
}

/** Photographie de gestion figée : ce qui est en base, jamais recalculé à l'affichage. */
export interface SituationValidee extends TotauxBfr {
  date: string;
  calculeeLe: string; // horodatage ISO du calcul figé
  synchroniseLe: string | null; // jour de la synchronisation exploitée
  valideeLe: string;
  creancesRetenues: LigneBfr[];
  dettesRetenues: LigneBfr[];
  revisions: RevisionBfr[];
}

export type StatutBfr = "validee" | "provisoire" | "incomplete";

export const LIBELLES_STATUT_BFR: Record<StatutBfr, string> = {
  validee: "Validé",
  provisoire: "Provisoire",
  incomplete: "Incomplet",
};

export function statutBfr(situation: SituationBfr, validee: SituationValidee | null): StatutBfr {
  return validee !== null ? "validee" : situation.complete ? "provisoire" : "incomplete";
}

/** Totaux retenus pour un mois : la photographie validée si elle existe, sinon le calcul complet. */
export function totauxRetenus(situation: SituationBfr, validee: SituationValidee | null): TotauxBfr | null {
  if (validee !== null) return { creances: validee.creances, stock: validee.stock, dettes: validee.dettes, bfr: validee.bfr };
  if (!situation.complete || situation.bfr === null) return null;
  return { creances: situation.totalCreances, stock: situation.stock as number, dettes: situation.totalDettes, bfr: situation.bfr };
}

export interface VariationBfr {
  creances: number; // hausse des créances : hausse du BFR
  stock: number; // hausse du stock : hausse du BFR
  dettes: number; // contribution des dettes : une HAUSSE des dettes est une BAISSE du BFR
  total: number; // = creances + stock + dettes = BFR courant − BFR précédent
}

export function variationBfr(precedent: TotauxBfr, courant: TotauxBfr): VariationBfr {
  const creances = courant.creances - precedent.creances;
  const stock = courant.stock - precedent.stock;
  const dettes = -(courant.dettes - precedent.dettes);
  return { creances, stock, dettes, total: creances + stock + dettes };
}

/** Ce qui est enregistré à la validation : les totaux ET les factures retenues, pour expliquer le chiffre. */
export function photographier(situation: SituationBfr, synchroniseLe: string | null, maintenant: string): SituationValidee | null {
  if (!situation.complete || situation.bfr === null || situation.stock === null) return null;
  return {
    date: situation.date,
    creances: situation.totalCreances,
    stock: situation.stock,
    dettes: situation.totalDettes,
    bfr: situation.bfr,
    calculeeLe: maintenant,
    synchroniseLe,
    valideeLe: maintenant,
    creancesRetenues: situation.creances,
    dettesRetenues: situation.dettes,
    revisions: [],
  };
}

/**
 * Révision explicite d'une situation validée : la nouvelle photographie remplace l'ancienne, qui
 * est conservée dans l'historique des révisions. Jamais appelée par une synchronisation.
 */
export function reviser(ancienne: SituationValidee, nouvelle: SituationValidee, maintenant: string): SituationValidee {
  return {
    ...nouvelle,
    revisions: [
      ...ancienne.revisions,
      {
        revisee: maintenant,
        precedente: {
          creances: ancienne.creances,
          stock: ancienne.stock,
          dettes: ancienne.dettes,
          bfr: ancienne.bfr,
          valideeLe: ancienne.valideeLe,
          calculeeLe: ancienne.calculeeLe,
        },
      },
    ],
  };
}

/**
 * Le calcul actuel, complet, donne-t-il un autre BFR que la photographie validée (données
 * enrichies depuis) ? Seul cas où une révision a un sens : un calcul incomplet ne remplace rien.
 */
export function photographieDepassee(validee: SituationValidee, situation: SituationBfr): boolean {
  return situation.complete && situation.bfr !== null && Math.abs(validee.bfr - situation.bfr) > EPSILON;
}

/**
 * Fenêtre glissante de l'évolution du BFR : le mois choisi et les `nombre − 1` mois civils
 * précédents, du plus ancien au plus récent (septembre 2026 -> octobre 2025 … septembre 2026).
 */
export function moisGlissants(mois: string, nombre = 12): string[] {
  const annee = Number(mois.slice(0, 4));
  const numero = Number(mois.slice(5, 7));
  return Array.from({ length: nombre }, (_, i) => {
    const index = annee * 12 + (numero - 1) - (nombre - 1 - i);
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
  });
}
