import { ajouterJours, ajouterMois, parseDateISO, toISODate } from "./dates";
import { NormalizedBankTransaction, ressembleReferenceTechnique } from "./bankTransaction";

/**
 * Moteur de détection des dépenses récurrentes. Ne dépend QUE de NormalizedBankTransaction[] —
 * jamais du XLSX ni d'aucune autre source — pour rester réutilisable tel quel par une future
 * source Pennylane (voir bankTransaction.ts).
 *
 * Philosophie : RÉCURRENCE = IDENTITÉ (bénéficiaire/signature métier) + CADENCE, puis
 * MONTANT = QUALIFICATION (jamais un critère éliminatoire). Une série identifiée par un
 * bénéficiaire stable et une cadence régulière est proposée même si le montant varie fortement
 * (salaire, loyer indexé, abonnement en devise) — le montant sert uniquement à qualifier le
 * candidat comme "stable" ou "variable" pour l'utilisateur, jamais à décider de son existence.
 *
 * Périmètre V1 : hebdomadaire et mensuel uniquement, déterministe, sans IA.
 */

export type FrequenceDetectee = "hebdomadaire" | "mensuel";
export type ProfilMontant = "stable" | "variable";

export interface OccurrenceCandidat {
  date: string; // YYYY-MM-DD
  montant: number; // valeur absolue
}

export interface RecurringChargeCandidate {
  id: string; // stable (dérivé de la signature d'identité), utilisable comme clé React
  libellePropose: string;
  montantPropose: number; // médiane des montants observés (valeur absolue) — même règle stable ou variable
  profilMontant: ProfilMontant;
  frequence: FrequenceDetectee;
  derniereOccurrence: string; // YYYY-MM-DD
  prochaineOccurrenceEstimee: string; // YYYY-MM-DD, dérivée de la cadence détectée
  nombreOccurrences: number;
  montantMin: number;
  montantMax: number;
  occurrences: OccurrenceCandidat[];
}

const OCCURRENCES_MINIMUM = 3;

// Utilisé uniquement quand ni le libellé métier ni la signature d'identité ne comportent le moindre
// token exploitable (tout ce qui reste est une référence technique) — jamais une chaîne bancaire ou
// un identifiant technique n'est proposé comme nom de Charge fixe. Le champ reste entièrement
// modifiable par l'utilisateur avant création.
const LIBELLE_NEUTRE_PAR_DEFAUT = "Charge récurrente à nommer";

// Tokens présents dans une très large proportion des débits (ex: le nom propre de l'entreprise
// elle-même, apposé de façon incohérente par la banque sur ses propres virements sortants — ou des
// fragments de boilerplate d'un prestataire de paiement type Amazon) : trop génériques pour porter
// une identité de bénéficiaire, ils sont retirés de la signature d'identité. Calculé à chaque appel
// à partir du jeu de transactions fourni — jamais une liste figée, jamais un nom codé en dur.
const SEUIL_FREQUENCE_BRUIT = 0.08;

// Nombre de tokens (après retrait du bruit) retenus comme signature d'identité du bénéficiaire.
// Volontairement court : les libellés bancaires réels insèrent des tokens variables à des positions
// incohérentes après le nom (troncatures, tags internes) — un plafond court capture le nom sans
// dépendre de ce qui vient juste après.
const CAP_TOKENS_IDENTITE = 3;

function mediane(valeurs: number[]): number {
  const triees = [...valeurs].sort((a, b) => a - b);
  const milieu = Math.floor(triees.length / 2);
  return triees.length % 2 === 0 ? (triees[milieu - 1] + triees[milieu]) / 2 : triees[milieu];
}

/** tolérance = max(5 €, 5 % du montant médian) — sert désormais à QUALIFIER le candidat, jamais à l'éliminer. */
function toleranceMontant(montantMedian: number): number {
  return Math.max(5, montantMedian * 0.05);
}

function ecartJours(dateA: string, dateB: string): number {
  const ms = parseDateISO(dateB).getTime() - parseDateISO(dateA).getTime();
  return Math.round(ms / 86400000);
}

function moisAbsolu(dateISO: string): number {
  const d = parseDateISO(dateISO);
  return d.getFullYear() * 12 + d.getMonth();
}

// Une série mensuelle réelle rate parfois une échéance (prélèvement rejeté puis rattrapé le mois
// suivant, facture EDF sautée un mois, cotisation en retard...) sans cesser d'être une charge
// récurrente. Tolère qu'AU PLUS un mois calendaire soit sauté entre deux occurrences consécutives
// (écart de 2 entre les mois présents plutôt que 1) — un écart plus grand (≥ 3, soit ≥ 2 mois
// sautés d'affilée) n'est plus considéré comme une cadence mensuelle cohérente, pour continuer à
// rejeter les séries erratiques (même créancier, dates sans aucune régularité).
const ECART_MOIS_MAX_TOLERE = 2;

// Une charge mensuelle légitime a au plus 1 occurrence par mois, parfois 2 (salaire + régularisation,
// loyer + régul charges). Au-delà, ce n'est plus une facture mensuelle mais un même créancier payé
// plusieurs fois par mois de façon répétée (dépenses courantes chez un commerçant, achats B2B
// fréquents...) : la série touche "tous les mois" par pure fréquence, pas par cadence de facturation.
// Règle de CADENCE (densité d'occurrences dans le temps), jamais une règle de montant — un créancier
// à cadence réellement mensuelle passe cette règle quel que soit son profil de montant (stable ou
// variable).
const RATIO_OCCURRENCES_PAR_MOIS_MAX = 2;

/**
 * Détecte une cadence hebdomadaire (écart ~7 jours, tolérance week-ends/jours ouvrés) ou une
 * cadence mensuelle calendaire (le mois avance de 1 à chaque occurrence, avec une tolérance d'au
 * plus un mois sauté — voir ECART_MOIS_MAX_TOLERE — sans exiger un nombre de jours précis : tolère
 * nativement le glissement de fin de mois : 31 janvier, 28 février, 31 mars, 30 avril). Pour la
 * cadence mensuelle, plusieurs transactions le même mois calendaire (ex: salaire + régularisation,
 * loyer + régul charges) sont regroupées sur un seul "mois" avant de vérifier la progression —
 * elles ne cassent pas la cadence, mais une série dont la densité d'occurrences par mois dépasse
 * RATIO_OCCURRENCES_PAR_MOIS_MAX (achats fréquents chez un même commerçant) n'est plus reconnue
 * comme mensuelle. Retourne null si aucune des deux cadences n'est cohérente sur TOUTE la série
 * (donc pas de quotidien/trimestriel/annuel en V1).
 */
function detecterFrequence(datesTriees: string[]): FrequenceDetectee | null {
  if (datesTriees.length < 2) return null;

  const joursUniques = [...new Set(datesTriees)];
  if (joursUniques.length >= 2) {
    const ecarts = joursUniques.slice(1).map((date, i) => ecartJours(joursUniques[i], date));
    if (ecarts.every((e) => e >= 5 && e <= 9)) return "hebdomadaire";
  }

  const moisUniques: number[] = [];
  for (const date of datesTriees) {
    const mois = moisAbsolu(date);
    if (moisUniques.length === 0 || moisUniques[moisUniques.length - 1] !== mois) moisUniques.push(mois);
  }
  const toutMensuel =
    moisUniques.length >= 2 &&
    moisUniques.every((m, i) => i === 0 || m - moisUniques[i - 1] <= ECART_MOIS_MAX_TOLERE) &&
    datesTriees.length / moisUniques.length <= RATIO_OCCURRENCES_PAR_MOIS_MAX;
  if (toutMensuel) return "mensuel";

  return null;
}

// En dessous de ce nombre de débits, la fréquence d'un token n'est pas un signal fiable (un
// import réduit où un seul bénéficiaire est présent verrait ses propres tokens d'identité
// atteindre 100% de fréquence, et se retrouver à tort traités comme du bruit). Le retrait de bruit
// par fréquence corpus ne s'applique qu'à partir d'un volume de débits suffisant pour être
// statistiquement significatif ; en dessous, seuls les préfixes structurels/mois/années/références
// (bankTransaction.ts) nettoient le libellé.
const TAILLE_MIN_CORPUS_POUR_BRUIT = 20;

// Un token très fréquent à l'échelle du corpus n'est pas forcément du bruit : un nom de marchand
// réel (ex: "AMAZON", ou son second mot "PAYMENTS" dans "Amazon Payments Europe") peut être encore
// plus fréquent qu'un tag interne (ex: "QANNT", le nom de l'entreprise elle-même) si l'utilisateur a
// de nombreuses relations récurrentes différentes avec la même enseigne — la seule fréquence ne
// permet donc pas de les distinguer. En revanche, un mot faisant partie intégrante d'un nom de
// marchand occupe toujours la MÊME position dans son libellé (le 1er mot d'une marque est toujours
// en position 0, son 2e mot toujours en position 1...), alors qu'un tag interne est inséré à des
// positions incohérentes d'une occurrence à l'autre. En dessous de ce ratio de présence à sa
// position la plus fréquente, un token fréquent est traité comme du bruit ; au-dessus, il est
// toujours conservé, quelle que soit sa fréquence globale.
const SEUIL_RATIO_POSITION_DOMINANTE = 0.7;

interface StatistiquesToken {
  frequence: number; // proportion de transactions distinctes contenant le token
  ratioPositionDominante: number; // proportion de ces apparitions à sa position la plus fréquente
}

/** Statistiques de fréquence et de position de chaque token du corpus fourni (voir SEUIL_RATIO_POSITION_DOMINANTE). */
function calculerStatistiquesTokens(labelsNormalizes: string[]): Map<string, StatistiquesToken> {
  if (labelsNormalizes.length < TAILLE_MIN_CORPUS_POUR_BRUIT) return new Map();

  const occurrencesParToken = new Map<string, number>();
  const positionsParToken = new Map<string, Map<number, number>>();
  for (const label of labelsNormalizes) {
    const tokens = label.split(" ").filter(Boolean);
    const dejaVus = new Set<string>();
    tokens.forEach((token, position) => {
      if (dejaVus.has(token)) return; // ne compter qu'une fois par libellé, à sa PREMIÈRE position
      dejaVus.add(token);
      occurrencesParToken.set(token, (occurrencesParToken.get(token) ?? 0) + 1);
      const positions = positionsParToken.get(token) ?? new Map<number, number>();
      positions.set(position, (positions.get(position) ?? 0) + 1);
      positionsParToken.set(token, positions);
    });
  }
  const total = labelsNormalizes.length || 1;
  const statistiques = new Map<string, StatistiquesToken>();
  for (const [token, occurrences] of occurrencesParToken) {
    const positions = positionsParToken.get(token);
    const maxAUnePosition = positions ? Math.max(...positions.values()) : 0;
    statistiques.set(token, {
      frequence: occurrences / total,
      ratioPositionDominante: maxAUnePosition / occurrences,
    });
  }
  return statistiques;
}

/** Un token très fréquent est du bruit corpus SAUF s'il occupe une position stable (voir SEUIL_RATIO_POSITION_DOMINANTE). */
function estBruitCorpus(token: string, statistiquesTokens: Map<string, StatistiquesToken>): boolean {
  const stats = statistiquesTokens.get(token);
  if (!stats || stats.frequence <= SEUIL_FREQUENCE_BRUIT) return false;
  return stats.ratioPositionDominante < SEUIL_RATIO_POSITION_DOMINANTE;
}

/**
 * Signature d'identité d'une transaction : ses tokens normalisés, débarrassés des tokens trop
 * génériques pour ce corpus (bruit corpus), tronqués aux CAP_TOKENS_IDENTITE premiers tokens
 * restants. C'est le "QUI/QUOI" de la récurrence — la cadence et le montant sont évalués séparément
 * une fois les occurrences regroupées par cette signature.
 */
function signatureIdentite(labelNormalized: string, statistiquesTokens: Map<string, StatistiquesToken>): string {
  const tokens = labelNormalized.split(" ").filter((token) => token && !estBruitCorpus(token, statistiquesTokens));
  return tokens.slice(0, CAP_TOKENS_IDENTITE).join(" ");
}

// ---------------------------------------------------------------------------------------------
// Construction du libellé métier proposé (proposedLabel) : jamais le libellé bancaire brut d'une
// occurrence, même la plus récente. Dérivé de l'ENSEMBLE des occurrences du groupe : seuls les
// tokens présents de façon stable dans le groupe (le "QUI" + un éventuel mot métier) survivent —
// tout ce qui varie d'une occurrence à l'autre (mois déjà retirés en amont, mais aussi troncatures
// bancaires incohérentes, numéros, tags) disparaît naturellement, sans liste figée par bénéficiaire.
// ---------------------------------------------------------------------------------------------

// Mots métier explicitement présents dans le libellé bancaire, jamais déduits/inventés : s'ils sont
// là, ils sont mis en tête du libellé proposé ("Salaire Benjamin Houvier" plutôt que
// "Benjamin Houvier Salaire"). Ne sert jamais à catégoriser comptablement — uniquement à ordonner
// un libellé déjà présent dans le texte source.
const MOTS_METIER = new Set(["SALAIRE", "LOYER", "COTISATION", "ASSURANCE", "ABONNEMENT"]);

// Raisons sociales françaises courantes, conservées en majuscules dans le libellé proposé (le reste
// passe en casse "Titre"). Liste générique et standard — jamais un nom de bénéficiaire du fichier.
const ACRONYMES_LEGAUX = new Set(["SCI", "SAS", "SARL", "SASU", "EURL", "SNC", "SCOP", "GIE", "SA"]);

// Un token générique (nom, mot descriptif) doit être présent dans la quasi-totalité des occurrences
// du groupe pour survivre dans le libellé proposé — un mois, un numéro, un fragment de troncature
// isolé (ex: "AO" d'un "AOUT" mal coupé) n'apparaît que sur 1 occurrence et est donc écarté.
const SEUIL_STABILITE_GENERIQUE = 0.9;
// Un mot métier connu (voir MOTS_METIER) est conservé dès qu'il apparaît sur une bonne partie des
// occurrences : une transaction occasionnelle de nature différente (ex: une "régularisation de
// charges" au milieu d'une série de loyers) ne doit pas lui faire perdre sa place.
const SEUIL_STABILITE_MOT_METIER = 0.4;

function dedupliquerConsecutifs(tokens: string[]): string[] {
  return tokens.filter((t, i) => i === 0 || t !== tokens[i - 1]);
}

/**
 * Une raison sociale (SCI, SAS, SARL...) n'est utile que lorsqu'elle précède le nom qu'elle
 * qualifie ("SCI Les Ateliers") — convention française usuelle. Trouvée plus loin dans le libellé
 * (ex: "...EU SARL-SUCCURSA" après une enseigne déjà identifiable comme "Amazon Business"), elle ne
 * qualifie plus rien de nouveau et est retirée.
 */
function retirerAcronymesTardifs(tokens: string[]): string[] {
  return tokens.filter((t, i) => !ACRONYMES_LEGAUX.has(t) || i < 2);
}

/**
 * Retire les tokens qui ne sont qu'une variante concaténée d'un token déjà retenu (ex:
 * "AMZNBUSINESS" alors que "BUSINESS" est déjà présent séparément) : le plus long des deux, dès lors
 * qu'il contient l'autre comme sous-chaîne, est redondant — reconnaissance déterministe sans IA
 * d'un même marchand écrit sous deux formes.
 */
function retirerRedondancesSousChaines(tokens: string[]): string[] {
  const aSupprimer = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    for (let j = 0; j < tokens.length; j++) {
      if (i !== j && tokens[j].length < tokens[i].length && tokens[i].includes(tokens[j])) {
        aSupprimer.add(i);
      }
    }
  }
  return tokens.filter((_, i) => !aSupprimer.has(i));
}

/** Casse "Titre" (Majuscule initiale, reste en minuscules) sauf raison sociale connue, conservée en capitales. */
function mettreEnFormeLisible(tokens: string[]): string {
  return tokens.map((t) => (ACRONYMES_LEGAUX.has(t) ? t : t.charAt(0) + t.slice(1).toLowerCase())).join(" ");
}

/**
 * Construit le libellé métier proposé à partir de TOUTES les occurrences du groupe (jamais d'une
 * seule occurrence choisie arbitrairement). Retourne null si aucun token n'est assez stable —
 * l'appelant retombe alors sur la signature d'identité déjà validée, jamais sur le libellé brut.
 *
 * Le retrait de bruit corpus (voir estBruitCorpus) s'applique ici aussi, mais grâce au ratio de
 * présence en tête, un nom de marchand réel très fréquent (ex: "AMAZON", présent dans plusieurs
 * relations récurrentes différentes) n'est jamais retiré à tort — seul un tag interne inséré à des
 * positions incohérentes (ex: "QANNT") l'est.
 */
function construireLibelleMetier(
  occurrencesTriees: NormalizedBankTransaction[],
  statistiquesTokens: Map<string, StatistiquesToken>
): string | null {
  const tokensParOccurrence = occurrencesTriees.map((o) =>
    o.labelNormalized.split(" ").filter((t) => t && !estBruitCorpus(t, statistiquesTokens))
  );
  const nombreOccurrences = tokensParOccurrence.length;

  const frequenceGroupe = new Map<string, number>();
  for (const tokens of tokensParOccurrence) {
    for (const token of new Set(tokens)) frequenceGroupe.set(token, (frequenceGroupe.get(token) ?? 0) + 1);
  }

  const estStable = (token: string): boolean => {
    const ratio = (frequenceGroupe.get(token) ?? 0) / nombreOccurrences;
    return ratio >= (MOTS_METIER.has(token) ? SEUIL_STABILITE_MOT_METIER : SEUIL_STABILITE_GENERIQUE);
  };

  // Ordre naturel pris sur l'occurrence la plus récente porteuse d'au moins un token stable (garde-
  // fou pour le cas rare où la toute dernière occurrence serait, par accident, entièrement bruitée).
  let tokensRetenus: string[] = [];
  for (let i = tokensParOccurrence.length - 1; i >= 0; i--) {
    const filtres = dedupliquerConsecutifs(tokensParOccurrence[i].filter(estStable));
    if (filtres.length > 0) {
      tokensRetenus = filtres;
      break;
    }
  }
  if (tokensRetenus.length === 0) return null;

  tokensRetenus = retirerAcronymesTardifs(tokensRetenus);
  tokensRetenus = retirerRedondancesSousChaines(tokensRetenus);

  // Garde-fou final : même stable dans le groupe, un token qui ressemble structurellement à une
  // référence technique (ex: un numéro de sous-compte marchand réutilisé sur toute la série) ne
  // doit jamais se retrouver seul à composer le libellé. Un nom de marchand identifiable gagne
  // toujours contre une référence technique — et si tout ce qui reste est technique, on préfère ne
  // rien proposer plutôt qu'une chaîne illisible (voir le repli neutre dans l'appelant).
  const tokensUtiles = tokensRetenus.filter((t) => !ressembleReferenceTechnique(t));
  if (tokensUtiles.length === 0) return null;
  tokensRetenus = tokensUtiles;

  const indexMotMetier = tokensRetenus.findIndex((t) => MOTS_METIER.has(t));
  if (indexMotMetier > 0) {
    const [mot] = tokensRetenus.splice(indexMotMetier, 1);
    tokensRetenus.unshift(mot);
  }

  return mettreEnFormeLisible(tokensRetenus);
}

export function detecterChargesRecurrentes(transactions: NormalizedBankTransaction[]): RecurringChargeCandidate[] {
  // Les charges récurrentes ne sont recherchées que parmi les débits (montants négatifs).
  const debits = transactions.filter((t) => t.signedAmount < 0 && t.labelNormalized);

  const statistiquesTokens = calculerStatistiquesTokens(debits.map((t) => t.labelNormalized));

  const groupes = new Map<string, NormalizedBankTransaction[]>();
  for (const transaction of debits) {
    const cle = signatureIdentite(transaction.labelNormalized, statistiquesTokens);
    if (!cle) continue;
    const liste = groupes.get(cle) ?? [];
    liste.push(transaction);
    groupes.set(cle, liste);
  }

  const candidats: RecurringChargeCandidate[] = [];

  for (const [cle, occurrencesBrutes] of groupes) {
    if (occurrencesBrutes.length < OCCURRENCES_MINIMUM) continue;

    const triees = [...occurrencesBrutes].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const dates = triees.map((t) => t.date);

    const frequence = detecterFrequence(dates);
    if (!frequence) continue;

    // Le montant ne conditionne plus l'existence du candidat (identité + cadence suffisent) : il
    // qualifie seulement le profil affiché à l'utilisateur ("stable" vs "variable"), en réutilisant
    // la même tolérance max(5 €, 5 %) qu'auparavant — mais comme label, jamais comme filtre.
    const montants = triees.map((t) => Math.abs(t.signedAmount));
    const montantMedian = mediane(montants);
    const tolerance = toleranceMontant(montantMedian);
    const profilMontant: ProfilMontant = montants.every((m) => Math.abs(m - montantMedian) <= tolerance)
      ? "stable"
      : "variable";

    const derniereOccurrence = dates[dates.length - 1];
    const prochaineOccurrenceEstimee = toISODate(
      frequence === "hebdomadaire"
        ? ajouterJours(parseDateISO(derniereOccurrence), 7)
        : ajouterMois(parseDateISO(derniereOccurrence), 1)
    );

    // Jamais le libellé bancaire brut : libellé métier dérivé des occurrences, avec repli sur la
    // signature d'identité (déjà propre) plutôt que sur labelOriginal si rien n'est assez stable —
    // et sur un libellé neutre si même la signature d'identité s'avère entièrement technique.
    const tokensIdentite = cle.split(" ");
    const libellePropose =
      construireLibelleMetier(triees, statistiquesTokens) ??
      (tokensIdentite.every((t) => ressembleReferenceTechnique(t))
        ? LIBELLE_NEUTRE_PAR_DEFAUT
        : mettreEnFormeLisible(tokensIdentite));

    candidats.push({
      id: cle,
      libellePropose,
      // Médiane pour stable ET variable : règle unique, simple et explicite (pas de prévision
      // statistique) — robuste aux anomalies ponctuelles, toujours modifiable par l'utilisateur.
      montantPropose: montantMedian,
      profilMontant,
      frequence,
      derniereOccurrence,
      prochaineOccurrenceEstimee,
      nombreOccurrences: triees.length,
      montantMin: Math.min(...montants),
      montantMax: Math.max(...montants),
      occurrences: triees.map((t) => ({ date: t.date, montant: Math.abs(t.signedAmount) })),
    });
  }

  return candidats.sort(
    (a, b) => b.nombreOccurrences - a.nombreOccurrences || a.libellePropose.localeCompare(b.libellePropose)
  );
}

/**
 * Tri purement VISUEL pour l'écran de validation — n'est jamais appelé par detecterChargesRecurrentes
 * ci-dessus et ne change donc rien au moteur de détection ni à ses règles (l'ordre interne du moteur,
 * par nombre d'occurrences, reste inchangé et continue de déterminer l'ordre "id" stable). Montant
 * proposé décroissant ; à égalité, libellé proposé par ordre alphabétique. Ne mute jamais le tableau
 * reçu.
 */
export function trierCandidatsPourAffichage(candidats: RecurringChargeCandidate[]): RecurringChargeCandidate[] {
  return [...candidats].sort(
    (a, b) => b.montantPropose - a.montantPropose || a.libellePropose.localeCompare(b.libellePropose)
  );
}
