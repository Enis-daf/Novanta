-- P&L comptable : import de FEC, source unique par période, ajustements ciblés — ADDITIF, idempotent.
-- Prérequis : 20261030_accounting_pnl.sql, 20261031_accounting_monthly_balances.sql,
-- 20261101_accounting_sync_runs_adjustments.sql.
--
-- Le FEC brut n'est jamais stocké, ni ses écritures : il est lu dans le navigateur, et seules ses balances
-- mensuelles arrivent ici. Elles alimentent accounting_monthly_balances avec source = 'fec', à côté de celles
-- de l'API : même format, même moteur.
--
-- accounting_fec_imports : un import, sa période, son empreinte, ses compteurs de contrôle. status :
--   active, replaced (remplacé par un import explicite), withdrawn (retiré par l'utilisateur). Rien n'est
--   effacé : les balances d'un import inactif sont écartées (excluded_at), et l'historique reste consultable.
-- accounting_fec_import : import atomique, sérialisé par société. Un contenu identique ne fait rien ; un
--   chevauchement avec un import actif ne fait rien non plus sans demande explicite de remplacement. Deux
--   imports ne s'additionnent donc jamais.
-- accounting_source_choices : quand FEC et API couvrent un même mois, quelle source fait foi. Append-only : le
--   dernier choix sur une période fait foi, les précédents restent la trace. Aucune source n'a de priorité par
--   défaut : sans choix, le mois reste en conflit et n'entre pas dans le calcul.
-- accounting_inventory_source_choices.element : l'arbitrage peut aussi porter sur les amortissements. Les
--   lignes existantes restent 'inventory'.
-- accounting_management_adjustments.nature, covers_from, covers_to : nature de l'ajustement et période qu'il
--   couvre réellement, pour un chevauchement jugé sur la période et non sur le mois de saisie.
--
-- Toutes ces tables : RLS activée, aucune policy, droits retirés au navigateur.

begin;

alter table accounting_monthly_balances drop constraint if exists accounting_monthly_balances_source_check;
alter table accounting_monthly_balances add constraint accounting_monthly_balances_source_check
  check (source in ('pennylane', 'fixtures', 'fec'));

alter table accounting_accounts drop constraint if exists accounting_accounts_source_check;
alter table accounting_accounts add constraint accounting_accounts_source_check
  check (source in ('pennylane', 'fixtures', 'fec'));

create table if not exists accounting_fec_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  file_name text not null check (length(file_name) between 1 and 255),
  fingerprint text not null,
  period_start date not null,
  period_end date not null,
  closed_fiscal_year boolean not null default false,
  status text not null default 'active' check (status in ('active', 'replaced', 'withdrawn')),
  summary jsonb not null default '{}'::jsonb,
  imported_by uuid,
  imported_at timestamptz not null default now(),
  ended_at timestamptz,
  replaced_by uuid references accounting_fec_imports(id),
  constraint accounting_fec_imports_dates check (period_start <= period_end)
);

create index if not exists idx_accounting_fec_imports_org on accounting_fec_imports (organization_id, status, period_start);

create table if not exists accounting_source_choices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  scope_start date not null,
  scope_end date not null,
  source text not null check (source in ('fec', 'pennylane')),
  chosen_by uuid,
  chosen_at timestamptz not null default now(),
  constraint accounting_source_choices_dates check (scope_start <= scope_end)
);

create index if not exists idx_accounting_source_choices_org on accounting_source_choices (organization_id, chosen_at desc);

alter table accounting_inventory_source_choices add column if not exists element text not null default 'inventory';
alter table accounting_inventory_source_choices drop constraint if exists accounting_inventory_source_choices_element_check;
alter table accounting_inventory_source_choices add constraint accounting_inventory_source_choices_element_check
  check (element in ('inventory', 'depreciation'));

alter table accounting_management_adjustments add column if not exists nature text not null default 'autre';
alter table accounting_management_adjustments drop constraint if exists accounting_management_adjustments_nature_check;
alter table accounting_management_adjustments add constraint accounting_management_adjustments_nature_check
  check (nature in ('amortissement', 'charge_a_rattacher', 'produit_a_rattacher', 'charge_payee_d_avance', 'revenu_facture_d_avance', 'autre'));
alter table accounting_management_adjustments add column if not exists covers_from date;
alter table accounting_management_adjustments add column if not exists covers_to date;

-- p_lines : [[mois, compte, débit, crédit, lignes], ...] ; p_labels : { compte : libellé }.
-- Renvoie { statut : importe | identique | chevauchement, import_id, chevauchements : [...] }.
create or replace function accounting_fec_import(
  p_organization_id uuid,
  p_file_name text,
  p_fingerprint text,
  p_start date,
  p_end date,
  p_closed boolean,
  p_summary jsonb,
  p_lines jsonb,
  p_labels jsonb,
  p_replace boolean,
  p_user uuid
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  identique uuid;
  chevauchements jsonb;
  nouvel uuid;
begin
  -- Deux imports simultanés d'une même société passent l'un après l'autre.
  perform pg_advisory_xact_lock(hashtextextended('accounting_fec_import:' || p_organization_id::text, 0));

  select id into identique from accounting_fec_imports
   where organization_id = p_organization_id and status = 'active' and fingerprint = p_fingerprint limit 1;
  if identique is not null then
    return jsonb_build_object('statut', 'identique', 'import_id', identique);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'debut', period_start, 'fin', period_end, 'fichier', file_name) order by period_start), '[]'::jsonb)
    into chevauchements
    from accounting_fec_imports
   where organization_id = p_organization_id and status = 'active'
     and daterange(period_start, period_end, '[]') && daterange(p_start, p_end, '[]');

  if jsonb_array_length(chevauchements) > 0 and not p_replace then
    return jsonb_build_object('statut', 'chevauchement', 'chevauchements', chevauchements);
  end if;

  insert into accounting_fec_imports (organization_id, file_name, fingerprint, period_start, period_end, closed_fiscal_year, summary, imported_by)
  values (p_organization_id, p_file_name, p_fingerprint, p_start, p_end, p_closed, p_summary, p_user)
  returning id into nouvel;

  -- Les balances de l'import remplacé sont écartées, jamais effacées.
  update accounting_monthly_balances b
     set excluded_at = now()
    from accounting_fec_imports i
   where i.organization_id = p_organization_id and i.status = 'active' and i.id <> nouvel
     and daterange(i.period_start, i.period_end, '[]') && daterange(p_start, p_end, '[]')
     and b.organization_id = p_organization_id and b.source = 'fec' and b.sync_run = i.id and b.excluded_at is null;

  update accounting_fec_imports
     set status = 'replaced', ended_at = now(), replaced_by = nouvel
   where organization_id = p_organization_id and status = 'active' and id <> nouvel
     and daterange(period_start, period_end, '[]') && daterange(p_start, p_end, '[]');

  insert into accounting_monthly_balances
    (organization_id, source, month, account_number, account_label, debit, credit, sync_run, excluded_at, fetched_at)
  select p_organization_id, 'fec', ((l->>0) || '-01')::date, l->>1, p_labels->>(l->>1),
         (l->>2)::numeric, (l->>3)::numeric, nouvel, null, now()
    from jsonb_array_elements(p_lines) as l
  on conflict (organization_id, source, month, account_number) do update
    set account_label = excluded.account_label, debit = excluded.debit, credit = excluded.credit,
        sync_run = excluded.sync_run, excluded_at = null, fetched_at = excluded.fetched_at;

  -- Plan de comptes : un compte connu garde son libellé et sa date de première vue.
  insert into accounting_accounts (organization_id, account_number, label, source)
  select distinct on (l->>1) p_organization_id, l->>1, coalesce(p_labels->>(l->>1), ''), 'fec'
    from jsonb_array_elements(p_lines) as l
  on conflict (organization_id, account_number) do nothing;

  return jsonb_build_object('statut', 'importe', 'import_id', nouvel);
end;
$$;

-- Retire un import : ses balances sortent du calcul, l'import reste dans l'historique.
create or replace function accounting_fec_withdraw(p_organization_id uuid, p_import uuid)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  trouve boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('accounting_fec_import:' || p_organization_id::text, 0));
  update accounting_fec_imports set status = 'withdrawn', ended_at = now()
   where organization_id = p_organization_id and id = p_import and status = 'active';
  trouve := found;
  if trouve then
    update accounting_monthly_balances set excluded_at = now()
     where organization_id = p_organization_id and source = 'fec' and sync_run = p_import and excluded_at is null;
  end if;
  return trouve;
end;
$$;

alter table accounting_fec_imports enable row level security;
alter table accounting_source_choices enable row level security;

revoke all on accounting_fec_imports, accounting_source_choices from public, anon, authenticated;
revoke all on function accounting_fec_import(uuid, text, text, date, date, boolean, jsonb, jsonb, jsonb, boolean, uuid) from public, anon, authenticated;
revoke all on function accounting_fec_withdraw(uuid, uuid) from public, anon, authenticated;
grant all on accounting_fec_imports, accounting_source_choices to service_role;
grant execute on function accounting_fec_import(uuid, text, text, date, date, boolean, jsonb, jsonb, jsonb, boolean, uuid) to service_role;
grant execute on function accounting_fec_withdraw(uuid, uuid) to service_role;

commit;

-- Retour arrière logique (à ne lancer que sur décision explicite) :
--   drop table accounting_source_choices, accounting_fec_imports;
--   drop function accounting_fec_import(uuid, text, text, date, date, boolean, jsonb, jsonb, jsonb, boolean, uuid);
--   drop function accounting_fec_withdraw(uuid, uuid);
--   alter table accounting_management_adjustments drop column nature, drop column covers_from, drop column covers_to;
--   alter table accounting_inventory_source_choices drop column element;
