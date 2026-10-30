# P&L comptable : ce qui est vérifié chez Pennylane

Décision du 30/10/2026 : **le P&L comptable se fonde sur la balance mensuelle** (`trial_balance`), pas sur une copie des lignes d'écriture.

La lecture réelle reste éteinte dans le produit (`NOVANTA_COMPTA_SYNC_REELLE`). Pennylane n'a pas encore répondu aux questions ci-dessous. L'historique peut aussi venir d'un FEC, sans appel à l'API : voir `docs/import-fec.md`.

## Diagnostic réel du 30/10/2026

Lecture seule (GET), avec un Company API Token, sur **un seul dossier** : jeune, de faible volume, sans clôture. Aucune réponse brute n'a été conservée. Ce document ne contient que des constats anonymisés.

### Routes

| Route | Résultat | Utilisation par Novanta |
|---|---|---|
| `GET /me` | 200 : dossier, plan comptable, scopes | Diagnostic |
| `GET /ledger_accounts` | 200, `limit` jusqu'à 1000 | Plan de comptes et libellés |
| `GET /trial_balance` | 200, `period_start`, `period_end`, `is_auxiliary` | **Source du P&L** |
| `GET /ledger_entry_lines` | 200, `limit` jusqu'à 100 | Non utilisée |
| `GET /ledger_entries` | 200, porte le `status` | Non utilisée |
| `GET /journals`, `GET /fiscal_years` | 200 | Non utilisées |
| `GET /changelogs/ledger_entry_lines` | 200, environ 28 jours d'historique, 422 au-delà | Non utilisée |

Scopes réellement accordés : `ledger_accounts:readonly`, `ledger_entries:readonly`, `journals:readonly`, `fiscal_years:readonly`, `trial_balance:readonly` (entre autres). Le scope `ledger` cité par la documentation n'apparaît pas. L'API ne renvoie pas l'offre du dossier : l'absence de restriction sur Essentiel repose sur l'indication que le dossier y est abonné.

### Pourquoi la balance

- Lignes contre balance avec auxiliaires, sur un mois : 104 comptes sur 104 exacts au centime.
- Somme de 10 balances mensuelles contre balance de la période : 325 comptes sur 325 exacts, et même résultat net. Les mois s'additionnent donc sans écart.
- 10 mois lus en 4,5 secondes, contre plusieurs dizaines de pages de lignes.
- Les lignes sont réécrites en permanence : 1376 suppressions en 28 jours, dont 1292 dans la même minute qu'une insertion. Une copie obligerait à suivre ces événements, sur une fenêtre de 4 semaines.
- 72 % d'un échantillon de lignes récemment insérées portent sur un mois antérieur : le passé bouge, et relire le mois courant ne suffit pas.

### Conséquences observées, à respecter

- **`is_auxiliary=false` est retenu, et correspond à l'absence du paramètre.** Les comptes de classe 4 sont regroupés sous leur collectif (31 comptes contre 104). Les classes 6 et 7 sont identiques compte par compte avec `true` et `false`, sur trois périodes et 64 comptes.
- **Contrôle de chaque balance reçue :** dernière page atteinte et total des débits égal au total des crédits. Sinon, le mois garde ses chiffres précédents.
- **Le numéro à retenir est `number`,** pas `formatted_number`, qui diffère sur certains comptes.
- **Un même numéro peut exister sous plusieurs identifiants** (41 numéros, surtout en classes 6 et 7). La clé du plan de comptes est le numéro, et il faut dédoublonner avant d'enregistrer.
- **Des numéros alphanumériques existent** (une racine en chiffres, puis des lettres).
- **La balance reprend toutes les écritures, quel que soit leur statut.** Sur le mois testé, tous les produits et charges étaient en `validation_needed`. Le statut ne peut donc pas servir de filtre, et l'écran le dit.
- **Une balance relue peut changer pour un mois passé.** Une référence figée reste figée dans Novanta, jamais recalculée.
- **Exercices :** la documentation liste `open`, `reopen`, `closed` et `frozen`, sans les définir. Tous les exercices observés sont `open`, y compris à venir. Novanta tient seul `closed` pour une clôture ; `frozen` reste lu et signalé comme ambigu. L'âge d'un exercice ne vaut jamais clôture.
- **`ratelimit-reset` est un horodatage,** pas un nombre de secondes.
- **Une écriture peut être datée dans le futur.** Novanta ne lit pas les mois qui n'ont pas commencé.
- **Une période partielle s'élargit à ses mois entiers,** et l'écran le signale.
- **Débit :** limite annoncée de 25 confirmée par les en-têtes `ratelimit-*`.

### Ce que la balance ne donne pas

Pas de nombre de lignes, de statut, de pièce ni de journal. Si un contrôle du non-validé devient nécessaire, il se fera à part, à partir de `ledger_entries`.

## Synchronisation

| Déclenchement | Périmètre |
|---|---|
| Quotidien | Mois en cours et mois précédent |
| Hebdomadaire et manuel | Tous les exercices non clôturés et commencés, de leur début à aujourd'hui |
| Exceptionnel | Un exercice désigné, même clôturé, sur confirmation |

- Une seule entrée de planification (`/api/passe/compta/planifiee`, chaque nuit, protégée par `CRON_SECRET`). Chaque société passe en hebdomadaire si sa dernière lecture complète réussie date de plus de 7 jours : un passage manqué se rattrape le lendemain.
- Un mois est lu, contrôlé, puis remplacé en une transaction (`accounting_replace_month_balance`). Un échec laisse le mois précédent intact.
- Une seule synchronisation à la fois par société (`accounting_sync_begin`). Une exécution interrompue est abandonnée après 10 minutes.
- Mesuré en intégration sur le dossier testé (API réelle, Postgres en mémoire) : 22 mois en 9,5 secondes, 2 mois en 0,6 seconde, résultat identique sur 3 passages.

## Variation de stocks

Une seule source par exercice, jamais la somme. Il y a conflit dès que Pennylane et Novanta portent une variation dans le même exercice, même sur des mois différents, car une écriture annuelle peut couvrir douze saisies mensuelles. L'utilisateur tranche, et son choix est conservé par exercice.

Tant que la comptabilité n'a pas d'écriture de stock, la saisie Novanta s'applique seule. Sans arbitrage en cas de conflit, seule l'écriture de Pennylane est retenue, et le conflit est affiché.

## Non vérifié

Stocks, amortissements, éléments financiers, exceptionnel et impôts : absents du dossier testé (racines 603, 681, 66, 69, 67 et 77). Avoirs et extournes : seulement des indices (lignes en sens inverse, paires de montants opposés), avec des soldes exacts contre la balance. **Il faut un dossier clôturé pour valider le bas du P&L.**

Comportement à fort volume : inconnu. La documentation Pennylane signale des risques de timeout sur la relecture des lignes, pas sur la balance.

## Questions à poser à Pennylane

1. Les Company API Tokens sont-ils autorisés pour un usage en production multi-clients, ou OAuth est-il requis ? À vérifier dans la documentation source : un résumé de recherche l'évoquait.
2. Que signifient exactement `accounting_needed` et `validation_needed` ? Une écriture `draft` entre-t-elle dans la balance ?
3. Pourquoi des lignes sont-elles réécrites, et un même numéro peut-il rester durablement sous plusieurs identifiants ?
4. Que signifient exactement les statuts d'exercice `open`, `reopen`, `closed` et `frozen` ? Un exercice `closed` peut-il encore changer ?
5. Quelles sont les limites de `trial_balance` à fort volume ?

## Pour activer sur un environnement isolé

1. Passer `supabase/migrations/20261030_accounting_pnl.sql`, puis `20261031_accounting_monthly_balances.sql`, puis `20261101_accounting_sync_runs_adjustments.sql`. Attention : les Preview partagent la base de production.
2. Poser `NEXT_PUBLIC_NOVANTA_PNL_COMPTABLE=1`.
3. Avec un token autorisé, poser `NOVANTA_COMPTA_SYNC_REELLE=1` et lancer une actualisation manuelle.

La planification ne lit rien tant que ces deux variables ne sont pas posées. `CRON_SECRET` est déjà requise par `/api/futur/capture`.

`accounting_entry_lines`, `accounting_balances`, `accounting_sync_state` et `accounting_settings` restent en place, vides et inutilisées.

Vérifier les migrations sur un Postgres jetable, sans base distante :

```bash
PGLITE_PATH=/chemin/vers/@electric-sql/pglite/dist/index.js node scripts/migrations/verifierMigrationComptable.mjs
```
