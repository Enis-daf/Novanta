-- Module "Passé" : regroupements manuels de flux pour l'Analyse d'écarts — nouvelles tables,
-- additives, non destructives. Prérequis : 20261007_organization_modules.sql. Idempotent.
--
-- L'utilisateur réunit des flux que le moteur (lib/flowMatching.ts) tient pour distincts. C'est une
-- surcouche : ni les transactions, ni les identités de flux, ni le moteur ne sont modifiés.
--   - past_flow_groups : un groupe et son nom métier ;
--   - past_flow_group_members : les flux du groupe, désignés par leur identité propre
--     (canonical_flow_key, la même clé que past_flow_aliases).
--
-- Un flux n'appartient qu'à un groupe à la fois dans une organisation : unique
-- (organization_id, canonical_flow_key). Comme pour les alias, chaque membre garde le nom détecté,
-- un libellé bancaire d'exemple et la version du moteur, de quoi recalculer sa clé si le moteur
-- évolue.
--
-- Sécurité : lecture et écriture limitées à sa propre organisation, module 'past' activé ; un
-- membre ne peut rejoindre qu'un groupe de la même organisation. Auteur et date de modification
-- du groupe posés par trigger (fonction de 20261013_past_flow_aliases.sql, recréée ici).

create table if not exists past_flow_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table if not exists past_flow_group_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  flow_group_id uuid not null references past_flow_groups(id) on delete cascade,
  canonical_flow_key text not null check (canonical_flow_key <> ''),
  detected_name text,
  sample_label text,
  engine_version text,
  created_at timestamptz not null default now(),
  unique (organization_id, canonical_flow_key)
);

create index if not exists idx_past_flow_group_members_group on past_flow_group_members(flow_group_id);

create or replace function past_poser_modification_alias()
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

drop trigger if exists past_flow_groups_audit on past_flow_groups;
create trigger past_flow_groups_audit
  before insert or update on past_flow_groups
  for each row execute function past_poser_modification_alias();

alter table past_flow_groups enable row level security;
alter table past_flow_group_members enable row level security;

drop policy if exists "Groupes de flux de sa société" on past_flow_groups;
create policy "Groupes de flux de sa société" on past_flow_groups
  for all
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_flow_groups.organization_id
        and m.module_key = 'past' and m.enabled
    )
  )
  with check (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_flow_groups.organization_id
        and m.module_key = 'past' and m.enabled
    )
  );

drop policy if exists "Membres des groupes de flux de sa société" on past_flow_group_members;
create policy "Membres des groupes de flux de sa société" on past_flow_group_members
  for all
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_flow_group_members.organization_id
        and m.module_key = 'past' and m.enabled
    )
  )
  with check (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_flow_group_members.organization_id
        and m.module_key = 'past' and m.enabled
    )
    and exists (
      select 1 from past_flow_groups g
      where g.id = past_flow_group_members.flow_group_id
        and g.organization_id = past_flow_group_members.organization_id
    )
  );

revoke all on public.past_flow_groups from anon;
revoke all on public.past_flow_group_members from anon;
revoke truncate on public.past_flow_groups from authenticated;
revoke truncate on public.past_flow_group_members from authenticated;
grant select, insert, update, delete on public.past_flow_groups to authenticated;
grant select, insert, update, delete on public.past_flow_group_members to authenticated;
