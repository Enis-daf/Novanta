/**
 * Regroupements MANUELS de flux pour l'Analyse d'écarts : l'utilisateur réunit des flux que le
 * moteur (lib/flowMatching.ts) tient pour distincts. C'est une surcouche — le moteur, ses
 * identités et ses rapprochements automatiques ne changent pas.
 *
 * Résolution d'une transaction : libellé -> identité propre -> groupe manuel éventuel -> nom
 * affiché. Un groupe manuel réunit des identités propres (les mêmes clés que les alias) ; il a
 * priorité sur le rapprochement automatique et sur les alias individuels, qui sont conservés et
 * reprennent effet si le flux quitte le groupe.
 *
 * Fonctions pures : elles calculent l'état suivant ; l'enregistrement est dans
 * lib/pastTransactionsRepository.ts.
 */

export interface MembreGroupe {
  cle: string; // identité propre du flux (lib/flowMatching.ts::aliasFlowKey)
  nomDetecte: string;
  exemple: string; // un libellé bancaire du flux, pour recalculer la clé si le moteur évolue
}

export interface GroupeManuel {
  id: string;
  nom: string;
  membres: MembreGroupe[];
}

/** Identité propre -> groupe manuel qui la contient. */
export function indexerGroupesManuels(groupes: GroupeManuel[]): Map<string, { id: string; nom: string }> {
  const index = new Map<string, { id: string; nom: string }>();
  for (const groupe of groupes) for (const membre of groupe.membres) index.set(membre.cle, { id: groupe.id, nom: groupe.nom });
  return index;
}

export interface ResultatFusion {
  groupes: GroupeManuel[];
  // Le groupe qui réunit désormais tous les flux concernés.
  groupe: GroupeManuel;
  // Groupes absorbés par la fusion : à supprimer.
  supprimes: string[];
}

/**
 * Réunit des flux en un seul groupe. Si certains appartiennent déjà à des groupes, ces groupes
 * sont réunis eux aussi (un flux n'appartient qu'à un groupe à la fois) : le premier rencontré est
 * conservé, les autres sont absorbés. Sans groupe existant, un nouveau est créé sous `nouvelId`.
 */
export function fusionnerFlux(groupes: GroupeManuel[], flux: MembreGroupe[], nom: string, nouvelId: string): ResultatFusion {
  const cles = new Set(flux.map((f) => f.cle));
  const concernes = groupes.filter((g) => g.membres.some((m) => cles.has(m.cle)));
  const id = concernes[0]?.id ?? nouvelId;
  const membres = new Map<string, MembreGroupe>();
  for (const membre of [...concernes.flatMap((g) => g.membres), ...flux]) membres.set(membre.cle, membre);
  const groupe: GroupeManuel = { id, nom, membres: [...membres.values()] };
  const absorbes = new Set(concernes.map((g) => g.id));
  return {
    groupes: [...groupes.filter((g) => !absorbes.has(g.id)), groupe],
    groupe,
    supprimes: concernes.slice(1).map((g) => g.id),
  };
}

export interface ResultatDissociation {
  groupes: GroupeManuel[];
  // Renseigné quand le groupe disparaît : il ne lui restait qu'un membre, qui redevient un flux
  // individuel — on ne garde pas de groupe artificiel à un seul élément.
  groupeSupprime: string | null;
}

/** Retire un flux de son groupe manuel ; il redevient un flux indépendant. */
export function dissocierFlux(groupes: GroupeManuel[], cle: string): ResultatDissociation {
  const groupe = groupes.find((g) => g.membres.some((m) => m.cle === cle));
  if (!groupe) return { groupes, groupeSupprime: null };
  const restants = groupe.membres.filter((m) => m.cle !== cle);
  if (restants.length < 2) return { groupes: groupes.filter((g) => g.id !== groupe.id), groupeSupprime: groupe.id };
  return { groupes: groupes.map((g) => (g.id === groupe.id ? { ...g, membres: restants } : g)), groupeSupprime: null };
}

const LONGUEUR_MIN_MOT_COMMUN = 3;

/**
 * Nom proposé pour un groupe : les mots communs à tous les noms réunis (« Pisp Bridg Karmen » et
 * « Fct Karmen Factor » -> « Karmen »), sinon le premier nom. Simple proposition, modifiable.
 */
export function nomDeGroupePropose(noms: string[]): string {
  const [premier, ...autres] = noms;
  if (premier === undefined) return "";
  const mots = (nom: string) => nom.split(/\s+/).filter((mot) => mot.length >= LONGUEUR_MIN_MOT_COMMUN);
  const communs = mots(premier).filter((mot) => autres.every((autre) => mots(autre).some((m) => m.toLocaleLowerCase("fr") === mot.toLocaleLowerCase("fr"))));
  return autres.length > 0 && communs.length > 0 ? communs.join(" ") : premier;
}
