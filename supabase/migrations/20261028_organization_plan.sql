-- Offre commerciale de l'organisation (Essentiel / Prévision / Pilotage) — colonnes additives sur
-- companies, seule notion d'organisation du schéma (voir 20261007_organization_modules.sql).
-- Aucune table supprimée, aucune donnée existante modifiée hors remplissage des nouvelles colonnes.
--
-- Trois données, toutes au niveau de l'organisation (jamais de l'utilisateur) :
--  - plan                : offre contractuelle. Valeurs : 'essential' (Essentiel), 'forecast'
--                          (Prévision), 'steering' (Pilotage).
--  - plan_override       : offre accordée exceptionnellement (démo, test, onboarding), sans toucher
--                          à l'offre contractuelle. null = aucun override.
--  - plan_override_until : fin de l'override. null = sans échéance. Passée cette date, l'override
--                          est ignoré et l'organisation retombe sur plan.
--
-- Les droits (capabilities) ne sont PAS stockés : ils sont dérivés de l'offre effective par la
-- matrice centrale lib/offres.ts. Changer ce qu'une offre contient ne demande aucune migration.
--
-- Distinct de subscription_plan (valeur brute écrite par le webhook Stripe) : plan est attribué à
-- la main par Novanta en V1. Distinct aussi de access_enabled (accès au produit lié au paiement) et
-- de organization_modules (activation du module Passé) : les trois se cumulent.
--
-- Comptes existants : 'steering' par défaut. Aujourd'hui, toute organisation ayant accès voit déjà
-- tout ce que le produit propose (Futur, Passé si activé, BFR, Analyse d'écarts) : Pilotage est le
-- seul niveau qui ne retire rien à personne. Même valeur pour les nouvelles sociétés, faute de règle
-- commerciale validée pour les nouveaux abonnés : Novanta rétrograde ensuite à la main.

alter table companies
  add column if not exists plan text not null default 'steering',
  add column if not exists plan_override text,
  add column if not exists plan_override_until timestamptz;

alter table companies drop constraint if exists companies_plan_check;
alter table companies
  add constraint companies_plan_check check (plan in ('essential', 'forecast', 'steering'));

alter table companies drop constraint if exists companies_plan_override_check;
alter table companies
  add constraint companies_plan_override_check
  check (plan_override is null or plan_override in ('essential', 'forecast', 'steering'));

-- Écriture réservée à Novanta (éditeur SQL Supabase / service_role).
-- UPDATE : déjà limité à (name, first_name, last_name) par
-- 20260806_restrict_billing_columns_and_access_default.sql, donc plan et override ne sont pas
-- modifiables par l'utilisateur.
-- INSERT : la société est créée par l'utilisateur lui-même à sa première connexion (RLS). Sans
-- cette restriction, il pourrait s'attribuer Pilotage en insérant sa ligne depuis la console du
-- navigateur. On ne garde que les colonnes réellement écrites par lib/billing.ts
-- (getOrCreateCompanyForBilling) ; les autres prennent leur valeur par défaut.
revoke insert on public.companies from authenticated;
grant insert (owner_id, name, first_name, last_name, billing_email, access_enabled)
  on public.companies to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Attribution manuelle (éditeur SQL Supabase), en remplaçant l'identifiant de la société :
--
--   update companies set plan = 'essential' where id = '<id de la société>';  -- Essentiel
--   update companies set plan = 'forecast'  where id = '<id de la société>';  -- Prévision
--   update companies set plan = 'steering'  where id = '<id de la société>';  -- Pilotage
--
-- Override temporaire (ex. Pilotage pendant 30 jours) :
--
--   update companies
--   set plan_override = 'steering', plan_override_until = now() + interval '30 days'
--   where id = '<id de la société>';
--
-- Suppression de l'override :
--
--   update companies set plan_override = null, plan_override_until = null
--   where id = '<id de la société>';
