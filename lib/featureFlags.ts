// Drapeaux de fonctionnalités, lus au build (NEXT_PUBLIC_*) : éteints tant que la variable ne vaut pas "1".

/**
 * Module Action : invisible (pas de bouton de navigation) et inaccessible (la page renvoie vers
 * Futur) tant qu'il n'est pas activé. Exige les migrations 20261027_action_initiatives.sql et
 * 20261028_action_closing_snapshot.sql.
 */
export function moduleActionActif(): boolean {
  return process.env.NEXT_PUBLIC_NOVANTA_MODULE_ACTION === "1";
}
