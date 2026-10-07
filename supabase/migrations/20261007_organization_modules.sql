-- Modules activables par organisation (entitlements) — nouvelle table, additive, non destructive.
-- Aucune table existante modifiée, aucune donnée supprimée.
--
-- Table générique : une ligne par (organisation, module). Premier module : module_key = 'past'
-- (brique "Passé"). Activation/désactivation manuelle depuis Supabase pour le moment ; pourra plus
-- tard être écrite par le webhook Stripe (clé service_role) pour piloter les modules par abonnement.
--
-- "Organisation" = une ligne de la table companies (seule notion de tenant du schéma actuel).
--
-- Protection : le rôle "authenticated" peut uniquement LIRE les modules de sa propre organisation.
-- Aucune policy ni aucun droit d'écriture : un utilisateur ne peut jamais s'activer lui-même un
-- module depuis la console du navigateur (même principe que access_enabled sur companies, voir
-- 20260806_restrict_billing_columns_and_access_default.sql).

create table if not exists organization_modules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  module_key text not null,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, module_key)
);

alter table organization_modules enable row level security;

drop policy if exists "Lecture des modules de sa société" on organization_modules;
create policy "Lecture des modules de sa société" on organization_modules
  for select
  using (organization_id in (select id from companies where owner_id = auth.uid()));

revoke all on public.organization_modules from anon;
revoke insert, update, delete, truncate on public.organization_modules from authenticated;
grant select on public.organization_modules to authenticated;

-- Activation manuelle du module "Passé" pour une organisation (à exécuter à la main, en
-- remplaçant l'identifiant) :
--
--   insert into organization_modules (organization_id, module_key, enabled)
--   values ('<id de la société>', 'past', true)
--   on conflict (organization_id, module_key)
--   do update set enabled = excluded.enabled, updated_at = now();
--
-- Désactivation : même requête avec enabled = false.
