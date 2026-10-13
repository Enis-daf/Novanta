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

## Utilisation : deux modes Pennylane, choisis par la commande de lancement

Le bandeau en haut de l'application indique toujours le mode en cours :
« QANNT TEST — STAGING · Pennylane réel » ou « · Pennylane mock ».

### Pennylane réel — `npm run dev:staging`

L'application (http://localhost:3001) appelle la vraie API Pennylane, comme en production.

1. Se connecter avec l'utilisateur de test.
2. En haut à droite : bouton **Intégrations** (page `/account/integrations`).
3. Carte **Pennylane** → **Connecter Pennylane** → coller le token dans « Token API Pennylane » →
   **Connecter et tester**.

Le token est testé contre Pennylane, puis stocké chiffré dans la base STAGING, avec la clé de
chiffrement du staging. La synchronisation n'écrit que dans la société QANNT TEST. Un token en
lecture seule suffit ; idéalement un token dédié au staging, révocable séparément.

### Pennylane mock — `npm run dev:staging:mock`

Scénarios déterministes à données synthétiques (cycles 1 à 3). Lancer aussi, dans un autre
terminal, `npm run staging:mock`. N'importe quel jeton est accepté dans Intégrations.
Changer de cycle : `curl -X POST http://localhost:4010/__mock/cycle/2`

Un token enregistré dans un mode n'est pas valable dans l'autre : après un changement de mode,
remplacer le token dans Intégrations. `PENNYLANE_API_BASE_URL` ne se règle pas dans
`.env.staging.local` : c'est la commande de lancement qui décide.

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

Prérequis : mode mock (`npm run staging:mock` dans un terminal, `npm run dev:staging:mock` dans un
autre) et données synthétiques (`npm run staging:seed -- --synthetique --remplacer`). Se connecter
avec l'utilisateur de test, puis bouton Intégrations → Pennylane → connecter avec un jeton quelconque.

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
