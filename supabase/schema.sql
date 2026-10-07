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
  horizon_jours integer not null default 90 check (horizon_jours in (90, 180)),
  updated_at timestamptz not null default now()
);

-- Migration additive : ajoute les colonnes aux installations existantes
-- (sans effet si la table vient d'être créée ci-dessus). Aucune ligne existante
-- n'est supprimée ; horizon_jours vaut 90 par défaut pour toutes les sociétés
-- déjà présentes.
alter table cash_settings add column if not exists date_releve date not null default current_date;
alter table cash_settings add column if not exists horizon_jours integer not null default 90;
alter table cash_settings drop constraint if exists cash_settings_horizon_jours_check;
alter table cash_settings add constraint cash_settings_horizon_jours_check check (horizon_jours in (90, 180));

create table if not exists customer_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  facture text not null,
  client text not null,
  montant numeric not null,
  date_echeance date,
  date_encaissement_anticipee date,
  litigieuse boolean not null default false,
  paid boolean not null default false,
  paid_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Migration additive : ajoute la colonne aux installations existantes
-- (sans effet si la table vient d'être créée ci-dessus). Toutes les factures
-- existantes reçoivent paid = false, aucune ligne n'est supprimée ni modifiée
-- autrement.
alter table customer_invoices add column if not exists paid boolean not null default false;

-- Migration non destructive : autorise les dates vides (nouvelle ligne pas encore
-- complétée par l'utilisateur). Les factures existantes gardent leurs dates actuelles,
-- seule la contrainte NOT NULL est retirée.
alter table customer_invoices alter column date_echeance drop not null;
alter table customer_invoices alter column date_encaissement_anticipee drop not null;

-- Migration additive : horodatage du moment où "Payée" a été cochée, pour masquer
-- (affichage uniquement) les factures payées depuis plus de 7 jours. Nullable et sans
-- valeur par défaut à dessein : les factures déjà payées avant cette migration gardent
-- paid_at = null et restent donc visibles (voir explication fournie avant la migration).
alter table customer_invoices add column if not exists paid_at timestamptz;

create table if not exists supplier_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  facture text not null,
  fournisseur text not null,
  montant numeric not null,
  date_echeance date,
  date_paiement_prevue date,
  litigieuse boolean not null default false,
  paid boolean not null default false,
  paid_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Migration additive : idem pour les factures fournisseurs existantes.
alter table supplier_invoices add column if not exists paid boolean not null default false;
alter table supplier_invoices add column if not exists paid_at timestamptz;

-- Migration non destructive : idem, autorise les dates vides.
alter table supplier_invoices alter column date_echeance drop not null;
alter table supplier_invoices alter column date_paiement_prevue drop not null;

create table if not exists fixed_charges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  libelle text not null,
  montant numeric not null,
  date_prevue date,
  recurrence text not null default 'mensuel' check (recurrence in ('ponctuel', 'quotidien', 'hebdomadaire', 'mensuel')),
  date_fin date,
  updated_at timestamptz not null default now()
);

-- Migration non destructive : autorise les dates vides (nouvelle ligne pas encore complétée).
alter table fixed_charges alter column date_prevue drop not null;

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

-- Migration additive et non destructive : ajoute le support du "Montant calculé" pour les
-- Charges fixes uniquement (Rentrées régulières non concernées). Toutes les colonnes sont
-- nouvelles, nullables ou par défaut ; aucune colonne existante n'est modifiée ; aucune ligne
-- existante n'est touchée. Les charges fixes existantes reçoivent mode_montant = 'fixe' par
-- défaut et continuent de fonctionner exactement comme avant.
--
-- Pas de contrainte de clé étrangère sur source_calcul_id : elle peut référencer soit
-- fixed_charges(id) soit recurring_income(id) selon source_calcul_type (deux tables
-- différentes). La protection contre la suppression d'une ligne source utilisée, et
-- l'interdiction d'utiliser une charge déjà calculée comme source, sont appliquées côté
-- application (comme le reste du modèle de données, qui n'a aucune FK inter-entités).
--
-- La contrainte ci-dessous n'impose la cohérence que dans un sens : en mode "fixe", pas de
-- taux ni de source. Elle n'impose PAS que taux_calcul/source_calcul_id soient renseignés dès
-- le passage en mode "calcule", car l'application enregistre chaque champ au fil de la saisie
-- (comme pour tous les autres champs de cette table) — une ligne "calcule" incomplète est
-- traitée comme un montant indisponible côté applicatif, jamais comme une erreur bloquante.
alter table fixed_charges add column if not exists mode_montant text not null default 'fixe'
  check (mode_montant in ('fixe', 'calcule'));
alter table fixed_charges add column if not exists taux_calcul numeric;
alter table fixed_charges add column if not exists source_calcul_id uuid;
alter table fixed_charges add column if not exists source_calcul_type text
  check (source_calcul_type in ('charge_fixe', 'rentree_reguliere'));
alter table fixed_charges drop constraint if exists fixed_charges_mode_montant_coherent;
alter table fixed_charges add constraint fixed_charges_mode_montant_coherent check (
  mode_montant != 'fixe' or (taux_calcul is null and source_calcul_id is null and source_calcul_type is null)
);
alter table fixed_charges drop constraint if exists fixed_charges_source_calcul_pas_soi_meme;
alter table fixed_charges add constraint fixed_charges_source_calcul_pas_soi_meme check (
  source_calcul_type is distinct from 'charge_fixe' or source_calcul_id is distinct from id
);

create table if not exists other_expenses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  libelle text not null,
  montant numeric not null,
  date_prevue date,
  type text not null check (type in ('certaine', 'probable')),
  facturee boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Migration non destructive : autorise les dates vides.
alter table other_expenses alter column date_prevue drop not null;

-- Migration additive : "Facturée" (remplacée par une vraie facture fournisseur, exclue du calcul).
alter table other_expenses add column if not exists facturee boolean not null default false;

-- Migration additive : "Payée" (déjà comptée dans le solde bancaire initial, exclue du calcul).
-- Raison distincte de "facturee" mais même comportement d'exclusion des projections.
alter table other_expenses add column if not exists payee boolean not null default false;

create table if not exists financings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  libelle text not null,
  montant numeric not null,
  date_encaissement_prevue date,
  verse boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Migration non destructive : autorise les dates vides.
alter table financings alter column date_encaissement_prevue drop not null;

-- Migration additive : "Versé" (effectivement encaissé, exclu du calcul).
alter table financings add column if not exists verse boolean not null default false;

create table if not exists recurring_income (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  libelle text not null,
  montant numeric not null,
  date_debut date,
  frequence text not null check (frequence in ('ponctuel', 'quotidien', 'mensuel')),
  date_fin date,
  updated_at timestamptz not null default now()
);

-- Migration non destructive : autorise les dates vides.
alter table recurring_income alter column date_debut drop not null;

-- Migration additive et non destructive : ajoute le support du "Montant saisonnalisé" pour les
-- Rentrées régulières uniquement (les Charges fixes ne sont pas concernées). Toutes les colonnes
-- sont nouvelles, nullables ou avec valeur par défaut ; aucune colonne existante n'est modifiée ;
-- aucune ligne existante n'est touchée : mode_montant vaut 'fixe' par défaut, donc toutes les
-- rentrées déjà en base continuent de fonctionner exactement comme avant.
--
-- profil_saisonnalite (jsonb) contient { montantAnnuel: number, ponderationsMensuelles: number[12] }
-- — pas de 12 colonnes, pas de table séparée : une seule structure additive, lisible, dont la
-- validation (12 valeurs, total proche de 100 %) est faite côté application, comme le taux/la
-- source des Charges fixes calculées ne sont pas non plus validés en profondeur côté base.
--
-- La contrainte ci-dessous n'impose la cohérence que dans un sens : en mode "fixe", pas de
-- profil de saisonnalité. Elle n'impose PAS que profil_saisonnalite soit déjà complet dès le
-- passage en mode "saisonnalise" (même raisonnement que pour les Charges fixes calculées).
alter table recurring_income add column if not exists mode_montant text not null default 'fixe'
  check (mode_montant in ('fixe', 'saisonnalise'));
alter table recurring_income add column if not exists profil_saisonnalite jsonb;
alter table recurring_income drop constraint if exists recurring_income_mode_montant_coherent;
alter table recurring_income add constraint recurring_income_mode_montant_coherent check (
  mode_montant != 'fixe' or profil_saisonnalite is null
);

-- Migration additive et non destructive : élargit la fréquence des Rentrées régulières pour
-- autoriser "hebdomadaire" (alignement avec fixed_charges.recurrence, qui l'autorise déjà).
-- Nécessaire pour que la saisonnalité (toujours mensuelle en interne) puisse être répartie en
-- occurrences hebdomadaires, comme elle l'est déjà en quotidien/mensuel. Aucune ligne existante
-- n'est modifiée : les valeurs déjà en usage restent valides, "hebdomadaire" n'est qu'une
-- nouvelle valeur permise pour les prochaines saisies.
alter table recurring_income drop constraint if exists recurring_income_frequence_check;
alter table recurring_income add constraint recurring_income_frequence_check
  check (frequence in ('ponctuel', 'quotidien', 'hebdomadaire', 'mensuel'));

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

-- Migration additive : informations d'abonnement Stripe au niveau de la société
-- (branche stripe-billing). Toutes les colonnes sont nullable sauf access_enabled,
-- qui vaut true par défaut pour ne bloquer aucune société existante. Rien n'est
-- supprimé ni renommé. Écrite par le webhook Stripe via la clé service_role
-- (RLS ci-dessus ne s'applique pas à cette clé, donc pas de policy à ajouter).
alter table companies add column if not exists stripe_customer_id text;
alter table companies add column if not exists stripe_subscription_id text;
alter table companies add column if not exists subscription_status text;
alter table companies add column if not exists subscription_plan text;
alter table companies add column if not exists subscription_current_period_end timestamptz;
alter table companies add column if not exists billing_email text;
alter table companies add column if not exists access_enabled boolean not null default true;

create index if not exists idx_companies_stripe_customer on companies(stripe_customer_id);
create index if not exists idx_companies_stripe_subscription on companies(stripe_subscription_id);

-- Migration additive : prénom et nom de la personne responsable de la société,
-- saisis au formulaire d'inscription (branche stripe-billing). Nullable : les
-- comptes déjà existants gardent first_name/last_name à null, sans être bloqués.
alter table companies add column if not exists first_name text;
alter table companies add column if not exists last_name text;

-- Migration additive et non destructive : ajoute l'état de simulation "À couper" pour les
-- Charges fixes. Colonne nouvelle, not null avec valeur par défaut 'false' : toutes les
-- charges fixes existantes restent incluses dans le calcul exactement comme avant. Aucune
-- colonne existante n'est modifiée, renommée ou supprimée ; aucune ligne n'est touchée.
alter table fixed_charges add column if not exists a_couper boolean not null default false;

-- Intégration Pennylane MVP (Company API Token) — nouvelle table, additive, non destructive.
-- Stocke UNIQUEMENT le credential chiffré et son statut, jamais de transactions bancaires
-- (aucun ledger permanent, récupération à la demande uniquement). Aucun grant vers
-- "authenticated" : contrairement aux autres tables, l'accès n'est possible que via la clé
-- service_role dans des routes serveur, après vérification de l'ownership côté application
-- (company_id dérivé de l'utilisateur connecté, jamais fourni par le client) — voir
-- lib/pennylaneRepository.ts et lib/supabaseServer.ts::requireUser.
create table if not exists pennylane_connections (
  company_id uuid primary key references companies(id) on delete cascade,
  token_ciphertext text not null,
  status text not null default 'connected' check (status in ('connected', 'invalid')),
  last_tested_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table pennylane_connections enable row level security;

-- Modules activables par organisation (entitlements) : voir
-- migrations/20261007_organization_modules.sql pour le détail et la procédure d'activation.
create table if not exists organization_modules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  module_key text not null,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, module_key)
);

alter table organization_modules enable row level security;

drop policy if exists "Lecture des modules de sa société" on organization_modules;
create policy "Lecture des modules de sa société" on organization_modules
  for select
  using (organization_id in (select id from companies where owner_id = auth.uid()));

revoke all on public.organization_modules from anon;
revoke insert, update, delete, truncate on public.organization_modules from authenticated;
grant select on public.organization_modules to authenticated;

-- Module "Passé" : transactions internes normalisées (sources Pennylane / Excel). Voir
-- migrations/20261008_past_transactions.sql pour le modèle d'identité et les règles d'accès.
create table if not exists past_import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  source_type text not null default 'excel' check (source_type in ('excel')),
  file_name text,
  file_hash text,
  row_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (organization_id, file_hash)
);

create table if not exists past_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,

  source_type text not null check (source_type in ('pennylane', 'excel')),
  source_transaction_id text,
  import_batch_id uuid references past_import_batches(id) on delete cascade,
  source_row_index integer,

  transaction_date date not null,
  label text not null default '',
  amount numeric not null,
  currency text,

  source_created_at timestamptz,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint past_transactions_identite_source check (
    (source_type = 'pennylane' and source_transaction_id is not null)
    or (source_type = 'excel' and import_batch_id is not null and source_row_index is not null)
  ),
  -- Clé d'upsert Pennylane. Les lignes Excel (source_transaction_id null) n'entrent jamais en
  -- conflit ici : en SQL, deux NULL sont distincts dans une contrainte unique.
  constraint past_transactions_source_unique unique (organization_id, source_type, source_transaction_id),
  constraint past_transactions_ligne_lot_unique unique (import_batch_id, source_row_index)
);

alter table past_transactions drop column if exists analytic_category_id;
alter table past_transactions drop column if exists analytic_category_name;

create table if not exists past_analytic_groups (
  organization_id uuid not null references companies(id) on delete cascade,
  group_id text not null,
  name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, group_id)
);

create table if not exists past_transaction_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  transaction_id uuid not null references past_transactions(id) on delete cascade,
  analytic_group_id text not null,
  analytic_category_id text,
  analytic_category_name text not null,
  weight numeric not null default 1,
  created_at timestamptz not null default now()
);

-- Paramètres du module Passé, par organisation. reporting_analytic_group_id : l'axe analytique
-- utilisé par le module (null = non configuré ; jamais choisi arbitrairement par le code).
create table if not exists past_settings (
  organization_id uuid primary key references companies(id) on delete cascade,
  reporting_analytic_group_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_past_transaction_categories_transaction
  on past_transaction_categories(transaction_id);
create index if not exists idx_past_transaction_categories_org
  on past_transaction_categories(organization_id);
create index if not exists idx_past_transactions_org_date
  on past_transactions(organization_id, transaction_date desc);
create index if not exists idx_past_import_batches_org on past_import_batches(organization_id);

alter table past_import_batches enable row level security;
alter table past_transactions enable row level security;
alter table past_analytic_groups enable row level security;
alter table past_transaction_categories enable row level security;
alter table past_settings enable row level security;

drop policy if exists "Lecture des transactions Passé de sa société" on past_transactions;
create policy "Lecture des transactions Passé de sa société" on past_transactions
  for select
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_transactions.organization_id
        and m.module_key = 'past' and m.enabled
    )
  );

drop policy if exists "Import Excel Passé de sa société" on past_transactions;
create policy "Import Excel Passé de sa société" on past_transactions
  for insert
  with check (
    source_type = 'excel'
    and organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_transactions.organization_id
        and m.module_key = 'past' and m.enabled
    )
  );

drop policy if exists "Suppression import Excel Passé de sa société" on past_transactions;
create policy "Suppression import Excel Passé de sa société" on past_transactions
  for delete
  using (
    source_type = 'excel'
    and organization_id in (select id from companies where owner_id = auth.uid())
  );

drop policy if exists "Lots d'import Passé de sa société" on past_import_batches;
create policy "Lots d'import Passé de sa société" on past_import_batches
  for all
  using (organization_id in (select id from companies where owner_id = auth.uid()))
  with check (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_import_batches.organization_id
        and m.module_key = 'past' and m.enabled
    )
  );

drop policy if exists "Lecture des affectations analytiques de sa société" on past_transaction_categories;
create policy "Lecture des affectations analytiques de sa société" on past_transaction_categories
  for select
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_transaction_categories.organization_id
        and m.module_key = 'past' and m.enabled
    )
  );

-- Insertion côté client : uniquement pour une transaction Excel de sa propre organisation. La
-- suppression passe par la cascade depuis past_transactions (aucun droit delete direct).
drop policy if exists "Affectations d'un import Excel de sa société" on past_transaction_categories;
create policy "Affectations d'un import Excel de sa société" on past_transaction_categories
  for insert
  with check (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from past_transactions t
      where t.id = past_transaction_categories.transaction_id
        and t.organization_id = past_transaction_categories.organization_id
        and t.source_type = 'excel'
    )
  );

drop policy if exists "Lecture des axes analytiques de sa société" on past_analytic_groups;
create policy "Lecture des axes analytiques de sa société" on past_analytic_groups
  for select
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_analytic_groups.organization_id
        and m.module_key = 'past' and m.enabled
    )
  );

drop policy if exists "Axe Excel de sa société" on past_analytic_groups;
create policy "Axe Excel de sa société" on past_analytic_groups
  for insert
  with check (
    group_id = 'excel'
    and organization_id in (select id from companies where owner_id = auth.uid())
  );

drop policy if exists "Paramètres Passé de sa société" on past_settings;
create policy "Paramètres Passé de sa société" on past_settings
  for all
  using (organization_id in (select id from companies where owner_id = auth.uid()))
  with check (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_settings.organization_id
        and m.module_key = 'past' and m.enabled
    )
  );

revoke all on public.past_transactions from anon;
revoke all on public.past_import_batches from anon;
revoke update, truncate on public.past_transactions from authenticated;
revoke update, truncate on public.past_import_batches from authenticated;
grant select, insert, delete on public.past_transactions to authenticated;
grant select, insert, delete on public.past_import_batches to authenticated;

revoke all on public.past_analytic_groups from anon;
revoke all on public.past_transaction_categories from anon;
revoke all on public.past_settings from anon;
revoke update, delete, truncate on public.past_analytic_groups from authenticated;
revoke update, delete, truncate on public.past_transaction_categories from authenticated;
revoke delete, truncate on public.past_settings from authenticated;
grant select, insert on public.past_analytic_groups to authenticated;
grant select, insert on public.past_transaction_categories to authenticated;
grant select, insert, update on public.past_settings to authenticated;

-- Module "Passé" : correspondance catégorie source -> étage P&L. Voir
-- migrations/20261009_past_category_mappings.sql (modèle, droits, journal d'audit).
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
