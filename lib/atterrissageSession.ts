// Point d'entrée d'une session : toute nouvelle session arrive sur Passé, quelle que soit l'offre.
//
// Le formulaire de connexion s'affiche sur la route où l'on se trouve, et `/` est la route de Futur :
// sans cette règle, une connexion ou une réouverture du navigateur arrivait sur Futur (verrouillé
// en Essentiel). Une « session de navigation » est l'onglet (sessionStorage) : marquée dès qu'une
// session Supabase est présente sur le cockpit, effacée à la déconnexion. Tant qu'elle est marquée,
// `/` reste Futur : navigation, retour depuis Abonnement ou Stripe, rafraîchissement inchangés.
// Le choix ne dépend jamais de l'offre ; le verrouillage de Futur reste celui des droits.

const CLE = "novanta.session-navigation";

type Stockage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function stockageNavigateur(): Stockage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

// Marque la session de navigation et dit si c'est son entrée, c'est-à-dire si `/` doit renvoyer
// vers Passé. Stockage illisible (navigation privée stricte) : on n'a aucun moyen de reconnaître
// une session en cours, donc pas de redirection — jamais de boucle, Futur reste accessible.
export function entrerDansLaSession(stockage: Stockage | null = stockageNavigateur()): boolean {
  if (!stockage) return false;
  try {
    if (stockage.getItem(CLE)) return false;
    stockage.setItem(CLE, "1");
    return true;
  } catch {
    return false;
  }
}

// Déconnexion : la prochaine connexion est une nouvelle session, donc arrive sur Passé.
export function quitterLaSession(stockage: Stockage | null = stockageNavigateur()): void {
  try {
    stockage?.removeItem(CLE);
  } catch {
    // Rien à faire : au pire la prochaine connexion de cet onglet restera sur la route courante.
  }
}
