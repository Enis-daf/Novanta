/**
 * Étape « factures et règlements » de l'unique bouton « Synchroniser Pennylane » du module Passé,
 * côté navigateur. Deux étapes serveur (voir app/api/passe/bfr/route.ts) : les factures, puis la
 * datation des règlements, rappelée tant qu'il en reste. `onEtape` dit l'étape réellement en cours ;
 * le compteur n'apparaît que lorsque le serveur a donné le nombre de factures à dater.
 */

export const MAX_APPELS_SYNCHRO = 40;
const MESSAGE_ECHEC = "La synchronisation des factures Pennylane a échoué. Réessayez.";

export type ResultatSynchroFactures =
  // L'offre de l'organisation n'inclut pas le BFR : rien à synchroniser, ce n'est pas une erreur.
  | { statut: "hors_offre" }
  | { statut: "termine"; factures: number; listeComplete: boolean; restantes: number };

export async function synchroniserFacturesBfr(
  accessToken: string,
  onEtape: (message: string) => void,
  envoyer: typeof fetch = fetch,
  synchro: string = crypto.randomUUID()
): Promise<ResultatSynchroFactures> {
  class HorsOffre extends Error {}
  const appeler = async (etape: "factures" | "reglements") => {
    const res = await envoyer("/api/passe/bfr", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ etape, synchro }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && data.code === "offre_requise") throw new HorsOffre();
    if (!res.ok) throw new Error(data.error || MESSAGE_ECHEC);
    return data;
  };
  try {
    onEtape("Récupération des factures Pennylane…");
    const factures = await appeler("factures");
    let restantes: number = factures.aDater ?? 0;
    // Un lot interrompu sans aucune facture datée (Pennylane indisponible) : deux de suite, et la
    // synchronisation s'arrête — ce qui est daté reste acquis, une relance reprendra.
    let lotsVides = 0;
    for (let appel = 0; restantes > 0 && appel < MAX_APPELS_SYNCHRO && lotsVides < 2; appel++) {
      onEtape(`Récupération des règlements : ${restantes} factures à dater…`);
      const lot = await appeler("reglements");
      restantes = lot.restantes ?? 0;
      lotsVides = lot.datees > 0 ? 0 : lotsVides + 1;
    }
    return { statut: "termine", factures: factures.factures ?? 0, listeComplete: factures.complete !== false, restantes };
  } catch (e) {
    if (e instanceof HorsOffre) return { statut: "hors_offre" };
    throw e;
  }
}
