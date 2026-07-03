-- Cockpit tactique de trésorerie — schéma Supabase
-- Authentification Supabase Auth : une société par utilisateur (pas d'équipe, pas d'invitations).
-- RLS activé sur toutes les tables, scoping par owner_id / company_id.

create extension if not exists "pgcrypto";

create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  name text not null default 'Ma société',
  created_at timestamptz not null default now()
);

create table if not exists cash_settings (
  company_id uuid primary key references companies(id) on delete cascade,
  solde_initial numeric not null default 0,
  date_releve date not null default current_date,
  updated_at timestamptz not null default now()
);

-- Migration additive : ajoute la colonne aux installations existantes
-- (sans effet si la table vient d'être créée ci-dessus).
alter table cash_settings add column if not exists date_releve date not null default current_date;

create table if not exists customer_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  facture text not null,
  client text not null,
  montant numeric not null,
  date_echeance date not null,
  date_encaissement_anticipee date not null,
  litigieuse boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists supplier_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  facture text not null,
  fournisseur text not null,
  montant numeric not null,
  date_echeance date not null,
  date_paiement_prevue date not null,
  litigieuse boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists fixed_charges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  libelle text not null,
  montant numeric not null,
  date_prevue date not null,
  recurrence text not null default 'mensuel' check (recurrence in ('ponctuel', 'quotidien', 'hebdomadaire', 'mensuel')),
  date_fin date,
  updated_at timestamptz not null default now()
);

-- Migration additive : ajoute la colonne date_fin, renomme le vocabulaire de récurrence
-- vers celui partagé avec les rentrées régulières puis élargit la contrainte pour
-- accepter "hebdomadaire" (sans effet si la table vient d'être créée ci-dessus).
-- L'ancienne contrainte doit être retirée AVANT le renommage des valeurs : sinon les
-- UPDATE ci-dessous sont rejetés car 'ponctuel'/'mensuel' ne sont pas encore autorisés.
alter table fixed_charges add column if not exists date_fin date;
alter table fixed_charges drop constraint if exists fixed_charges_recurrence_check;
update fixed_charges set recurrence = 'ponctuel' where recurrence = 'aucune';
update fixed_charges set recurrence = 'mensuel' where recurrence = 'mensuelle';
alter table fixed_charges alter column recurrence set default 'mensuel';
alter table fixed_charges add constraint fixed_charges_recurrence_check
  check (recurrence in ('ponctuel', 'quotidien', 'hebdomadaire', 'mensuel'));

create table if not exists other_expenses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  libelle text not null,
  montant numeric not null,
  date_prevue date not null,
  type text not null check (type in ('certaine', 'probable')),
  updated_at timestamptz not null default now()
);

create table if not exists financings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  libelle text not null,
  montant numeric not null,
  date_encaissement_prevue date not null,
  updated_at timestamptz not null default now()
);

create table if not exists recurring_income (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  libelle text not null,
  montant numeric not null,
  date_debut date not null,
  frequence text not null check (frequence in ('ponctuel', 'quotidien', 'mensuel')),
  date_fin date,
  updated_at timestamptz not null default now()
);

create index if not exists idx_customer_invoices_company on customer_invoices(company_id);
create index if not exists idx_supplier_invoices_company on supplier_invoices(company_id);
create index if not exists idx_fixed_charges_company on fixed_charges(company_id);
create index if not exists idx_other_expenses_company on other_expenses(company_id);
create index if not exists idx_financings_company on financings(company_id);
create index if not exists idx_recurring_income_company on recurring_income(company_id);

-- Row Level Security : chaque utilisateur ne voit que sa propre société et ses données.

alter table companies enable row level security;
alter table cash_settings enable row level security;
alter table customer_invoices enable row level security;
alter table supplier_invoices enable row level security;
alter table fixed_charges enable row level security;
alter table other_expenses enable row level security;
alter table financings enable row level security;
alter table recurring_income enable row level security;

create policy "Un utilisateur gère sa société" on companies
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "Accès société" on cash_settings
  for all
  using (company_id in (select id from companies where owner_id = auth.uid()))
  with check (company_id in (select id from companies where owner_id = auth.uid()));

create policy "Accès société" on customer_invoices
  for all
  using (company_id in (select id from companies where owner_id = auth.uid()))
  with check (company_id in (select id from companies where owner_id = auth.uid()));

create policy "Accès société" on supplier_invoices
  for all
  using (company_id in (select id from companies where owner_id = auth.uid()))
  with check (company_id in (select id from companies where owner_id = auth.uid()));

create policy "Accès société" on fixed_charges
  for all
  using (company_id in (select id from companies where owner_id = auth.uid()))
  with check (company_id in (select id from companies where owner_id = auth.uid()));

create policy "Accès société" on other_expenses
  for all
  using (company_id in (select id from companies where owner_id = auth.uid()))
  with check (company_id in (select id from companies where owner_id = auth.uid()));

create policy "Accès société" on financings
  for all
  using (company_id in (select id from companies where owner_id = auth.uid()))
  with check (company_id in (select id from companies where owner_id = auth.uid()));

create policy "Accès société" on recurring_income
  for all
  using (company_id in (select id from companies where owner_id = auth.uid()))
  with check (company_id in (select id from companies where owner_id = auth.uid()));
