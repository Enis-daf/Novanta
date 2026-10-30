-- P&L comptable : soldes mensuels lus dans la balance Pennylane — ADDITIF, idempotent (réexécutable).
-- Prérequis : 20261030_accounting_pnl.sql.
--
-- Décision du 30/10/2026, après le diagnostic réel de l'API : le P&L se fonde sur la balance mensuelle
-- (trial_balance, is_auxiliary=true), pas sur une copie des lignes d'écriture. Sur le dossier testé, la
-- balance concorde au centime avec les lignes, et elle évite de suivre des lignes réécrites en
-- permanence. accounting_entry_lines et accounting_balances restent en place, inutilisées et vides.
--
-- accounting_monthly_balances : un compte, un mois. excluded_at : le compte n'a plus été renvoyé par une
-- relecture complète de ce mois — écarté du calcul, jamais supprimé ; il revient si la source le renvoie.
--
-- Mêmes règles que les autres tables comptables : RLS activée, aucune policy, droits retirés au
-- navigateur ; tout passe par les routes app/api/passe/compta/*.
--
-- accounting_accounts_number : assouplie, aucune ligne existante n'est touchée. Le diagnostic a montré
-- de vrais numéros alphanumériques (une racine en chiffres, puis des lettres) que l'ancienne contrainte
-- refusait. Toute valeur acceptée avant reste acceptée.

begin;

create table if not exists accounting_monthly_balances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  source text not null check (source in ('pennylane', 'fixtures')),
  month date not null check (extract(day from month) = 1),
  account_number text not null,
  account_label text,
  debit numeric(16, 2) not null default 0,
  credit numeric(16, 2) not null default 0,
  sync_run uuid not null,
  excluded_at timestamptz,
  fetched_at timestamptz not null default now(),
  unique (organization_id, source, month, account_number),
  constraint accounting_monthly_balances_number check (account_number ~ '^[0-9][0-9A-Za-z]*$')
);

create index if not exists idx_accounting_monthly_balances_org_month
  on accounting_monthly_balances (organization_id, month);

alter table accounting_monthly_balances enable row level security;
revoke all on accounting_monthly_balances from public, anon, authenticated;
grant all on accounting_monthly_balances to service_role;

alter table accounting_accounts drop constraint if exists accounting_accounts_number;
alter table accounting_accounts add constraint accounting_accounts_number
  check (account_number ~ '^[0-9][0-9A-Za-z]*$');

commit;

-- Retour arrière logique (à ne lancer que sur décision explicite) :
--   drop table accounting_monthly_balances;
