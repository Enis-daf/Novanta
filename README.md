# Cockpit tactique de trésorerie

MVP Next.js + TypeScript — cockpit de trésorerie à J+90 (dashboard + simulation).

## Démarrage local

```bash
npm install
npm run dev
```

Ouvrir [http://localhost:3000](http://localhost:3000).

Sans configuration Supabase, l'app tourne en **mode local** : données mockées en mémoire, aucune authentification, aucune sauvegarde.

## Configuration Supabase (persistance + authentification)

1. Copier `.env.local.example` vers `.env.local` et renseigner :

   | Variable | Où la trouver |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase Dashboard → Project Settings → API → Project URL (sans `/rest/v1/`) |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase Dashboard → Project Settings → API → clé `anon` / `publishable` (jamais la `service_role`) |

2. Exécuter [supabase/schema.sql](supabase/schema.sql) dans le SQL Editor du projet Supabase (tables + Row Level Security).

3. Redémarrer l'app (`npm run dev` ou redéploiement) — l'écran de connexion apparaît, chaque utilisateur ayant sa propre société (`company_id`) créée automatiquement à sa première connexion.

## Build de production

```bash
npm run build
npm run start
```

## Déploiement sur Vercel

1. Pousser le projet sur un dépôt Git (GitHub/GitLab/Bitbucket), puis importer le dépôt dans Vercel — le framework Next.js est détecté automatiquement, aucune configuration `vercel.json` nécessaire.
2. Dans les paramètres du projet Vercel (Settings → Environment Variables), ajouter `NEXT_PUBLIC_SUPABASE_URL` et `NEXT_PUBLIC_SUPABASE_ANON_KEY` (mêmes valeurs que `.env.local`). Sans elles, l'app se redéploie automatiquement en mode local mocké.
3. Dans Supabase, ajouter l'URL de production (`https://votre-projet.vercel.app`) aux **Site URL** / **Redirect URLs** du projet (Authentication → URL Configuration), sinon les emails de confirmation/connexion redirigeront vers `localhost`.
4. Déployer. Aucune autre configuration serveur n'est nécessaire (pas de backend séparé, l'app est 100 % Next.js + Supabase).
