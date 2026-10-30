-- P&L comptable (offre Pilotage) et source des KPI — ADDITIF : aucune table ni colonne existante
-- supprimée, aucune ligne existante modifiée. Idempotent (réexécutable).
-- Prérequis : companies, 20261016_past_performance_targets.sql, 20261027_action_initiatives.sql.
--
-- Pennylane reste responsable de la comptabilité : Novanta en garde une copie de lecture, et n'écrit
-- jamais rien chez Pennylane.
--
-- SÉCURITÉ. Aucune de ces tables n'a de policy pour le rôle authenticated : RLS activée sans policy,
-- droits retirés. Tout passe par les routes app/api/passe/compta/*, qui dérivent l'organisation de
-- l'utilisateur connecté et vérifient la capacité canViewAccountingPnl (lib/offres.ts) à chaque
-- appel : une écriture comptable n'est pas lisible depuis le navigateur, même avec sa propre société,
-- et un changement d'offre s'applique immédiatement.
--
-- accounting_mapping_rules : racine de compte -> ligne du P&L + catégorie élémentaire, par
--   organisation. La racine la plus longue l'emporte (lib/comptaCorrespondance.ts). Une racine hors
--   des classes 6 et 7 est refusée : un compte de bilan ne se force pas dans le P&L.
-- accounting_mapping_rule_history : journal écrit par trigger, à chaque création, modification ou
--   suppression. Sans effet sur le reporting ni sur les références figées (objectifs, fiabilité,
--   chantiers clôturés : aucune de ces données n'est relue ou réécrite ici).
-- accounting_accounts : plan de comptes rencontré. first_seen_at sert à signaler un nouveau compte.
-- accounting_entry_lines : copie de lecture des lignes d'écriture. excluded_at : la ligne n'a plus été
--   renvoyée par la source lors d'une relecture de sa période — écartée du calcul, jamais supprimée.
--   source_status : réservé à un statut que la source fournirait ; la documentation Pennylane n'en
--   décrit aucun à ce jour.
-- accounting_settings : arbitrage de la source de variation de stocks. Null = pas d'arbitrage.
-- accounting_sync_state : dernière synchronisation par organisation.

begin;

create table if not exists accounting_mapping_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  account_prefix text not null,
  pnl_line text not null,
  category_label text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  unique (organization_id, account_prefix),
  constraint accounting_mapping_rules_prefix check (account_prefix ~ '^[67][0-9]{0,11}$'),
  constraint accounting_mapping_rules_line check (pnl_line in (
    'revenue', 'direct_costs', 'inventory_variation', 'other_variable_costs', 'structure_costs',
    'depreciation', 'financial', 'other_items', 'income_tax', 'out_of_scope'
  )),
  constraint accounting_mapping_rules_category check (length(btrim(category_label)) between 1 and 80)
);

create table if not exists accounting_mapping_rule_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  account_prefix text not null,
  operation text not null check (operation in ('insert', 'update', 'delete')),
  previous_line text,
  new_line text,
  previous_category text,
  new_category text,
  changed_by uuid,
  changed_at timestamptz not null default now()
);

create index if not exists idx_accounting_mapping_rule_history_org
  on accounting_mapping_rule_history (organization_id, changed_at desc);

create or replace function accounting_mapping_rules_journaliser()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into accounting_mapping_rule_history
      (organization_id, account_prefix, operation, new_line, new_category, changed_by)
    values
      (new.organization_id, new.account_prefix, 'insert', new.pnl_line, new.category_label, new.updated_by);
    return new;
  elsif tg_op = 'UPDATE' then
    if new.pnl_line is distinct from old.pnl_line or new.category_label is distinct from old.category_label then
      insert into accounting_mapping_rule_history
        (organization_id, account_prefix, operation, previous_line, new_line, previous_category, new_category, changed_by)
      values
        (new.organization_id, new.account_prefix, 'update', old.pnl_line, new.pnl_line, old.category_label, new.category_label, new.updated_by);
    end if;
    return new;
  end if;
  -- Suppression en cascade d'une société : plus rien à journaliser pour elle.
  if exists (select 1 from companies where id = old.organization_id) then
    insert into accounting_mapping_rule_history
      (organization_id, account_prefix, operation, previous_line, previous_category, changed_by)
    values
      (old.organization_id, old.account_prefix, 'delete', old.pnl_line, old.category_label, old.updated_by);
  end if;
  return old;
end;
$$;

drop trigger if exists accounting_mapping_rules_journal on accounting_mapping_rules;
create trigger accounting_mapping_rules_journal
  after insert or update or delete on accounting_mapping_rules
  for each row execute function accounting_mapping_rules_journaliser();

create table if not exists accounting_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  account_number text not null,
  label text not null default '',
  account_type text,
  enabled boolean not null default true,
  source text not null check (source in ('pennylane', 'fixtures')),
  source_account_id text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (organization_id, account_number),
  constraint accounting_accounts_number check (account_number ~ '^[0-9]+$')
);

create table if not exists accounting_entry_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  source text not null check (source in ('pennylane', 'fixtures')),
  source_line_id text not null,
  source_entry_id text,
  source_journal_id text,
  account_number text not null,
  entry_date date not null,
  debit numeric(16, 2) not null default 0,
  credit numeric(16, 2) not null default 0,
  label text,
  source_status text,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  sync_run uuid not null,
  excluded_at timestamptz,
  imported_at timestamptz not null default now(),
  unique (organization_id, source, source_line_id),
  constraint accounting_entry_lines_number check (account_number ~ '^[0-9]+$')
);

create index if not exists idx_accounting_entry_lines_org_date
  on accounting_entry_lines (organization_id, entry_date);
create index if not exists idx_accounting_entry_lines_org_account
  on accounting_entry_lines (organization_id, account_number, entry_date);

create table if not exists accounting_settings (
  organization_id uuid primary key references companies(id) on delete cascade,
  inventory_source text check (inventory_source is null or inventory_source in ('pennylane', 'novanta')),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table if not exists accounting_sync_state (
  organization_id uuid primary key references companies(id) on delete cascade,
  source text not null check (source in ('pennylane', 'fixtures')),
  status text not null check (status in ('running', 'success', 'partial', 'error')),
  started_at timestamptz,
  finished_at timestamptz,
  covered_from date,
  covered_to date,
  lines_count integer not null default 0,
  error_code text
);

-- Cumuls par compte et par mois : le reporting ne transporte jamais les lignes jusqu'au navigateur.
create or replace function accounting_balances(p_organization_id uuid, p_start date, p_end date)
returns table (account_number text, month text, debit numeric, credit numeric, lines bigint)
language sql
stable
set search_path = public
as $$
  select l.account_number, to_char(l.entry_date, 'YYYY-MM'), sum(l.debit), sum(l.credit), count(*)
  from accounting_entry_lines l
  where l.organization_id = p_organization_id
    and l.entry_date between p_start and p_end
    and l.excluded_at is null
  group by l.account_number, to_char(l.entry_date, 'YYYY-MM');
$$;

alter table accounting_mapping_rules enable row level security;
alter table accounting_mapping_rule_history enable row level security;
alter table accounting_accounts enable row level security;
alter table accounting_entry_lines enable row level security;
alter table accounting_settings enable row level security;
alter table accounting_sync_state enable row level security;

revoke all on accounting_mapping_rules, accounting_mapping_rule_history, accounting_accounts,
  accounting_entry_lines, accounting_settings, accounting_sync_state from public, anon, authenticated;
revoke all on function accounting_balances(uuid, date, date) from public, anon, authenticated;
revoke all on function accounting_mapping_rules_journaliser() from public, anon, authenticated;
grant all on accounting_mapping_rules, accounting_mapping_rule_history, accounting_accounts,
  accounting_entry_lines, accounting_settings, accounting_sync_state to service_role;
grant execute on function accounting_balances(uuid, date, date) to service_role;

-- --- Source des KPI ---------------------------------------------------------------------------
--
-- Colonnes nullables, sans valeur par défaut et sans rattrapage : une ligne existante garde NULL,
-- c'est-à-dire la définition d'origine, résolue par le catalogue (lib/actionChantier.ts). Rien n'est
-- converti : une référence HT estimée n'est jamais comparée à une valeur comptable.

alter table action_initiative_kpis add column if not exists kpi_source text;
alter table action_initiative_kpis add column if not exists kpi_definition jsonb;
alter table action_initiative_kpis drop constraint if exists action_initiative_kpis_source_check;
alter table action_initiative_kpis add constraint action_initiative_kpis_source_check
  check (kpi_source is null or kpi_source in ('cash_estime', 'comptable', 'tresorerie', 'bfr', 'manuel')) not valid;

alter table past_performance_targets add column if not exists kpi_source text;
alter table past_performance_targets drop constraint if exists past_performance_targets_source_check;
alter table past_performance_targets add constraint past_performance_targets_source_check
  check (kpi_source is null or kpi_source in ('cash_estime', 'comptable')) not valid;

-- Même signature, mêmes droits : enregistre en plus la source et la définition, si elles sont fournies.
create or replace function action_lancer_chantier(
  p_organization_id uuid,
  p_title text,
  p_change_description text,
  p_period_type text,
  p_start_date date,
  p_end_date date,
  p_kpis jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  chantier uuid;
  kpi jsonb;
begin
  if jsonb_typeof(p_kpis) <> 'array' or jsonb_array_length(p_kpis) <> 3 then
    raise exception 'Un chantier compte exactement 3 indicateurs.';
  end if;

  insert into action_initiatives (organization_id, title, change_description, period_type, start_date, end_date)
  values (p_organization_id, btrim(p_title), btrim(p_change_description), p_period_type, p_start_date, p_end_date)
  returning id into chantier;

  for kpi in select * from jsonb_array_elements(p_kpis) loop
    insert into action_initiative_kpis (
      initiative_id, organization_id, position, kpi_key, custom_name, custom_unit, direction,
      reference_value, reference_label, reference_origin, reference_start, reference_end, target_value,
      kpi_source, kpi_definition
    ) values (
      chantier,
      p_organization_id,
      (kpi->>'position')::smallint,
      kpi->>'kpi_key',
      nullif(btrim(kpi->>'custom_name'), ''),
      nullif(btrim(kpi->>'custom_unit'), ''),
      kpi->>'direction',
      (kpi->>'reference_value')::numeric,
      kpi->>'reference_label',
      kpi->>'reference_origin',
      (kpi->>'reference_start')::date,
      (kpi->>'reference_end')::date,
      (kpi->>'target_value')::numeric,
      kpi->>'kpi_source',
      kpi->'kpi_definition'
    );
  end loop;

  return chantier;
end;
$$;

commit;

-- Retour arrière logique (hors de ce chantier, à ne lancer que sur décision explicite) :
--   drop table accounting_sync_state, accounting_settings, accounting_entry_lines, accounting_accounts,
--     accounting_mapping_rule_history, accounting_mapping_rules;
--   drop function accounting_balances(uuid, date, date);
--   drop function accounting_mapping_rules_journaliser();
--   alter table action_initiative_kpis drop column kpi_definition, drop column kpi_source;
--   alter table past_performance_targets drop column kpi_source;
