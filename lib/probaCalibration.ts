import { Alea } from "./probaAlea";
import { cleTiers, CoteRetard, ObservationRetard } from "./probaHistorique";
import { joursEntre } from "./pastBfrDelais";

/**
 * Prévision probabiliste — 2. Calibration des distributions de retard, propre à chaque compte.
 * Fonctions pures.
 *
 * Aucun nombre de jours universel : la distribution d'un compte est celle de ses propres retards
 * observés (distribution empirique, légèrement lissée). Une entreprise dont les clients paient sous
 * 7 jours garde une distribution étroite ; une entreprise habituée à 30, 45 ou 60 jours de retard,
 * une distribution large. La loi normale n'est pas supposée : on ne tire que des retards ≥ 0, et la
 * part des paiements à l'heure (retard nul) est conservée telle quelle.
 *
 * Modèle hiérarchique avec rétrécissement (shrinkage) : pour un tiers donné, le retard est tiré
 *   - de l'historique du tiers lui-même, avec le poids n / (n + kClient) ;
 *   - sinon de son segment (factures de taille comparable), avec le poids n / (n + kSegment) ;
 *   - sinon de l'ensemble du compte, avec le poids n / (n + kCompte) ;
 *   - sinon de l'hypothèse prudente par défaut (démarrage à froid).
 * k est le nombre d'observations à partir duquel un niveau pèse autant que tout ce qui est au-dessus
 * de lui : plus un client accumule de factures, plus sa propre distribution prend le dessus. Avec
 * deux factures, ACME pèse 25 % (kClient = 6) : le comportement du compte reste majoritaire.
 *
 * Valeurs extrêmes : un retard au-delà de Q3 + 3 × IQR est « extrême ». S'il est isolé (moins de
 * `recurrenceExtreme` occurrences), il est ramené à cette borne (winsorisation) : une seule facture
 * hors norme ne déforme pas le modèle. S'il se répète, la longue traîne est réelle et conservée
 * intacte — un retard de 90 jours récurrent n'est jamais supprimé.
 */

// ---------------------------------------------------------------------------------------------
// Configuration (seul endroit où se règlent seuils, pondérations et hypothèses par défaut)
// ---------------------------------------------------------------------------------------------

/** Hypothèse de démarrage à froid : retard nul avec la probabilité partALHeure, sinon log-normal. */
export interface AprioriRetard {
  partALHeure: number; // 0..1
  medianeRetard: number; // jours, médiane des retards non nuls
  dispersionLog: number; // dispersion de log(retard) des retards non nuls
}

export interface ConfigCalibration {
  kClient: number;
  kSegment: number;
  kCompte: number;
  // Sous ce nombre de factures, un client n'intervient pas du tout (0 = dès la première).
  minObservationsClient: number;
  // Bornes de montant TTC des segments (tailles de facture comparables), croissantes.
  bornesSegments: number[];
  multiplicateurIqr: number;
  iqrMinimal: number; // plancher de l'IQR (jours) pour la borne des valeurs extrêmes
  recurrenceExtreme: number;
  // Lissage multiplicatif des retards non nuls tirés de l'historique (0 = aucun).
  lissageRelatif: number;
  // Hypothèses prudentes par défaut. Prudence = encaissements tardifs, décaissements à l'heure.
  apriori: Record<CoteRetard, AprioriRetard>;
  // Confiance : volume (n / (n + kConfiance)) × fraîcheur (part des règlements des 12 derniers mois).
  kConfiance: number;
  seuilsConfiance: { enCours: number; calibre: number };
}

export const CONFIG_CALIBRATION: ConfigCalibration = {
  kClient: 6,
  kSegment: 10,
  kCompte: 5,
  minObservationsClient: 1,
  bornesSegments: [5_000, 20_000],
  multiplicateurIqr: 3,
  iqrMinimal: 1,
  recurrenceExtreme: 2,
  lissageRelatif: 0.15,
  apriori: {
    client: { partALHeure: 0.35, medianeRetard: 12, dispersionLog: 0.9 },
    fournisseur: { partALHeure: 0.75, medianeRetard: 5, dispersionLog: 0.7 },
  },
  kConfiance: 20,
  seuilsConfiance: { enCours: 0.4, calibre: 0.75 },
};

// ---------------------------------------------------------------------------------------------
// Statistiques (profil de paiement)
// ---------------------------------------------------------------------------------------------

export interface StatistiquesRetard {
  nombre: number;
  retardMedian: number;
  retardMoyen: number;
  ecartType: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  retardMax: number;
  partALHeure: number; // retard nul (payé à l'échéance ou avant)
  partPlus7: number; // retard > 7 j
  partPlus30: number;
  partPlus60: number;
}

/** Quantile à interpolation linéaire sur valeurs triées croissantes (non vides). */
export function quantileTrie(trie: ArrayLike<number>, p: number): number {
  const n = trie.length;
  if (n === 1) return trie[0];
  const position = Math.min(Math.max(p, 0), 1) * (n - 1);
  const bas = Math.floor(position);
  const haut = Math.min(bas + 1, n - 1);
  return trie[bas] + (trie[haut] - trie[bas]) * (position - bas);
}

const arrondi = (x: number, decimales = 1) => Math.round(x * 10 ** decimales) / 10 ** decimales;

export function statistiquesRetard(retards: number[]): StatistiquesRetard | null {
  const n = retards.length;
  if (n === 0) return null;
  const trie = [...retards].sort((a, b) => a - b);
  const moyenne = trie.reduce((s, x) => s + x, 0) / n;
  const variance = n > 1 ? trie.reduce((s, x) => s + (x - moyenne) ** 2, 0) / (n - 1) : 0;
  const part = (filtre: (x: number) => boolean) => arrondi(trie.filter(filtre).length / n, 4);
  const p50 = quantileTrie(trie, 0.5);
  return {
    nombre: n,
    retardMedian: arrondi(p50),
    retardMoyen: arrondi(moyenne),
    ecartType: arrondi(Math.sqrt(variance)),
    p50: arrondi(p50),
    p75: arrondi(quantileTrie(trie, 0.75)),
    p90: arrondi(quantileTrie(trie, 0.9)),
    p95: arrondi(quantileTrie(trie, 0.95)),
    retardMax: trie[n - 1],
    partALHeure: part((x) => x <= 0),
    partPlus7: part((x) => x > 7),
    partPlus30: part((x) => x > 30),
    partPlus60: part((x) => x > 60),
  };
}

// ---------------------------------------------------------------------------------------------
// Valeurs extrêmes
// ---------------------------------------------------------------------------------------------

export interface TraitementExtremes {
  valeurs: number[]; // triées croissantes, après traitement
  borne: number; // Q3 + multiplicateur × IQR
  ecretees: number; // retards isolés ramenés à la borne
  longueTraineConservee: boolean; // retards extrêmes récurrents, conservés tels quels
}

export function traiterValeursExtremes(retards: number[], config: ConfigCalibration = CONFIG_CALIBRATION): TraitementExtremes {
  const trie = [...retards].sort((a, b) => a - b);
  if (trie.length < 4) return { valeurs: trie, borne: Infinity, ecretees: 0, longueTraineConservee: false };
  const q1 = quantileTrie(trie, 0.25);
  const q3 = quantileTrie(trie, 0.75);
  const borne = q3 + config.multiplicateurIqr * Math.max(q3 - q1, config.iqrMinimal);
  const extremes = trie.filter((x) => x > borne).length;
  if (extremes === 0) return { valeurs: trie, borne, ecretees: 0, longueTraineConservee: false };
  if (extremes >= config.recurrenceExtreme) return { valeurs: trie, borne, ecretees: 0, longueTraineConservee: true };
  return { valeurs: trie.map((x) => Math.min(x, borne)), borne, ecretees: extremes, longueTraineConservee: false };
}

// ---------------------------------------------------------------------------------------------
// Distributions et échantillonnage
// ---------------------------------------------------------------------------------------------

export interface DistributionEmpirique {
  valeurs: number[]; // retards traités, triés
  lissageRelatif: number;
}

export function distributionEmpirique(retards: number[], config: ConfigCalibration = CONFIG_CALIBRATION): DistributionEmpirique | null {
  if (retards.length === 0) return null;
  return { valeurs: traiterValeursExtremes(retards, config).valeurs, lissageRelatif: config.lissageRelatif };
}

/** Un retard tiré de l'historique : une observation au hasard, légèrement lissée si non nulle. */
export function tirerEmpirique(d: DistributionEmpirique, alea: Alea): number {
  const v = d.valeurs[alea.entier(d.valeurs.length)];
  if (v <= 0 || d.lissageRelatif <= 0) return v;
  return v * Math.exp(d.lissageRelatif * alea.normale());
}

export function tirerApriori(a: AprioriRetard, alea: Alea): number {
  if (alea.uniforme() < a.partALHeure) return 0;
  return a.medianeRetard * Math.exp(a.dispersionLog * alea.normale());
}

// ---------------------------------------------------------------------------------------------
// Modèle hiérarchique d'un côté (clients ou fournisseurs) d'un compte
// ---------------------------------------------------------------------------------------------

interface Niveau {
  nombre: number;
  distribution: DistributionEmpirique | null;
}

export interface NiveauClient extends Niveau {
  tiers: string;
}

export interface ScoreConfiance {
  score: number; // 0..1
  niveau: "peu_calibre" | "en_cours" | "calibre";
  volume: number; // 0..1
  fraicheur: number; // 0..1
  nombreFactures: number;
}

export interface ModeleRetards {
  cote: CoteRetard;
  config: ConfigCalibration;
  compte: Niveau;
  segments: Niveau[]; // un par tranche de montant : bornesSegments.length + 1
  clients: Map<string, NiveauClient>;
  apriori: AprioriRetard;
  confiance: ScoreConfiance;
}

export function indexSegment(montant: number, bornes: number[]): number {
  let i = 0;
  while (i < bornes.length && montant >= bornes[i]) i++;
  return i;
}

export function libelleSegment(index: number, bornes: number[]): string {
  const f = (x: number) => `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(x)} €`;
  if (bornes.length === 0) return "Toutes les factures";
  if (index === 0) return `Moins de ${f(bornes[0])}`;
  if (index >= bornes.length) return `${f(bornes[bornes.length - 1])} et plus`;
  return `De ${f(bornes[index - 1])} à ${f(bornes[index])}`;
}

export function scoreConfiance(observations: ObservationRetard[], aujourdhui: string, config: ConfigCalibration = CONFIG_CALIBRATION): ScoreConfiance {
  const n = observations.length;
  const volume = n / (n + config.kConfiance);
  const recentes = observations.filter((o) => joursEntre(o.dateReglement, aujourdhui) <= 365).length;
  const fraicheur = n > 0 ? recentes / n : 0;
  const score = Math.round(volume * (0.5 + 0.5 * fraicheur) * 100) / 100;
  const niveau = score >= config.seuilsConfiance.calibre ? "calibre" : score >= config.seuilsConfiance.enCours ? "en_cours" : "peu_calibre";
  return { score, niveau, volume: Math.round(volume * 100) / 100, fraicheur: Math.round(fraicheur * 100) / 100, nombreFactures: n };
}

export function calibrerModele(
  observations: ObservationRetard[],
  cote: CoteRetard,
  aujourdhui: string,
  config: ConfigCalibration = CONFIG_CALIBRATION
): ModeleRetards {
  const propres = observations.filter((o) => o.cote === cote);
  const niveau = (liste: ObservationRetard[]): Niveau => ({
    nombre: liste.length,
    distribution: distributionEmpirique(
      liste.map((o) => o.retard),
      config
    ),
  });
  const parSegment: ObservationRetard[][] = Array.from({ length: config.bornesSegments.length + 1 }, () => []);
  const parClient = new Map<string, ObservationRetard[]>();
  for (const o of propres) {
    parSegment[indexSegment(o.montant, config.bornesSegments)].push(o);
    const liste = parClient.get(o.cleTiers) ?? [];
    liste.push(o);
    parClient.set(o.cleTiers, liste);
  }
  const clients = new Map<string, NiveauClient>();
  parClient.forEach((liste, cle) => clients.set(cle, { ...niveau(liste), tiers: liste[0].tiers }));
  return {
    cote,
    config,
    compte: niveau(propres),
    segments: parSegment.map(niveau),
    clients,
    apriori: config.apriori[cote],
    confiance: scoreConfiance(propres, aujourdhui, config),
  };
}

export interface PoidsNiveaux {
  client: number;
  segment: number;
  compte: number;
  defaut: number;
}

export interface Echantillonneur {
  poids: PoidsNiveaux;
  tirer(alea: Alea): number;
}

const poidsNiveau = (n: number, k: number) => (n > 0 ? n / (n + k) : 0);

/** Poids effectifs de chaque niveau pour un tiers et un montant donnés (somme = 1). */
export function poidsPour(modele: ModeleRetards, tiers: string | null, montant: number): PoidsNiveaux {
  const { config } = modele;
  const client = tiers ? modele.clients.get(cleTiers(tiers)) : undefined;
  const nClient = client && client.nombre >= Math.max(1, config.minObservationsClient) ? client.nombre : 0;
  const segment = modele.segments[indexSegment(montant, config.bornesSegments)];
  const wClient = poidsNiveau(nClient, config.kClient);
  const reste1 = 1 - wClient;
  const wSegment = reste1 * poidsNiveau(segment?.nombre ?? 0, config.kSegment);
  const reste2 = reste1 - wSegment;
  const wCompte = reste2 * poidsNiveau(modele.compte.nombre, config.kCompte);
  return { client: wClient, segment: wSegment, compte: wCompte, defaut: Math.max(0, reste2 - wCompte) };
}

/** Échantillonneur de retards (jours ≥ 0, non arrondis) pour un tiers et un montant. */
export function echantillonneurPour(modele: ModeleRetards, tiers: string | null, montant: number): Echantillonneur {
  const poids = poidsPour(modele, tiers, montant);
  const client = tiers ? modele.clients.get(cleTiers(tiers))?.distribution ?? null : null;
  const segment = modele.segments[indexSegment(montant, modele.config.bornesSegments)]?.distribution ?? null;
  const compte = modele.compte.distribution;
  const seuilClient = poids.client;
  const seuilSegment = seuilClient + poids.segment;
  const seuilCompte = seuilSegment + poids.compte;
  return {
    poids,
    tirer(alea) {
      const u = alea.uniforme();
      if (u < seuilClient && client) return tirerEmpirique(client, alea);
      if (u < seuilSegment && segment) return tirerEmpirique(segment, alea);
      if (u < seuilCompte && compte) return tirerEmpirique(compte, alea);
      return tirerApriori(modele.apriori, alea);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Profil de paiement (stocké, recalculable)
// ---------------------------------------------------------------------------------------------

export interface ProfilPaiement {
  cote: CoteRetard;
  nombreFactures: number;
  statistiques: StatistiquesRetard | null; // sur les retards observés, avant tout traitement
  valeursExtremes: { borne: number | null; ecretees: number; longueTraineConservee: boolean };
  segments: { libelle: string; statistiques: StatistiquesRetard | null }[];
  clients: { tiers: string; cle: string; poidsPropre: number; statistiques: StatistiquesRetard }[];
  confiance: ScoreConfiance;
  // Empreinte de l'historique : le profil n'est réécrit que si elle change.
  empreinte: string;
}

export const MAX_CLIENTS_PROFIL = 500;

export function empreinteHistorique(observations: ObservationRetard[]): string {
  let somme = 0;
  let derniere = "";
  for (const o of observations) {
    somme += o.retard * 31 + o.montant;
    if (o.dateReglement > derniere) derniere = o.dateReglement;
  }
  return `${observations.length}:${derniere}:${Math.round(somme)}`;
}

export function profilPaiement(observations: ObservationRetard[], cote: CoteRetard, aujourdhui: string, config: ConfigCalibration = CONFIG_CALIBRATION): ProfilPaiement {
  const propres = observations.filter((o) => o.cote === cote);
  const modele = calibrerModele(propres, cote, aujourdhui, config);
  const retards = propres.map((o) => o.retard);
  const extremes = traiterValeursExtremes(retards, config);
  const parSegment: number[][] = Array.from({ length: config.bornesSegments.length + 1 }, () => []);
  for (const o of propres) parSegment[indexSegment(o.montant, config.bornesSegments)].push(o.retard);
  const parClient = new Map<string, { tiers: string; retards: number[] }>();
  for (const o of propres) {
    const c = parClient.get(o.cleTiers) ?? { tiers: o.tiers, retards: [] };
    c.retards.push(o.retard);
    parClient.set(o.cleTiers, c);
  }
  const clients = Array.from(parClient.entries())
    .sort((a, b) => b[1].retards.length - a[1].retards.length)
    .slice(0, MAX_CLIENTS_PROFIL)
    .map(([cle, c]) => ({
      tiers: c.tiers,
      cle,
      poidsPropre: Math.round(poidsNiveau(c.retards.length, config.kClient) * 100) / 100,
      statistiques: statistiquesRetard(c.retards) as StatistiquesRetard,
    }));
  return {
    cote,
    nombreFactures: propres.length,
    statistiques: statistiquesRetard(retards),
    valeursExtremes: {
      borne: Number.isFinite(extremes.borne) ? Math.round(extremes.borne * 10) / 10 : null,
      ecretees: extremes.ecretees,
      longueTraineConservee: extremes.longueTraineConservee,
    },
    segments: parSegment.map((r, i) => ({ libelle: libelleSegment(i, config.bornesSegments), statistiques: statistiquesRetard(r) })),
    clients,
    confiance: modele.confiance,
    empreinte: empreinteHistorique(propres),
  };
}
