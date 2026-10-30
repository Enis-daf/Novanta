-- P&L comptable : synchronisation robuste et ajustements de gestion — ADDITIF, idempotent.
-- Prérequis : 20261030_accounting_pnl.sql, 20261031_accounting_monthly_balances.sql.
--
-- accounting_fiscal_years : exercices tels que Pennylane les renvoie. `status` reste la valeur brute :
--   open et reopen sont non clôturés, closed clôturé ; frozen, non documenté, reste signalé comme ambigu.
-- accounting_sync_runs : journal des synchronisations, sans donnée sensible. L'index unique partiel
--   interdit deux synchronisations en cours pour une même société. Une exécution restée « running » au-delà
--   du délai (fonction serveur interrompue) passe en « abandoned », ce qui permet la reprise.
-- accounting_replace_month_balance : remplace la balance d'un mois en UNE transaction. Une relecture
--   remplace, n'additionne jamais ; un échec laisse le mois précédent intact.
-- accounting_inventory_source_choices : arbitrages de la source de variation de stocks, par exercice.
--   Append-only : le dernier fait foi, les précédents restent la trace. Les montants au moment du choix
--   permettent de dire qu'une source a changé depuis, sans redemander l'arbitrage. Remplace
--   accounting_settings.inventory_source (global), qui reste en place, inutilisé.
-- accounting_management_adjustments : ajustements de gestion du seul P&L comptable (amortissements
--   mensuels, par exemple). Table à part de past_management_adjustments : ils ne peuvent donc pas modifier
--   le P&L cash estimé. Les stocks restent saisis dans leur module, d'où l'exclusion de cette ligne.
--
-- Toutes ces tables : RLS activée, aucune policy, droits retirés au navigateur.

begin;

create table if not exists accounting_fiscal_years (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  source text not null check (source in ('pennylane', 'fixtures')),
  source_fiscal_year_id text not null,
  start_date date not null,
  finish_date date not null,
  status text,
  fetched_at timestamptz not null default now(),
  unique (organization_id, source, source_fiscal_year_id),
  constraint accounting_fiscal_years_dates check (start_date <= finish_date)
);

create index if not exists idx_accounting_fiscal_years_org on accounting_fiscal_years (organization_id, start_date);

create table if not exists accounting_sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  source text not null check (source in ('pennylane', 'fixtures')),
  trigger_type text not null check (trigger_type in ('quotidien', 'hebdomadaire', 'manuel', 'exceptionnel')),
  status text not null default 'running' check (status in ('running', 'success', 'partial', 'error', 'abandoned')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  months_requested integer not null default 0,
  months_updated integer not null default 0,
  failed_months jsonb not null default '[]'::jsonb,
  notes jsonb not null default '[]'::jsonb,
  error_code text
);

create unique index if not exists accounting_sync_runs_un_en_cours
  on accounting_sync_runs (organization_id) where status = 'running';
create index if not exists idx_accounting_sync_runs_org
  on accounting_sync_runs (organization_id, started_at desc);

-- Commence une synchronisation, ou renvoie NULL si une autre est déjà en cours pour cette société.
create or replace function accounting_sync_begin(p_organization_id uuid, p_source text, p_trigger text, p_stale_after_seconds integer)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  demarree uuid;
begin
  update accounting_sync_runs
     set status = 'abandoned', finished_at = now(), error_code = 'interrompue'
   where organization_id = p_organization_id and status = 'running'
     and started_at < now() - make_interval(secs => p_stale_after_seconds);

  insert into accounting_sync_runs (organization_id, source, trigger_type)
  values (p_organization_id, p_source, p_trigger)
  on conflict (organization_id) where status = 'running' do nothing
  returning id into demarree;

  return demarree;
end;
$$;

-- Remplace la balance d'un mois, en une transaction : mêmes comptes mis à jour, comptes disparus écartés
-- (jamais supprimés), comptes revenus rétablis. p_lines : [{ account_number, account_label, debit, credit }].
create or replace function accounting_replace_month_balance(p_organization_id uuid, p_source text, p_month date, p_run uuid, p_lines jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  ecrites integer;
begin
  if jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Balance illisible.';
  end if;

  insert into accounting_monthly_balances
    (organization_id, source, month, account_number, account_label, debit, credit, sync_run, excluded_at, fetched_at)
  select p_organization_id, p_source, p_month, l->>'account_number', l->>'account_label',
         (l->>'debit')::numeric, (l->>'credit')::numeric, p_run, null, now()
    from jsonb_array_elements(p_lines) as l
  on conflict (organization_id, source, month, account_number) do update
    set account_label = excluded.account_label, debit = excluded.debit, credit = excluded.credit,
        sync_run = excluded.sync_run, excluded_at = null, fetched_at = excluded.fetched_at;
  get diagnostics ecrites = row_count;

  update accounting_monthly_balances
     set excluded_at = now()
   where organization_id = p_organization_id and source = p_source and month = p_month
     and sync_run <> p_run and excluded_at is null;

  return ecrites;
end;
$$;

create table if not exists accounting_inventory_source_choices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  scope_start date not null,
  scope_end date not null,
  source text check (source is null or source in ('pennylane', 'novanta')),
  pennylane_amount numeric(16, 2),
  novanta_amount numeric(16, 2),
  chosen_by uuid,
  chosen_at timestamptz not null default now(),
  constraint accounting_inventory_source_choices_dates check (scope_start <= scope_end)
);

create index if not exists idx_accounting_inventory_source_choices_org
  on accounting_inventory_source_choices (organization_id, scope_start, chosen_at desc);

create table if not exists accounting_management_adjustments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  adjustment_date date not null,
  pnl_line text not null check (pnl_line in (
    'revenue', 'direct_costs', 'other_variable_costs', 'structure_costs', 'depreciation', 'financial', 'other_items', 'income_tax'
  )),
  label text not null check (length(btrim(label)) between 1 and 120),
  amount numeric(16, 2) not null,
  notes text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create index if not exists idx_accounting_management_adjustments_org
  on accounting_management_adjustments (organization_id, adjustment_date);

create table if not exists accounting_management_adjustment_history (
  id uuid primary key default gen_random_uuid(),
  adjustment_id uuid not null,
  organization_id uuid not null references companies(id) on delete cascade,
  operation text not null check (operation in ('insert', 'update')),
  previous jsonb,
  changed_by uuid,
  changed_at timestamptz not null default now()
);

create or replace function accounting_management_adjustments_journaliser()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into accounting_management_adjustment_history (adjustment_id, organization_id, operation, changed_by)
    values (new.id, new.organization_id, 'insert', new.updated_by);
  else
    insert into accounting_management_adjustment_history (adjustment_id, organization_id, operation, previous, changed_by)
    values (new.id, new.organization_id, 'update', to_jsonb(old), new.updated_by);
  end if;
  return new;
end;
$$;

drop trigger if exists accounting_management_adjustments_journal on accounting_management_adjustments;
create trigger accounting_management_adjustments_journal
  after insert or update on accounting_management_adjustments
  for each row execute function accounting_management_adjustments_journaliser();

alter table accounting_fiscal_years enable row level security;
alter table accounting_sync_runs enable row level security;
alter table accounting_inventory_source_choices enable row level security;
alter table accounting_management_adjustments enable row level security;
alter table accounting_management_adjustment_history enable row level security;

revoke all on accounting_fiscal_years, accounting_sync_runs, accounting_inventory_source_choices,
  accounting_management_adjustments, accounting_management_adjustment_history from public, anon, authenticated;
revoke all on function accounting_sync_begin(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function accounting_replace_month_balance(uuid, text, date, uuid, jsonb) from public, anon, authenticated;
revoke all on function accounting_management_adjustments_journaliser() from public, anon, authenticated;
grant all on accounting_fiscal_years, accounting_sync_runs, accounting_inventory_source_choices,
  accounting_management_adjustments, accounting_management_adjustment_history to service_role;
grant execute on function accounting_sync_begin(uuid, text, text, integer) to service_role;
grant execute on function accounting_replace_month_balance(uuid, text, date, uuid, jsonb) to service_role;

commit;

-- Retour arrière logique (à ne lancer que sur décision explicite) :
--   drop table accounting_management_adjustment_history, accounting_management_adjustments,
--     accounting_inventory_source_choices, accounting_sync_runs, accounting_fiscal_years;
--   drop function accounting_sync_begin(uuid, text, text, integer);
--   drop function accounting_replace_month_balance(uuid, text, date, uuid, jsonb);
--   drop function accounting_management_adjustments_journaliser();
