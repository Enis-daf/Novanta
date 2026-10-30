# Import FEC : historique comptable sans appel à Pennylane

Réservé aux offres qui ont `canViewAccountingPnl` (Pilotage, et essai actif). Le P&L cash estimé, sa correspondance bancaire et les prévisions ne lisent rien de ce module.

## Parcours

Importer → exercices détectés → contrôles → comptes sans correspondance → P&L historique → comparer les exercices.

## Ce qui part au serveur

Le fichier est lu dans le navigateur, par morceaux. Seules les balances mensuelles par compte et les libellés de comptes partent au serveur (`POST /api/passe/compta/fec`), qui les contrôle de nouveau. Le FEC brut et ses écritures ne sont jamais envoyés ni stockés.

Limites : 500 Mo par fichier, 60 000 lignes de balance par import. Le corps de requête reste sous la limite de Vercel (4,5 Mo) sur les volumes testés, jamais vérifié sur Vercel lui-même.

## Format

Article A. 47 A-1 du LPF : 18 champs, Debit/Credit ou Montant/Sens (D/C ou +1/-1), tabulation ou `|`, ASCII, ISO 8859-15 ou UTF-8, dates AAAAMMJJ, virgule décimale, signe en premier ou en dernier caractère, nom `SirenFECAAAAMMJJ`.

Rien n'est corrigé. Une ligne illisible ou un fichier déséquilibré bloque l'import. Les écarts sans ambiguïté sont acceptés et signalés. Une anomalie porte des compteurs et des numéros de ligne, jamais de valeur comptable.

## Traitement comptable

- Une écriture reste sur le mois où elle est passée : une dotation annuelle reste en décembre, jamais répartie.
- Les écritures de solde (classes 6 et 7 contre le compte 12 seul) sont écartées et signalées. Le résultat reconstitué est contrôlé contre le compte 12.
- Les à-nouveaux sont repérés par le code journal ou le libellé ; sur un compte de résultat, ils entrent dans le P&L et sont signalés.
- Clôture : indiquée par l'utilisateur à l'import, jamais déduite de l'âge de l'exercice.
- Mêmes correspondances et même moteur que Pennylane (`lib/comptaPnl.ts`). Réimporter conserve les correspondances et les ajustements.

## Une source par mois

Un mois n'est lu que depuis une source. Aucune n'est prioritaire par principe : ni le FEC, ni l'API. Sans décision, les mois en conflit restent hors du calcul, le P&L est marqué incomplet et ses sous-totaux affichent « Incomplet ». Le choix est conservé par période et réversible.

Réimport identique (même empreinte) : rien ne change. Chevauchement d'un autre import : refus, sauf remplacement demandé explicitement. L'import est atomique et une seule opération à la fois passe par société (verrou consultatif).

## Ajustements de gestion

Compléments de pilotage, jamais d'écriture : Novanta n'écrit aucune OD.

| Élément | Règle |
|---|---|
| Stocks | Une source par exercice, arbitrage conservé |
| Dotations estimées | Une source par exercice, arbitrage conservé. Montant saisi, jamais calculé ni réparti automatiquement |
| Cut-offs | Appliqués sur le mois saisi, ligne du P&L choisie par l'utilisateur. Signalés « à vérifier » sur un exercice clôturé. Jamais déduits d'un numéro de compte |

## Sécurité

`exigerAccesCompta` : session, société et droit d'offre vérifiés côté serveur. RLS sans policy, aucun droit pour `anon` et `authenticated`. Journaux : compteurs et codes d'erreur seulement. Aucun fichier temporaire serveur, puisque le fichier n'y arrive pas.

## Pour activer sur un environnement isolé

Passer `supabase/migrations/20261102_accounting_fec_imports.sql` après les trois migrations comptables. Les Preview partagent la base de production. Vérification sans base distante :

```bash
PGLITE_PATH=/chemin/vers/@electric-sql/pglite/dist/index.js node scripts/migrations/verifierMigrationComptable.mjs
```

## Essayer sans base

Le parseur et l'assemblage sont les vrais, les données restent en mémoire dans l'onglet :

```bash
NEXT_PUBLIC_NOVANTA_DEMO_PNL=1 npx next dev -p 3007
```

Puis `http://localhost:3007/demo/pnl`, scénario « Import FEC seul ». Les routes `/api/passe/compta*` ne sont pas appelées sur cette page.

## Non vérifié

- Aucun FEC réel : uniquement des fichiers synthétiques, dont un de 500 000 lignes.
- Route `POST /api/passe/compta/fec` jamais exécutée contre Supabase : la migration n'est appliquée nulle part hors PGlite.
- Exports d'autres logiciels que ceux simulés par les fixtures.
- Codes de journaux d'à-nouveau : liste observée dans les usages (`AN`, `RAN`, `ANO`, `AO`…), à confronter à de vrais fichiers.
