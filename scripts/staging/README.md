# Environnement de test isolé — QANNT TEST

Base Supabase dédiée, jamais partagée avec la Production. Tout passe par `.env.staging.local`
(ignoré par Git) et par le garde-fou `lib/environnementGuard.ts` : l'application et les scripts
refusent de se connecter à un autre projet que le staging déclaré.

## Mise en place (une fois)

1. Créer un projet Supabase vide dédié au staging.
2. Dans ce projet : Authentication → Add user (utilisateur de test, confirmé).
3. Copier `.env.staging.local.example` vers `.env.staging.local` et le renseigner.
4. `npm run staging:schema` — affiche le plan (projet ciblé, fichiers), n'exécute rien.
5. `npm run staging:schema -- --executer` — `schema.sql` sur base vide, puis toutes les migrations.
6. `npm run staging:seed -- --synthetique` — société « QANNT TEST » et Charges fixes de test.
7. `npm run staging:verifier` — schéma, rattachement de la société, RLS.

## Utilisation

- `npm run staging:mock` — serveur mock Pennylane local (données synthétiques, cycles 1 à 3).
- `npm run dev:staging` — application sur http://localhost:3001, bandeau « QANNT TEST — STAGING ».
- Changer de cycle : `curl -X POST http://localhost:4010/__mock/cycle/2`

## Repartir de zéro

`npm run staging:schema -- --executer --reset`, puis `npm run staging:seed -- --synthetique --remplacer`.

## Cloner les données réelles (optionnel)

`scripts/staging/export-qannt.sql` est un SELECT en lecture seule à exécuter sur la base d'origine ;
son résultat va dans `.staging/qannt-export.json` (ignoré par Git), puis
`npm run staging:seed -- --export .staging/qannt-export.json --remplacer`.

`schema.sql` n'est joué que sur une base jamais initialisée. Il ne se rejoue jamais sur une base existante.
