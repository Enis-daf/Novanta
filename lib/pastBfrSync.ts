import { AsyncLocalStorage } from "node:async_hooks";
import { FactureBfr, ReglementBfr, TypeFactureBfr } from "./pastBfr";
import { FacturePennylaneBrute, factureBfrDepuisPennylane, reglementsDepuisTransactions, reglementsNecessaires, TransactionRapprocheeBrute } from "./pastBfrPennylane";
import { definirObservateurPennylane, EvenementAppelPennylane, PennylaneApiError } from "./pennylaneClient";

/**
 * Synchronisation des factures Pennylane du BFR historique, en deux étapes appelées par la route
 * /api/passe/bfr — SERVEUR UNIQUEMENT (AsyncLocalStorage).
 *
 *  1. « factures » : la liste complète des factures clients et fournisseurs (100 par page, payées
 *     comprises — la liste est la seule source fiable : le journal de modifications de Pennylane ne
 *     garde que 4 semaines et ne dit pas si un rapprochement de paiement met une facture à jour).
 *     Seules les lignes nouvelles ou modifiées sont écrites ; celles qui ont disparu de Pennylane
 *     sont retirées. Les factures dont les règlements doivent être (re)datés sont marquées « à dater ».
 *  2. « reglements » : date les factures marquées, par lots, avec une concurrence limitée et sous le
 *     plafond de l'API (25 requêtes / 5 s). Reprenable : une erreur laisse les factures non datées
 *     marquées, l'appel suivant reprend là.
 *
 * Les dates de règlement d'une facture sont réutilisées d'une synchronisation à l'autre seulement si
 * la facture n'a pas bougé chez Pennylane (même updated_at, même reste dû) ET si elles sont encore
 * valides : rien ne garantit qu'un dérapprochement change la facture, donc aucune date n'est gardée
 * indéfiniment. La validité va de 30 à 59 jours selon la facture (fixe pour une facture donnée) :
 * des dates récupérées le même jour n'expirent pas toutes le même jour, la redatation s'étale.
 *
 * Mesure (banc local, API simulée) : le coût dominant est d'UN appel par facture réglée en tout ou
 * partie, plafonné par l'API à 25 requêtes / 5 s — aucune implémentation ne descend sous
 * (factures à dater) / 4 par seconde avec la marge retenue. Seule l'absence d'appels inutiles et
 * la concurrence (quand la latence de Pennylane est forte) font gagner du temps.
 */

export const VALIDITE_MIN_REGLEMENTS_JOURS = 30;
export const ETALEMENT_VALIDITE_JOURS = 30;
const MS_PAR_JOUR = 86_400_000;

/** Durée de validité des dates de règlement d'une facture, en jours : stable, propre à la facture. */
export function validiteReglementsJours(cle: string): number {
  let h = 2166136261;
  for (let i = 0; i < cle.length; i++) h = Math.imul(h ^ cle.charCodeAt(i), 16777619) >>> 0;
  return VALIDITE_MIN_REGLEMENTS_JOURS + (h % ETALEMENT_VALIDITE_JOURS);
}

/** Règlements stockés : à dater, ou datés (avec la date de récupération). null : inutiles. */
export type ReglementsStockes = { etat: "a_dater" } | { etat: "dates"; recuperesLe: string; transactions: ReglementBfr[] };

export interface LigneStockee {
  facture: FactureBfr; // `reglements` : les transactions datées, ou null
  pennylaneUpdatedAt: string | null;
  reglements: ReglementsStockes | null;
}

export const cleFacture = (type: TypeFactureBfr, pennylaneId: string) => `${type}|${pennylaneId}`;

export interface DepotFacturesBfr {
  charger(): Promise<Map<string, LigneStockee>>;
  ecrire(lignes: LigneStockee[], syncedAt: string): Promise<void>;
  supprimer(cles: { type: TypeFactureBfr; pennylaneId: string }[]): Promise<void>;
  // Horodate toutes les factures de l'organisation : date de la dernière synchronisation réussie.
  marquerSynchronisees(syncedAt: string): Promise<void>;
  aDater(limite: number): Promise<LigneStockee[]>;
  compterADater(): Promise<number>;
}

export interface ClientFacturesBfr {
  listerFactures(type: TypeFactureBfr): Promise<{ items: FacturePennylaneBrute[]; complete: boolean }>;
  listerTransactionsRapprochees(type: TypeFactureBfr, pennylaneId: string): Promise<TransactionRapprocheeBrute[]>;
}

// --- Mesures ---

export interface MesuresSynchro {
  appelsPennylane: Record<string, number>; // par endpoint
  dureePennylaneMs: number; // somme des durées d'appel (parallèles comprises)
  reponses429: number;
  attente429Ms: number;
  operationsSupabase: number;
  dureeSupabaseMs: number;
}

export const nouvellesMesures = (): MesuresSynchro => ({
  appelsPennylane: {},
  dureePennylaneMs: 0,
  reponses429: 0,
  attente429Ms: 0,
  operationsSupabase: 0,
  dureeSupabaseMs: 0,
});

const mesuresCourantes = new AsyncLocalStorage<MesuresSynchro>();

definirObservateurPennylane((evenement: EvenementAppelPennylane) => {
  const mesures = mesuresCourantes.getStore();
  if (!mesures) return;
  mesures.appelsPennylane[evenement.endpoint] = (mesures.appelsPennylane[evenement.endpoint] ?? 0) + 1;
  mesures.dureePennylaneMs += evenement.dureeMs;
  if (evenement.statut === 429) {
    mesures.reponses429++;
    mesures.attente429Ms += evenement.attenteMs;
  }
});

/** Exécute `travail` en rattachant à `mesures` tous les appels Pennylane qu'il déclenche. */
export function avecMesures<T>(mesures: MesuresSynchro, travail: () => Promise<T>): Promise<T> {
  return mesuresCourantes.run(mesures, travail);
}

/** Opération Supabase chronométrée et comptée dans les mesures courantes. */
export async function operationSupabase<T>(operation: () => PromiseLike<T>): Promise<T> {
  const mesures = mesuresCourantes.getStore();
  const debut = Date.now();
  try {
    return await operation();
  } finally {
    if (mesures) {
      mesures.operationsSupabase++;
      mesures.dureeSupabaseMs += Date.now() - debut;
    }
  }
}

// --- Étape 1 : factures ---

/**
 * Instant d'un horodatage, quel que soit son format : Pennylane écrit « …T10:00:00.000+02:00 »,
 * la base relit la même valeur en « …T08:00:00+00:00 ». Comparer les chaînes ferait passer toute
 * facture pour modifiée — réécrite et redatée à chaque synchronisation (constaté sur le Preview).
 */
function instant(horodatage: string | null): number | null {
  if (horodatage === null) return null;
  const ms = Date.parse(horodatage);
  return Number.isNaN(ms) ? null : ms;
}

/** Contenu comparable d'une ligne : ce qui, s'il change, justifie une écriture. */
function empreinte(ligne: LigneStockee): string {
  const reglements = ligne.reglements?.etat === "dates" ? { ...ligne.reglements, recuperesLe: instant(ligne.reglements.recuperesLe) } : ligne.reglements;
  return JSON.stringify([{ ...ligne.facture, reglements: null }, instant(ligne.pennylaneUpdatedAt), reglements]);
}

function reglementsReutilisables(ancienne: LigneStockee | undefined, facture: FactureBfr, pennylaneUpdatedAt: string | null, maintenant: string): ReglementsStockes | null {
  const stockes = ancienne?.reglements;
  if (!ancienne || !stockes || stockes.etat !== "dates") return null;
  const validite = validiteReglementsJours(cleFacture(facture.type, facture.pennylaneId)) * MS_PAR_JOUR;
  const frais = Date.parse(maintenant) - Date.parse(stockes.recuperesLe) < validite;
  const inchangee = instant(pennylaneUpdatedAt) !== null && instant(ancienne.pennylaneUpdatedAt) === instant(pennylaneUpdatedAt) && ancienne.facture.resteTtc === facture.resteTtc;
  return frais && inchangee ? stockes : null;
}

export interface ResultatFactures {
  factures: number;
  ecrites: number;
  supprimees: number;
  aDater: number;
  complete: boolean;
}

export async function synchroniserFactures(client: ClientFacturesBfr, depot: DepotFacturesBfr, maintenant: string): Promise<ResultatFactures> {
  const listes: [TypeFactureBfr, { items: FacturePennylaneBrute[]; complete: boolean }][] = [
    ["client", await client.listerFactures("client")],
    ["fournisseur", await client.listerFactures("fournisseur")],
  ];
  const complete = listes.every(([, liste]) => liste.complete);
  const anciennes = await depot.charger();

  const vues = new Set<string>();
  const aEcrire: LigneStockee[] = [];
  let aDater = 0;
  for (const [type, { items }] of listes) {
    for (const item of items) {
      const facture = factureBfrDepuisPennylane(type, item, null);
      if (facture === null) continue;
      const cle = cleFacture(type, facture.pennylaneId);
      vues.add(cle);
      const pennylaneUpdatedAt = item.updated_at ?? null;
      const ancienne = anciennes.get(cle);
      let reglements: ReglementsStockes | null = null;
      if (reglementsNecessaires(facture)) {
        reglements = reglementsReutilisables(ancienne, facture, pennylaneUpdatedAt, maintenant) ?? { etat: "a_dater" };
        if (reglements.etat === "a_dater") aDater++;
        else facture.reglements = reglements.transactions;
      }
      const ligne: LigneStockee = { facture, pennylaneUpdatedAt, reglements };
      if (!ancienne || empreinte(ancienne) !== empreinte(ligne)) aEcrire.push(ligne);
    }
  }

  await depot.ecrire(aEcrire, maintenant);
  // Une liste peut-être tronquée ne dit pas qu'une facture a disparu : rien n'est retiré alors.
  const disparues = complete ? [...anciennes.values()].filter((l) => !vues.has(cleFacture(l.facture.type, l.facture.pennylaneId))) : [];
  if (disparues.length > 0) await depot.supprimer(disparues.map((l) => ({ type: l.facture.type, pennylaneId: l.facture.pennylaneId })));
  await depot.marquerSynchronisees(maintenant);
  return { factures: vues.size, ecrites: aEcrire.length, supprimees: disparues.length, aDater, complete };
}

// --- Étape 2 : règlements ---

/** Au plus `nombre` démarrages par fenêtre glissante de `fenetreMs` — sous le plafond de l'API. */
export function limiteurDebit(nombre: number, fenetreMs: number, attendre = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
  const departs: number[] = [];
  return async function reserver(): Promise<void> {
    for (;;) {
      const maintenant = Date.now();
      while (departs.length > 0 && maintenant - departs[0] >= fenetreMs) departs.shift();
      if (departs.length < nombre) {
        departs.push(maintenant);
        return;
      }
      await attendre(fenetreMs - (maintenant - departs[0]) + 5);
    }
  };
}

export interface OptionsDatation {
  maxFactures: number; // factures datées au plus par appel
  concurrence: number;
  budgetMs: number; // au-delà, plus aucun nouvel appel n'est lancé
  maintenant: string;
  reserver: () => Promise<void>;
}

export interface ResultatReglements {
  datees: number;
  restantes: number;
  // Plafond de l'API encore atteint après les nouvelles tentatives (autre synchronisation sur le
  // même token, par exemple) : le lot s'arrête proprement, l'appel suivant reprend.
  ralenti: boolean;
  // Pennylane momentanément indisponible (5xx, délai dépassé) : même arrêt propre. Constaté sur le
  // Preview : un seul 502 faisait échouer toute la synchronisation.
  interrompu: boolean;
}

export async function daterReglements(client: ClientFacturesBfr, depot: DepotFacturesBfr, options: OptionsDatation): Promise<ResultatReglements> {
  const debut = Date.now();
  const lot = await depot.aDater(options.maxFactures);
  const datees: LigneStockee[] = [];
  let suivante = 0;
  let erreur: unknown = null;
  let ralenti = false;
  let interrompu = false;

  const travailleur = async () => {
    while (erreur === null && !ralenti && !interrompu && suivante < lot.length && Date.now() - debut < options.budgetMs) {
      const ligne = lot[suivante++];
      await options.reserver();
      try {
        const transactions = reglementsDepuisTransactions(await client.listerTransactionsRapprochees(ligne.facture.type, ligne.facture.pennylaneId));
        datees.push({
          ...ligne,
          facture: { ...ligne.facture, reglements: transactions },
          reglements: { etat: "dates", recuperesLe: options.maintenant, transactions },
        });
      } catch (e) {
        if (e instanceof PennylaneApiError && e.reason === "rate_limited") ralenti = true;
        else if (e instanceof PennylaneApiError && e.reason === "unavailable") interrompu = true;
        else erreur = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrence) }, travailleur));

  // Ce qui a été daté est gardé, même si un appel a échoué : la reprise repart des restantes.
  await depot.ecrire(datees, options.maintenant);
  if (erreur !== null) throw erreur;
  return { datees: datees.length, restantes: await depot.compterADater(), ralenti, interrompu };
}
