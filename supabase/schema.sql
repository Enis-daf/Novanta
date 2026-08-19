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
