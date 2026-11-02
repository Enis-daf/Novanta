# Reprise du chantier Cash / Compta / FEC

**Statut : suspendu, ni abandonné ni livré.** Reprise dès que des données comptables fiables seront disponibles.

- Branche : `feature/pnl-cash-estime-compta`, jamais fusionnée dans `main`.
- Dernier commit fonctionnel : `19014be`. Le commit suivant n'ajoute que ce document.
- Worktree local : `.worktrees/pnl-compta`.
- Attention : la branche contient aussi offres, revenu récurrent et Action. La fusionner les livre tous.

## Ce qui est développé

Tout est derrière des drapeaux, éteints par défaut.

| Fonctionnalité | Fichiers principaux | Drapeau |
|---|---|---|
| P&L cash (HT estimé) | `lib/pastPnlCashEstime.ts` | `NEXT_PUBLIC_NOVANTA_PNL_CASH_ESTIME` |
| P&L comptable, correspondance, comparaison | `lib/comptaPnl.ts`, `components/PasseCompta.tsx` | `NEXT_PUBLIC_NOVANTA_PNL_COMPTABLE` |
| Synchronisation de la balance Pennylane | `lib/comptaServeur.ts`, `app/api/passe/compta/` | `NOVANTA_COMPTA_SYNC_REELLE` |
| Import FEC et source unique par mois | `lib/fecParseur.ts`, `lib/comptaSources.ts` | P&L comptable |
| Ajustements (stocks, dotations, cut-offs) | `lib/comptaStocks.ts` | P&L comptable |
| Page de démonstration sans base | `app/demo/pnl/page.tsx` | `NEXT_PUBLIC_NOVANTA_DEMO_PNL` |

Détails : `docs/import-fec.md` et `docs/pnl-comptable-pennylane.md`.

## Migrations

| Fichier | État en production |
|---|---|
| `20261030_accounting_pnl.sql` | Exécutée, vérification conforme |
| `20261031_accounting_monthly_balances.sql` | Exécutée, vérification conforme |
| `20261101_accounting_sync_runs_adjustments.sql` | Exécutée, vérification conforme |
| `20261102_accounting_fec_imports.sql` | **Inconnu : à vérifier avant tout test sur base réelle** |
| `20261027`, `20261028` (2 fichiers), `20261029` | Hors chantier comptable (Action, offres, récurrence) : à vérifier avant toute fusion |

La requête de contrôle de `20261102` compte les 2 tables, les 2 fonctions et les colonnes ajoutées. Le fichier peut être rejoué sans risque. Preview et production partagent la même base.

## Résultats des tests

Au commit `19014be` :

- `npm test` : 1799 réussis, 0 échec.
- `tsc` : aucune erreur.
- Migrations sous PGlite : conformes.
- Build : réussi sur Vercel, en Preview.

## Ce qui fonctionne, et sur quelles données

| Vérifié sur | Périmètre |
|---|---|
| **Données réelles** | Un FEC d'un exercice (4 199 lignes, version déjà retraitée, pas un export brut) : lecture, balances, P&L et écran de démonstration. Résultat identique au centime à un recalcul indépendant, et jugé correct à l'écran par Enis. Non rapproché de la liasse, par décision : Novanta est un outil de pilotage. |
| **Données réelles** | API Pennylane en lecture, sur un seul dossier jeune, sans clôture ; données jugées inexploitables pour un P&L. |
| **Données réelles** | Écrans du P&L comptable et règles de correspondance sur le Compte démo. |
| **Synthétiques seulement** | Plusieurs exercices FEC à la suite, comparaison entre exercices, conflit FEC / API, remplacement et retrait d'un import, arbitrages de stocks et de dotations, cut-offs, fichier de 500 000 lignes. |
| **PGlite seulement** | Fonctions SQL d'import et de retrait, verrou, isolation entre sociétés, droits d'accès. |
| **Jamais exécuté** | `POST /api/passe/compta/fec` contre Supabase, lancement d'une synchronisation par le produit sur un dossier réel exploitable. |

Sur le Preview, l'ordre des sélecteurs et le BFR avec réserves n'ont pas été confirmés à l'écran.

## Incomplet

- La période couverte d'un cut-off est stockée et validée, mais le formulaire ne la propose pas.
- Le rapport PDF ne couvre pas le P&L comptable.
- La comparaison porte sur des exercices entiers, pas sur des périodes libres.

## Limites et problèmes connus

- Codes de journaux d'à-nouveau : liste d'usage (`AN`, `RAN`, `ANO`, `AO`…), à confronter à d'autres logiciels.
- Limite de 4,5 Mo de Vercel jamais éprouvée sur un gros import réel.
- Pennylane n'a pas répondu, notamment sur l'usage du token en production (questions dans `docs/pnl-comptable-pennylane.md`). Le statut d'exercice `frozen` reste ambigu.
- Une clé de chiffrement différente entre environnements empêche de lire un token enregistré ailleurs : l'erreur `token_illisible` le signale.
- Arbitrages métier à confirmer : conflit de source non tranché (mois hors calcul), exclusion des écritures de solde, dotations saisies à la main.
- Décision prise : la production immobilisée (72) reste en coûts de structure, comme produit. Cette ligne peut donc être positive.

## Données nécessaires pour terminer la validation

1. **Plusieurs exercices d'un dossier bien tenu, dont au moins un clôturé**, en export brut du logiciel comptable, avec stocks, dotations et, si possible, éléments financiers et exceptionnels.
2. **Un FEC comportant des écritures de solde** (classes 6 et 7 contre le compte 12), pour éprouver l'exclusion et le contrôle du résultat.
3. **Des exports de plusieurs logiciels**, pour les formats et les journaux d'à-nouveau.
4. **Un dossier Pennylane fiable, clôturé, couvrant les mêmes mois qu'un FEC**, pour le conflit réel de source et le bas du P&L par l'API.
5. **Un FEC à fort volume**, pour la limite de Vercel.
6. **Un token autorisé par Pennylane** pour l'usage en production.

Aucun de ces fichiers ne doit entrer dans le dépôt.

## Reprendre sans redévelopper

1. Se placer sur la branche et récupérer `main` :

```bash
git switch feature/pnl-cash-estime-compta
```

```bash
git merge origin/main
```

2. Vérifier :

```bash
npm test
```

```bash
npx tsc --noEmit
```

3. Tester un FEC sans base, dans `/demo/pnl`, scénario « Import FEC seul » (les données restent dans l'onglet) :

```bash
NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY= SUPABASE_SERVICE_ROLE_KEY= NEXT_PUBLIC_NOVANTA_DEMO_PNL=1 NEXT_PUBLIC_NOVANTA_PNL_CASH_ESTIME=1 NEXT_PUBLIC_NOVANTA_PNL_COMPTABLE=1 npx next dev -p 3007
```

4. Pour la vraie route d'import : vérifier ou passer `20261102`, poser `NEXT_PUBLIC_NOVANTA_PNL_COMPTABLE=1` sur le seul environnement Preview, redéployer, tester sur le Compte démo en offre Pilotage.

Toute donnée importée sur un Preview est écrite dans la base de production.
