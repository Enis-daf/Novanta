import { formatDateCourte } from "./dates";
import { formatMontant } from "./format";
import { finDeMois } from "./pastAdjustments";
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
 * approximation de ces faits (voir soldeALaDate). Sinon la facture est « au solde inconnu » : elle
 * est exclue du calcul et comptée dans les réserves — ni à 0, ni à son montant, jamais estimée. Le
 * BFR reste calculé sur tout ce qui est fiable, statut « Avec réserves », et validable avec ces
 * réserves enregistrées. Seul un manque essentiel (stock, factures jamais synchronisées ou trop
 * anciennes) le rend indisponible.
 */

export type TypeFactureBfr = "client" | "fournisseur";

/** Pourquoi une facture Pennylane n'est pas une créance ou une dette réelle. */
export type ExclusionFacture = "brouillon" | "archivee" | "annulee" | "avoir" | "hors_facture";

/** Transaction bancaire rapprochée d'une facture dans Pennylane : sa date est celle du règlement. */
export interface ReglementBfr {
  date: string; // YYYY-MM-DD, date de la transaction
  montant: number; // montant de la TRANSACTION (TTC, éventuellement partagée entre plusieurs factures)
  // Identifiant Pennylane de la transaction : relie la facture aux catégories analytiques de ses
  // transactions (module Passé). Absent des règlements datés avant ce champ (redatés une fois).
  transactionId?: string | null;
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
  // Classement de la facture pour l'analyse des délais — ses étages P&L, DÉDUITS à la lecture de ses
  // transactions rapprochées (lib/pastBfrAnalyseDelais.ts), jamais stockés. [] : non classée ;
  // null / absent : inconnu (facture encore ouverte, transactions pas encore synchronisées dans Passé).
  // Ne sert qu'à filtrer l'analyse des délais, jamais au calcul du BFR.
  categories?: CategorieAnalytique[] | null;
}

export interface CategorieAnalytique {
  id: string;
  label: string;
  groupId: string | null; // axe analytique (category_group)
  // Pondération de la catégorie sur la transaction, conservée telle quelle : un délai est celui de la
  // facture entière, il n'est jamais ventilé entre catégories.
  weight: number;
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

/** Facture exclue du calcul : de quoi comprendre la réserve, sans jamais en déduire un solde. */
export interface FactureIncertaine {
  pennylaneId: string;
  type: TypeFactureBfr;
  numero: string;
  tiers: string;
  // Montant HT de la facture à l'émission (null : absent de Pennylane). Contexte seulement : ni une
  // créance ou une dette manquante, ni un impact sur le BFR — le solde à la date est inconnu.
  montantHtInitial: number | null;
  dateEmission: string | null;
  echeance: string | null;
  raison: string;
  // Ce que Pennylane dit aujourd'hui du paiement.
  paiement: string;
}

export interface SituationBfr {
  date: string; // YYYY-MM-DD, fin du mois de référence
  creances: LigneBfr[];
  dettes: LigneBfr[];
  totalCreances: number;
  totalDettes: number;
  stock: number | null; // null : stock non renseigné
  // Factures exclues du calcul : les totaux et le BFR ne portent que sur les factures fiables.
  incertaines: FactureIncertaine[];
  // Pourquoi le BFR ne peut pas être calculé du tout ([] = calculable). Les factures exclues n'en
  // font pas partie : elles sont une réserve, pas un blocage.
  raisons: string[];
  // Calculable, et sans aucune facture exclue.
  complete: boolean;
  bfr: number | null; // null seulement si indisponible (`raisons`)
}

export interface SourcesSituationBfr {
  factures: FactureBfr[];
  date: string;
  stock: number | null;
  // Jour (YYYY-MM-DD) de la dernière synchronisation des factures Pennylane, null si jamais.
  synchroniseLe: string | null;
}

/** Ce que Pennylane dit aujourd'hui du paiement d'une facture : faits bruts, sans interprétation. */
export function informationPaiement(f: FactureBfr): string {
  const reste = `Reste dû aujourd'hui : ${formatMontant(f.resteTtc)} TTC sur ${formatMontant(f.montantTtc)}`;
  if (f.reglements === null) return `${reste} · transactions rapprochées pas encore récupérées`;
  if (f.reglements.length === 0) return `${reste} · aucune transaction bancaire rapprochée`;
  const dates = f.reglements.map((r) => r.date).sort();
  const quand = dates[0] === dates[dates.length - 1] ? `le ${formatDateCourte(dates[0])}` : `du ${formatDateCourte(dates[0])} au ${formatDateCourte(dates[dates.length - 1])}`;
  return `${reste} · ${dates.length} transaction${dates.length > 1 ? "s" : ""} rapprochée${dates.length > 1 ? "s" : ""} ${quand}`;
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
      incertaines.push({
        pennylaneId: f.pennylaneId,
        type: f.type,
        numero: f.numero,
        tiers: f.tiers,
        montantHtInitial: f.montantHt,
        dateEmission: f.dateEmission,
        echeance: f.echeance,
        raison: solde.raison,
        paiement: informationPaiement(f),
      });
      continue;
    }
    const ligne = { pennylaneId: f.pennylaneId, numero: f.numero, tiers: f.tiers, echeance: f.echeance, montantHt: solde.montantHt, dateReglement: solde.dateReglement };
    (f.type === "client" ? creances : dettes).push(ligne);
  }
  creances.sort(parMontant);
  dettes.sort(parMontant);
  incertaines.sort((a, b) => (b.montantHtInitial ?? 0) - (a.montantHtInitial ?? 0) || a.numero.localeCompare(b.numero, "fr"));

  const raisons: string[] = [];
  if (synchroniseLe === null) raisons.push("Factures Pennylane jamais synchronisées pour le BFR.");
  else if (synchroniseLe <= date) {
    raisons.push(
      `Factures synchronisées le ${formatDateCourte(synchroniseLe)}, au plus tard à la date de référence : celles émises ce jour-là peuvent manquer.`
    );
  }
  if (stock === null) raisons.push(`Stock HT non renseigné pour ${libelleMois(date.slice(0, 7)).toLowerCase()}.`);

  const totalCreances = somme(creances.map((l) => l.montantHt));
  const totalDettes = somme(dettes.map((l) => l.montantHt));
  const calculable = raisons.length === 0;
  return {
    date,
    creances,
    dettes,
    totalCreances,
    totalDettes,
    stock,
    incertaines,
    raisons,
    complete: calculable && incertaines.length === 0,
    bfr: calculable ? totalCreances + (stock as number) - totalDettes : null,
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
  precedente: TotauxBfr & { valideeLe: string; calculeeLe: string; facturesExclues?: FactureIncertaine[] };
}

/** Photographie de gestion figée : ce qui est en base, jamais recalculé à l'affichage. */
export interface SituationValidee extends TotauxBfr {
  date: string;
  calculeeLe: string; // horodatage ISO du calcul figé
  synchroniseLe: string | null; // jour de la synchronisation exploitée
  valideeLe: string;
  creancesRetenues: LigneBfr[];
  dettesRetenues: LigneBfr[];
  // Factures exclues du calcul à la validation : la réserve fait partie de la photographie.
  facturesExclues: FactureIncertaine[];
  revisions: RevisionBfr[];
}

export type StatutBfr = "validee" | "provisoire" | "reserves" | "indisponible";

export const LIBELLES_STATUT_BFR: Record<StatutBfr, string> = {
  validee: "Validé",
  provisoire: "Provisoire",
  reserves: "Avec réserves",
  indisponible: "Indisponible",
};

export function statutBfr(situation: SituationBfr, validee: SituationValidee | null): StatutBfr {
  if (validee !== null) return "validee";
  if (situation.bfr === null) return "indisponible";
  return situation.incertaines.length > 0 ? "reserves" : "provisoire";
}

/** Factures exclues du chiffre affiché : celles de la photographie validée, sinon celles du calcul. */
export function facturesExcluesRetenues(situation: SituationBfr, validee: SituationValidee | null): FactureIncertaine[] {
  return validee !== null ? validee.facturesExclues : situation.incertaines;
}

export interface ResumeExclusions {
  nombre: number;
  // Montants HT à l'émission, cumulés : un ordre de grandeur, jamais un impact sur le BFR.
  montantHtInitial: number;
  sansMontantHt: number;
}

export function resumerExclusions(exclues: FactureIncertaine[]): ResumeExclusions {
  return {
    nombre: exclues.length,
    montantHtInitial: somme(exclues.map((f) => f.montantHtInitial ?? 0)),
    sansMontantHt: exclues.filter((f) => f.montantHtInitial === null).length,
  };
}

/** « 12 factures ont été exclues du calcul car leur solde à cette date ne peut pas être établi exactement. » */
export function phraseExclusions(nombre: number): string {
  return nombre > 1
    ? `${nombre} factures ont été exclues du calcul car leur solde à cette date ne peut pas être établi exactement.`
    : "1 facture a été exclue du calcul car son solde à cette date ne peut pas être établi exactement.";
}

/** Totaux retenus pour un mois : la photographie validée si elle existe, sinon le calcul sur les factures fiables. */
export function totauxRetenus(situation: SituationBfr, validee: SituationValidee | null): TotauxBfr | null {
  if (validee !== null) return { creances: validee.creances, stock: validee.stock, dettes: validee.dettes, bfr: validee.bfr };
  if (situation.bfr === null) return null;
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

/** Ce qui est enregistré à la validation : les totaux, les factures retenues ET les factures exclues, pour expliquer le chiffre. */
export function photographier(situation: SituationBfr, synchroniseLe: string | null, maintenant: string): SituationValidee | null {
  if (situation.bfr === null || situation.stock === null) return null;
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
    facturesExclues: situation.incertaines,
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
          facturesExclues: ancienne.facturesExclues,
        },
      },
    ],
  };
}

/**
 * Le calcul actuel diffère-t-il de la photographie validée (autre BFR, ou autres factures exclues) ?
 * Seul cas où une révision a un sens ; un calcul indisponible ne remplace rien. La photographie, elle,
 * ne change jamais sans révision explicite.
 */
export function photographieDepassee(validee: SituationValidee, situation: SituationBfr): boolean {
  if (situation.bfr === null) return false;
  if (Math.abs(validee.bfr - situation.bfr) > EPSILON) return true;
  const cle = (f: FactureIncertaine) => `${f.type}|${f.pennylaneId}`;
  const avant = new Set(validee.facturesExclues.map(cle));
  return avant.size !== situation.incertaines.length || situation.incertaines.some((f) => !avant.has(cle(f)));
}

/** Factures exclues à la validation dont le solde s'établit désormais. */
export function exclusionsDevenuesFiables(validee: SituationValidee, situation: SituationBfr): FactureIncertaine[] {
  const cle = (f: FactureIncertaine) => `${f.type}|${f.pennylaneId}`;
  const encore = new Set(situation.incertaines.map(cle));
  return validee.facturesExclues.filter((f) => !encore.has(cle(f)));
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

/**
 * Date affichée pour un mois sur l'axe de l'évolution : son dernier jour calendaire (30/09/2026,
 * 28/02/2026, 29/02/2028). C'est une date de période métier, jamais la date technique d'un snapshot,
 * d'une synchronisation ou d'une saisie. `compact` : « 30/09 » (l'année va sur une seconde ligne).
 */
export function libelleFinDeMois(mois: string, compact = false): string {
  const date = formatDateCourte(finDeMois(mois));
  return compact ? date.slice(0, 5) : date;
}
