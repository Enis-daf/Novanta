-- Module "Passé" : correspondance catégorie source -> étage P&L — nouvelles tables, additives,
-- non destructives. Prérequis : 20261008_past_transactions.sql. Idempotent (réexécutable).
--
-- Modèle V1, strictement : catégorie source (Pennylane) -> un étage P&L fixe, par organisation.
-- L'étage n'est JAMAIS copié dans les transactions : le reporting résout à la lecture
--   transaction -> catégorie (past_transaction_categories) -> past_category_mappings -> étage.
-- Modifier une ligne de mapping reclasse donc tout l'historique, sans réécrire une transaction.
--
-- pnl_stage null = catégorie connue mais pas encore rattachée ("À mapper"). À ne pas confondre
-- avec une transaction non catégorisée, qui n'a aucune catégorie et n'apparaît donc pas ici.
--
-- Identité d'une catégorie : son identifiant source (source_category_id), unique par organisation.
-- source_group_id conserve l'axe analytique d'origine : le module n'affiche que les catégories de
-- l'axe retenu, sans perdre les mappings des autres axes.
--
-- Qui écrit quoi :
--   - les catégories sont ajoutées par la synchronisation (route serveur, clé service_role),
--     toujours avec pnl_stage null : aucun étage n'est choisi automatiquement ;
--   - l'utilisateur ne peut modifier QUE pnl_stage, sur les lignes de sa propre organisation ;
--   - le journal past_category_mapping_history est écrit par un trigger à chaque changement
--     d'étage (ancien, nouveau, auteur, date) : il ne peut être ni oublié ni falsifié côté client,
--     et n'a aucun effet sur le reporting, qui lit toujours le mapping courant.

create table if not exists past_category_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  source_category_id text not null,
  source_category_name text not null,
  source_group_id text,
  pnl_stage text check (pnl_stage in ('revenue', 'gross_margin', 'contribution_margin', 'ebitda', 'extra_pnl')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  unique (organization_id, source_category_id)
);

create table if not exists past_category_mapping_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  source_category_id text not null,
  source_category_name text not null,
  previous_pnl_stage text,
  new_pnl_stage text,
  changed_by uuid,
  changed_at timestamptz not null default now()
);

create index if not exists idx_past_category_mapping_history_org
  on past_category_mapping_history(organization_id, changed_at desc);

-- La clé du 5e étage s'est d'abord appelée autrement dans une version antérieure de ce fichier :
-- sur une base où elle a été appliquée, la contrainte est retirée AVANT de renommer les valeurs
-- (sinon l'UPDATE serait rejeté), puis recréée. Sans effet sur une base neuve.
alter table past_category_mappings drop constraint if exists past_category_mappings_pnl_stage_check;
update past_category_mappings set pnl_stage = 'extra_pnl' where pnl_stage = 'outside_pnl';
update past_category_mapping_history set previous_pnl_stage = 'extra_pnl' where previous_pnl_stage = 'outside_pnl';
update past_category_mapping_history set new_pnl_stage = 'extra_pnl' where new_pnl_stage = 'outside_pnl';
alter table past_category_mappings add constraint past_category_mappings_pnl_stage_check
  check (pnl_stage in ('revenue', 'gross_margin', 'contribution_margin', 'ebitda', 'extra_pnl'));

-- Journalise chaque changement d'étage et date/signe la ligne. Un simple renommage de catégorie
-- par la synchronisation (pnl_stage inchangé) ne produit aucune ligne d'historique.
create or replace function past_category_mappings_journaliser()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.pnl_stage is distinct from old.pnl_stage then
    new.updated_at := now();
    new.updated_by := auth.uid();
    insert into past_category_mapping_history
      (organization_id, source_category_id, source_category_name, previous_pnl_stage, new_pnl_stage, changed_by)
    values
      (new.organization_id, new.source_category_id, new.source_category_name, old.pnl_stage, new.pnl_stage, auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists past_category_mappings_journal on past_category_mappings;
create trigger past_category_mappings_journal
  before update on past_category_mappings
  for each row execute function past_category_mappings_journaliser();

alter table past_category_mappings enable row level security;
alter table past_category_mapping_history enable row level security;

drop policy if exists "Lecture des mappings de sa société" on past_category_mappings;
create policy "Lecture des mappings de sa société" on past_category_mappings
  for select
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_category_mappings.organization_id
        and m.module_key = 'past' and m.enabled
    )
  );

drop policy if exists "Modification des mappings de sa société" on past_category_mappings;
create policy "Modification des mappings de sa société" on past_category_mappings
  for update
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_category_mappings.organization_id
        and m.module_key = 'past' and m.enabled
    )
  )
  with check (organization_id in (select id from companies where owner_id = auth.uid()));

drop policy if exists "Lecture de l'historique de mapping de sa société" on past_category_mapping_history;
create policy "Lecture de l'historique de mapping de sa société" on past_category_mapping_history
  for select
  using (organization_id in (select id from companies where owner_id = auth.uid()));

revoke all on public.past_category_mappings from anon;
revoke all on public.past_category_mapping_history from anon;
revoke insert, update, delete, truncate on public.past_category_mappings from authenticated;
revoke insert, update, delete, truncate on public.past_category_mapping_history from authenticated;
grant select on public.past_category_mappings to authenticated;
grant update (pnl_stage) on public.past_category_mappings to authenticated;
grant select on public.past_category_mapping_history to authenticated;

-- Reprise de l'existant : les catégories déjà synchronisées avant cette migration deviennent des
-- lignes "À mapper" (aucun étage choisi). Sans effet sur les lignes déjà présentes.
insert into past_category_mappings (organization_id, source_category_id, source_category_name, source_group_id)
select distinct on (c.organization_id, c.analytic_category_id)
  c.organization_id, c.analytic_category_id, c.analytic_category_name, c.analytic_group_id
from past_transaction_categories c
where c.analytic_category_id is not null
order by c.organization_id, c.analytic_category_id, c.created_at desc
on conflict (organization_id, source_category_id) do nothing;
