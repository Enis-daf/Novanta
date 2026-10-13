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

`npm run staging:schema -- --executer --reset`, puis `npm run staging:seed -- --synthetique`.

## Cloner les données réelles (module Futur)

`scripts/staging/export-qannt.sql` est un SELECT en lecture seule à exécuter sur la base d'origine ;
son résultat va dans `.staging/qannt-export.json` (dossier ignoré par Git). Le fichier peut être
l'objet JSON lui-même ou la ligne `{ "export": ... }` telle que la restitue l'éditeur Supabase.

- Contrôler le fichier sans toucher à la base :
  `npm run staging:seed -- --export .staging/qannt-export.json --verifier-export`
- Importer : `npm run staging:seed -- --export .staging/qannt-export.json --remplacer`

`--remplacer` remplace les données de la société QANNT TEST en place, dans une seule transaction :
la société, son utilisateur et sa connexion Pennylane sont conservés.

Les données métier sont importées telles quelles (noms de clients et de fournisseurs, libellés,
numéros de factures, montants, dates, statuts) : seuls les identifiants techniques sont régénérés
(voir `exportReel.ts`). Aucune anonymisation — le fichier d'export et la base staging contiennent
donc des données réelles. Les tables du module Passé (`past_*`) ne sont ni exportées ni importées.

`schema.sql` n'est joué que sur une base jamais initialisée. Il ne se rejoue jamais sur une base existante.

## Checklist de test — QANNT TEST

Prérequis : `npm run staging:mock` dans un terminal, `PENNYLANE_API_BASE_URL=http://localhost:4010`
dans `.env.staging.local`, puis `npm run dev:staging`. Se connecter avec l'utilisateur de test, puis
Compte → Intégrations → connecter Pennylane avec n'importe quel jeton (le mock les accepte tous).

Cycle 1 (état initial du mock)
1. Synchroniser Pennylane → 6 factures fournisseurs importées sur 237 analysées (pagination).
2. Recharger la page → les factures sont toujours là.
3. Resynchroniser sans rien changer → 0 nouvelle, aucun doublon, mêmes propositions.
5. La facture VIEUX FOURNISSEUR de 2023 impayée (450 €) est importée.
6. Celle de 2023 déjà payée (380 €) ne l'est pas.
7. La facture SANS ECHEANCE SARL est importée sans date, et n'est jamais proposée.
9. « Doublons potentiels détectés » : CROCATUS 1 990 € face à « DAF part-time » 2 000 €.
10. Confirmer → plus de sortie le 5, sortie de 1 990 € le 28 ; « Commission sur DAF » passe à 199 €.
13. FIDUCIA 590 € face à « Expert-comptable » → « Ce n'est pas la même dépense » : projection
    inchangée, plus jamais reproposé.
14. IMMO GESTION 1 500 € : deux loyers possibles, rien de présélectionné, rien de neutralisé.
    ASSURIX 1 100 € n'est pas proposée (hors seuil) → « Rapprocher à une charge fixe » → Assurance.

Cycle 2 — `curl -X POST http://localhost:4010/__mock/cycle/2`, puis synchroniser
4. La facture CROCATUS passe Payée dans Novanta.
11. L'occurrence « DAF part-time » du mois ne revient pas ; la commission reste à 199 €.

Cycle 3 — `curl -X POST http://localhost:4010/__mock/cycle/3`, puis synchroniser
12. Le mois suivant, « DAF part-time » compte 2 000 € tant que rien n'est confirmé.
    CROCATUS 1 995 € est proposée en premier (« Fournisseur déjà rapproché de cette charge ») ;
    AUTRE CONSEIL 2 000 € n'est pas proposée sur cette occurrence.
    La facture ASSURIX archivée est retirée : « Rapprochements à revoir », l'occurrence reste
    remplacée ; sa nouvelle version (AX-2026-10-B) est proposée sur la même occurrence.
15. Resynchroniser plusieurs fois → état stable, aucun rapprochement en double.
8. Pagination : visible dans le terminal du mock (3 pages par synchronisation).

Aucune écriture hors staging : le bandeau « QANNT TEST — STAGING » doit rester affiché, et
`npm run staging:verifier` doit rester entièrement OK.
