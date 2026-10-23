-- Module "Futur" : fiabilité de la projection (prévu / réalisé). Additif, non destructif, idempotent.
-- Prérequis : 20261025_future_pnl_stage.sql, 20261018_fixed_charge_invoice_matching.sql.
--
-- Quatre tables, écrites UNIQUEMENT par le serveur (clé service_role) :
--
-- 1. future_change_events — instants où les données de prévision d'une société ont changé (une
--    ligne par société et par minute, aucune donnée métier). Sert à une seule chose : savoir si une
--    projection calculée à un instant T est bien celle qui existait à la clôture R, c'est-à-dire
--    qu'aucune modification n'a eu lieu entre T et R. Une capture tardive n'est retenue que dans ce
--    cas : jamais des données actuelles datées artificiellement d'avant.
--    Alimentée par trigger sur toutes les tables lues par la projection, et sur la correspondance
--    P&L (étages enregistrés avec la référence).
--
-- 2. future_forecast_references — prévision de référence d'une période (mois ou trimestre),
--    arrêtée à la clôture de la veille de son début (minuit, heure de Paris). Détail complet :
--    lignes, dates, montants, étages, sources. Une référence officielle n'est jamais modifiée ni
--    remplacée : insertion « on conflict do nothing », mise à jour et suppression interdites.
--    status 'provisional' = capture faite avant la clôture, confirmée ensuite si rien n'a changé.
--
-- 3. past_sync_runs — synchronisations Pennylane du module Passé réussies : période couverte,
--    instant, complétude (pagination non tronquée). Permet de dire si le réalisé d'une période est
--    complet, au lieu de prendre une récupération partielle pour une erreur de prévision.
--
-- 4. future_accuracy_results — résultats prévu / réalisé enregistrés, par révision. Une nouvelle
--    révision n'est créée que si le réalisé ou son classement a changé (empreinte) : l'historique
--    des recalculs est conservé, la référence n'est jamais touchée.
--
-- Droits : lecture par le propriétaire de la société seulement (et, pour ce qui vient de Passé,
-- avec le module Passé activé) ; aucune écriture pour "authenticated".
--
-- Rollback logique : drop des 4 tables, de la fonction future_noter_modification et des triggers
-- future_change_event sur les tables listées plus bas.

begin;

-- 1. Instants de modification ---------------------------------------------------------------------

create table if not exists future_change_events (
  company_id uuid not null references companies(id) on delete cascade,
  minute timestamptz not null,
  changed_at timestamptz not null default now(),
  primary key (company_id, minute)
);

create or replace function future_noter_modification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ligne jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  societe uuid := (ligne ->> tg_argv[0])::uuid;
begin
  if societe is not null then
    insert into future_change_events (company_id, minute, changed_at)
    values (societe, date_trunc('minute', now()), now())
    on conflict (company_id, minute) do update set changed_at = greatest(future_change_events.changed_at, excluded.changed_at);
  end if;
  return null;
end;
$$;

do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('customer_invoices', 'company_id'),
      ('supplier_invoices', 'company_id'),
      ('fixed_charges', 'company_id'),
      ('other_expenses', 'company_id'),
      ('financings', 'company_id'),
      ('recurring_income', 'company_id'),
      ('fixed_charge_invoice_links', 'company_id'),
      ('past_category_mappings', 'organization_id'),
      ('past_settings', 'organization_id')
    ) as v(nom, colonne)
  loop
    if to_regclass('public.' || t.nom) is not null then
      execute format('drop trigger if exists future_change_event on %I', t.nom);
      execute format(
        'create trigger future_change_event after insert or update or delete on %I for each row execute function future_noter_modification(%L)',
        t.nom, t.colonne
      );
    end if;
  end loop;
end;
$$;

-- Avant cette migration, aucune modification n'était tracée : l'absence d'événement ne prouve
-- rien. Un marqueur « modifié à l'installation » par société empêche toute capture tardive de
-- prétendre qu'une projection actuelle est celle d'une clôture antérieure (pas d'antidatage).
insert into future_change_events (company_id, minute, changed_at)
select id, date_trunc('minute', now()), now() from companies
on conflict (company_id, minute) do nothing;

alter table future_change_events enable row level security;
revoke all on public.future_change_events from anon, authenticated;

-- 2. Prévisions de référence ----------------------------------------------------------------------

create table if not exists future_forecast_references (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  period_kind text not null check (period_kind in ('month', 'quarter')),
  period_start date not null,
  period_end date not null,
  reference_at timestamptz not null, -- clôture : minuit (Paris) au début de la période
  captured_at timestamptz not null, -- instant réel du calcul
  status text not null check (status in ('provisional', 'official')),
  capture_mode text not null check (capture_mode in ('before_close', 'after_close_unchanged')),
  engine_version integer not null,
  totals jsonb not null,
  lines jsonb not null,
  coverage jsonb not null,
  created_at timestamptz not null default now(),
  check (period_end >= period_start),
  unique (company_id, period_kind, period_start, status)
);

create index if not exists idx_future_forecast_references_company
  on future_forecast_references(company_id, period_kind, period_start);

-- Une référence officielle est figée : ni mise à jour, ni suppression (hors suppression de la
-- société). Une capture provisoire peut être remplacée tant qu'elle n'est pas confirmée.
create or replace function future_reference_figee()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'official' then
    if tg_op = 'DELETE' and not exists (select 1 from companies where id = old.company_id) then
      return old;
    end if;
    raise exception 'Prévision de référence officielle figée : modification interdite.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists future_reference_figee on future_forecast_references;
create trigger future_reference_figee
  before update or delete on future_forecast_references
  for each row execute function future_reference_figee();

alter table future_forecast_references enable row level security;
drop policy if exists "Lecture des références de sa société" on future_forecast_references;
create policy "Lecture des références de sa société" on future_forecast_references
  for select using (company_id in (select id from companies where owner_id = auth.uid()));
revoke all on public.future_forecast_references from anon;
revoke insert, update, delete, truncate on public.future_forecast_references from authenticated;
grant select on public.future_forecast_references to authenticated;

-- 3. Synchronisations Passé réussies ----------------------------------------------------------------

create table if not exists past_sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  synced_at timestamptz not null,
  complete boolean not null,
  transaction_count integer not null default 0,
  check (period_end >= period_start)
);

create index if not exists idx_past_sync_runs_org on past_sync_runs(organization_id, synced_at desc);

alter table past_sync_runs enable row level security;
drop policy if exists "Lecture des synchronisations Passé de sa société" on past_sync_runs;
create policy "Lecture des synchronisations Passé de sa société" on past_sync_runs
  for select using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_sync_runs.organization_id and m.module_key = 'past' and m.enabled
    )
  );
revoke all on public.past_sync_runs from anon;
revoke insert, update, delete, truncate on public.past_sync_runs from authenticated;
grant select on public.past_sync_runs to authenticated;

-- 4. Résultats prévu / réalisé ----------------------------------------------------------------------

create table if not exists future_accuracy_results (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  period_kind text not null check (period_kind in ('month', 'quarter')),
  period_start date not null,
  revision integer not null check (revision >= 1),
  reference_id uuid not null references future_forecast_references(id) on delete cascade,
  computed_at timestamptz not null default now(),
  actual_synced_at timestamptz,
  actual_status text not null check (actual_status in ('complete', 'incomplete', 'unverifiable')),
  fingerprint text not null,
  result jsonb not null,
  unique (company_id, period_kind, period_start, revision)
);

create index if not exists idx_future_accuracy_results_company
  on future_accuracy_results(company_id, period_kind, period_start, revision desc);

alter table future_accuracy_results enable row level security;
drop policy if exists "Lecture des résultats de fiabilité de sa société" on future_accuracy_results;
create policy "Lecture des résultats de fiabilité de sa société" on future_accuracy_results
  for select using (
    company_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = future_accuracy_results.company_id and m.module_key = 'past' and m.enabled
    )
  );
revoke all on public.future_accuracy_results from anon;
revoke insert, update, delete, truncate on public.future_accuracy_results from authenticated;
grant select on public.future_accuracy_results to authenticated;

commit;

notify pgrst, 'reload schema';
