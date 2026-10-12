-- Module "Passé" : cibles de performance — nouvelle table, additive, non destructive.
-- Prérequis : 20261007_organization_modules.sql. Idempotent (réexécutable).
--
-- Trois références seulement, pas un budget :
--   - gross_margin_pct        : Marge brute cible, en % du CA, PAR CATÉGORIE DE CA ;
--   - contribution_margin_pct : Marge contributive cible, en % du CA, PAR CATÉGORIE DE CA ;
--   - structure_cost_monthly  : Coûts de structure cibles, en euros par mois, globale.
--
-- dimension_key porte la catégorie de CA d'une cible de marge : son identifiant stable
-- (past_category_mappings.source_category_id), jamais son libellé. Il est vide pour les coûts de
-- structure. La cible globale de marge d'une période n'est stockée nulle part : elle est calculée à
-- la lecture, en pondérant les cibles des catégories par leur CA réel (lib/pastTargets.ts).
--
-- Les cibles sont DATÉES : une ligne vaut à partir de sa date d'effet (valid_from), jusqu'à la
-- date d'effet de la ligne suivante de la même catégorie et du même type. Modifier une cible,
-- c'est ajouter une ligne ; la lecture du passé n'est jamais réécrite. L'unicité (organisation,
-- type, catégorie, date d'effet) interdit deux cibles concurrentes.
--
-- Sécurité : lecture et écriture limitées à sa propre organisation, module 'past' activé. Auteur
-- et date de modification posés par trigger, jamais par le client.

create table if not exists past_performance_targets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  target_type text not null check (target_type in ('gross_margin_pct', 'contribution_margin_pct', 'structure_cost_monthly')),
  dimension_key text not null default '',
  valid_from date not null,
  target_value numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  unique (organization_id, target_type, dimension_key, valid_from),
  constraint past_performance_targets_valeur check (
    (target_type = 'structure_cost_monthly' and target_value >= 0)
    or (target_type <> 'structure_cost_monthly' and target_value between -100 and 100)
  )
);

-- Une première version de cette table admettait une cible de marge globale (dimension vide).
-- Ce modèle est abandonné avant toute mise en service : s'il en reste des lignes d'essai, elles
-- sont retirées — une cible globale n'est jamais recopiée sur les catégories.
delete from past_performance_targets
where target_type in ('gross_margin_pct', 'contribution_margin_pct') and dimension_key = '';

alter table past_performance_targets drop constraint if exists past_performance_targets_dimension;
alter table past_performance_targets add constraint past_performance_targets_dimension check (
  (target_type = 'structure_cost_monthly' and dimension_key = '')
  or (target_type <> 'structure_cost_monthly' and dimension_key <> '')
);

create or replace function past_poser_modification_cible()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists past_performance_targets_audit on past_performance_targets;
create trigger past_performance_targets_audit
  before insert or update on past_performance_targets
  for each row execute function past_poser_modification_cible();

alter table past_performance_targets enable row level security;

drop policy if exists "Cibles de performance de sa société" on past_performance_targets;
create policy "Cibles de performance de sa société" on past_performance_targets
  for all
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_performance_targets.organization_id
        and m.module_key = 'past' and m.enabled
    )
  )
  with check (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_performance_targets.organization_id
        and m.module_key = 'past' and m.enabled
    )
  );

revoke all on public.past_performance_targets from anon;
revoke truncate on public.past_performance_targets from authenticated;
grant select, insert, update, delete on public.past_performance_targets to authenticated;
