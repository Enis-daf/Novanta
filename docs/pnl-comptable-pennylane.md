# P&L comptable : ce qui est vérifié chez Pennylane, et ce qui ne l'est pas

Aucun appel n'a été fait à l'API comptable de Pennylane, ni avec un vrai token, ni sur une société réelle. La source réelle (`lib/comptaPennylaneAdapter.ts`) existe mais reste éteinte (`NOVANTA_COMPTA_SYNC_REELLE`). Tout ce qui est calculé aujourd'hui l'est sur des données simulées (`lib/comptaFixtures.ts`).

## Lu dans la documentation officielle (pennylane.readme.io, 30/10/2026)

Lecture de documentation seulement : rien de ce tableau n'a été observé sur une réponse réelle.

| Sujet | `GET /api/external/v2/ledger_entry_lines` | `GET /api/external/v2/ledger_accounts` |
|---|---|---|
| Scope indiqué | `ledger_entries:readonly` ou `ledger_entries:all` | `ledger_accounts:readonly` ou `ledger_accounts:all` |
| Pagination | curseur : `cursor`, `limit` de 1 à 100, `has_more`, `next_cursor` | curseur : `cursor`, `limit` de 1 à 1000 |
| Filtres | `id`, `journal_id`, `ledger_account_id`, `ledger_entry_id`, `date` | `id`, `number`, `enabled` |
| Champs utilisés | `id`, `debit`, `credit`, `label`, `date`, `ledger_account.number`, `ledger_entry.id`, `journal.id`, `created_at`, `updated_at` | `id`, `number`, `label`, `type`, `enabled` |

Existe aussi `GET /api/external/v2/trial_balance` (`period_start`, `period_end`, `debits` et `credits` par compte). Non utilisé : il ne donne pas le détail nécessaire à l'exclusion de lignes ni le mois de chaque montant sur une période longue. Il pourrait servir de contrôle de cohérence.

## Incohérences relevées dans la documentation

- Chaque page annonce un scope propre, alors que son schéma de sécurité et son message 403 ne citent que `ledger`.
- La page `ledger_accounts` place `next_cursor` tantôt dans `metadata`, tantôt à la racine de la réponse. L'adaptateur suit le schéma (racine), comme les autres listes déjà utilisées.

## Questions à poser à Pennylane

1. Un Company API Token peut-il lire `ledger_entry_lines` et `ledger_accounts` sur un abonnement Essentiel ? Quel scope exact faut-il cocher : `ledger`, `ledger_entries:readonly`, `ledger_accounts:readonly` ?
2. Les lignes renvoyées comprennent-elles des écritures provisoires, en brouillon ou non validées ? La documentation ne décrit aucun statut. Comment les distinguer ?
3. Une écriture supprimée ou annulée disparaît-elle de la liste ? Existe-t-il un moyen d'être informé d'une suppression ?
4. Un filtre sur `updated_at` existe-t-il ? La documentation n'en décrit aucun sur les lignes. Sans lui, la synchronisation relit toute la période, mois par mois, et c'est ce qui est développé.
5. Quelles limites s'appliquent à ces routes (25 requêtes par 5 secondes comme ailleurs ?) et sur quel volume d'historique ?
6. `ledger_account.number` est-il bien le numéro complet du plan de comptes (par exemple `607000`) ?
7. Le signe de `debit` et `credit` : toujours positif, y compris sur une extourne ?
8. Les périodes clôturées sont-elles lisibles sans restriction ?

## Ce qui change selon les réponses

- Statut disponible (question 2) : le renseigner dans `depuisLigneBrute` (`statutSource`, `exclue`). Le moteur l'exclut déjà, et c'est testé.
- Suppressions signalées (question 3) : remplacer la relecture complète par une lecture incrémentale.
- Droits refusés sur Essentiel (question 1) : la route remonte déjà « Le token Pennylane n'a pas accès aux écritures comptables » ; le P&L cash estimé reste intact.

## Pour activer sur un environnement isolé

1. Passer `supabase/migrations/20261030_accounting_pnl.sql`. Attention : les Preview partagent la base de production.
2. Poser `NEXT_PUBLIC_NOVANTA_PNL_COMPTABLE=1`.
3. Avec un token de test autorisé, poser `NOVANTA_COMPTA_SYNC_REELLE=1` et lire un seul mois.

Vérifier la migration sur un Postgres jetable, sans base distante :

```bash
PGLITE_PATH=/chemin/vers/@electric-sql/pglite/dist/index.js node scripts/migrations/verifierMigrationComptable.mjs
```
