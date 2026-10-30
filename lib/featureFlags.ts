// Activation progressive de l'évolution « P&L cash estimé / P&L comptable ». Tout est éteint par
// défaut : sans variable, le produit se comporte exactement comme avant, en Production comme
// ailleurs. Les accès réservés à une offre restent décidés par lib/offres.ts : un drapeau ne donne
// jamais un droit, il rend seulement une fonctionnalité disponible pour ceux qui l'ont déjà.
//
// Les noms complets sont écrits en toutes lettres : Next.js ne remplace NEXT_PUBLIC_* côté navigateur
// que pour un accès littéral à process.env.

/** Nouvelle présentation du reporting : HT estimé seul, arrêtée au Solde de gestion estimé. */
export function pnlCashEstimeActif(): boolean {
  return process.env.NEXT_PUBLIC_NOVANTA_PNL_CASH_ESTIME === "1";
}

/** P&L comptable et correspondance comptable (offre Pilotage). */
export function pnlComptableActif(): boolean {
  return process.env.NEXT_PUBLIC_NOVANTA_PNL_COMPTABLE === "1";
}

/** Module Action, intégré à cette branche : invisible et inaccessible tant qu'il n'est pas activé. */
export function moduleActionActif(): boolean {
  return process.env.NEXT_PUBLIC_NOVANTA_MODULE_ACTION === "1";
}

/**
 * SERVEUR UNIQUEMENT. Lecture réelle du plan de comptes et de la balance Pennylane. Reste éteinte tant
 * que Pennylane n'a pas répondu sur l'usage du token en production (docs/pnl-comptable-pennylane.md).
 */
export function synchroComptableReelleActive(): boolean {
  return process.env.NOVANTA_COMPTA_SYNC_REELLE === "1";
}
