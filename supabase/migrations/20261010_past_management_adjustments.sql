-- Module "Passé" : ajustements de gestion et stocks de fin de mois — nouvelles tables, additives,
-- non destructives. Prérequis : 20261007_organization_modules.sql. Idempotent (réexécutable).
--
-- Un ajustement de gestion est une écriture analytique NON bancaire, rattachée à un étage P&L : il
-- entre dans les KPI et le P&L, mais vit dans sa propre table et n'est jamais une transaction
-- (past_transactions n'est pas touchée).
--
-- Deux tables :
--   - past_management_adjustments : ajustements saisis tels quels (provision, reclassement,
--     correction...). Générique : type, étage, montant, date, libellé.
--   - past_inventory_balances : stocks de fin de mois, la seule chose que l'utilisateur saisit
--     pour le premier type d'ajustement, la variation de stock.
--
-- La variation de stock (stock fin N − stock précédent, rattachée à gross_margin, datée de la fin
-- du mois) n'est PAS écrite dans past_management_adjustments : elle est calculée à la lecture à
-- partir des stocks (lib/pastAdjustments.ts). Modifier ou supprimer un stock recalcule donc toute
-- la série sans rien à resynchroniser, et aucun ajustement ne peut rester orphelin.
--
-- Sécurité : lecture limitée à sa propre organisation, module 'past' activé. Les stocks sont
-- modifiables par l'utilisateur ; les ajustements saisis sont en lecture seule côté client tant
-- qu'aucun écran de saisie n'existe. Auteur et dates sont posés par trigger, jamais par le client.

create table if not exists past_management_adjustments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  adjustment_date date not null,
  label text not null,
  amount numeric not null,
  pnl_stage text not null check (pnl_stage in ('revenue', 'gross_margin', 'contribution_margin', 'ebitda', 'extra_pnl')),
  adjustment_type text not null check (adjustment_type <> ''),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid
);

create table if not exists past_inventory_balances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  -- Toujours le premier jour du mois : une seule valeur de stock par mois et par organisation.
  month date not null check (month = date_trunc('month', month)::date),
  ending_inventory_value numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (organization_id, month)
);

create index if not exists idx_past_management_adjustments_org_date
  on past_management_adjustments(organization_id, adjustment_date);

-- Auteur et horodatage, communs aux deux tables.
create or replace function past_poser_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists past_management_adjustments_audit on past_management_adjustments;
create trigger past_management_adjustments_audit
  before insert or update on past_management_adjustments
  for each row execute function past_poser_audit();

drop trigger if exists past_inventory_balances_audit on past_inventory_balances;
create trigger past_inventory_balances_audit
  before insert or update on past_inventory_balances
  for each row execute function past_poser_audit();

alter table past_management_adjustments enable row level security;
alter table past_inventory_balances enable row level security;

drop policy if exists "Lecture des ajustements de gestion de sa société" on past_management_adjustments;
create policy "Lecture des ajustements de gestion de sa société" on past_management_adjustments
  for select
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_management_adjustments.organization_id
        and m.module_key = 'past' and m.enabled
    )
  );

drop policy if exists "Stocks de fin de mois de sa société" on past_inventory_balances;
create policy "Stocks de fin de mois de sa société" on past_inventory_balances
  for all
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_inventory_balances.organization_id
        and m.module_key = 'past' and m.enabled
    )
  )
  with check (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_inventory_balances.organization_id
        and m.module_key = 'past' and m.enabled
    )
  );

revoke all on public.past_management_adjustments from anon;
revoke all on public.past_inventory_balances from anon;
revoke insert, update, delete, truncate on public.past_management_adjustments from authenticated;
revoke truncate on public.past_inventory_balances from authenticated;
grant select on public.past_management_adjustments to authenticated;
grant select, insert, update, delete on public.past_inventory_balances to authenticated;
