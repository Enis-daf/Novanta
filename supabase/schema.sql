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
  updated_at timestamptz not null default now()
);

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
  recurrence text not null default 'mensuelle' check (recurrence in ('mensuelle', 'aucune')),
  updated_at timestamptz not null default now()
);

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

create index if not exists idx_customer_invoices_company on customer_invoices(company_id);
create index if not exists idx_supplier_invoices_company on supplier_invoices(company_id);
create index if not exists idx_fixed_charges_company on fixed_charges(company_id);
create index if not exists idx_other_expenses_company on other_expenses(company_id);
create index if not exists idx_financings_company on financings(company_id);

-- Row Level Security : chaque utilisateur ne voit que sa propre société et ses données.

alter table companies enable row level security;
alter table cash_settings enable row level security;
alter table customer_invoices enable row level security;
alter table supplier_invoices enable row level security;
alter table fixed_charges enable row level security;
alter table other_expenses enable row level security;
alter table financings enable row level security;

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
