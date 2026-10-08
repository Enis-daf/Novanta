-- Module "Passé" : transactions internes normalisées — nouvelles tables, additives, non destructives.
-- Aucune table existante modifiée, aucune donnée supprimée. Prérequis : organization_modules
-- (20261007_organization_modules.sql).
--
-- Le module Passé ne lit jamais Pennylane directement : il lit past_transactions, alimentée par
-- une source (Pennylane aujourd'hui, Excel ensuite) après normalisation. Le reste du produit n'a
-- pas à savoir d'où vient une transaction.
--
-- Identité d'une ligne, selon la source :
--   - pennylane : (organization_id, source_type, source_transaction_id) — l'identifiant stable de
--     la transaction côté Pennylane. C'est la clé d'upsert : une resynchronisation met à jour la
--     ligne existante (libellé, montant, date, catégorie), jamais de doublon.
--   - excel : (import_batch_id, source_row_index) — la position de la ligne dans SON fichier.
--     Volontairement PAS de dédoublonnage par date + montant + libellé : deux vraies transactions
--     identiques le même jour doivent rester deux lignes. Le doublon évident (même fichier importé
--     deux fois) est bloqué au niveau du lot, par l'empreinte du fichier (past_import_batches).
--     Supprimer un lot supprime ses lignes (on delete cascade) : remplacer un import = supprimer le
--     lot puis réimporter.
--
-- Catégories analytiques : une transaction peut porter PLUSIEURS affectations (ventilation
-- pondérée, ou une catégorie par axe analytique). Elles sont toutes conservées dans
-- past_transaction_categories ; past_transactions ne porte volontairement aucune catégorie. La
-- catégorie "principale" affichée par le module est dérivée à la lecture, à partir de l'axe choisi
-- par l'organisation (past_settings.reporting_analytic_group_id) — jamais figée à la
-- synchronisation. past_analytic_groups liste les axes connus de l'organisation (les groupes de
-- catégories Pennylane ; le groupe 'excel' pour la colonne catégorie d'un import Excel).
--
-- Ce fichier est idempotent : il peut être réexécuté sur une base où une version précédente a
-- déjà été appliquée (les deux colonnes de catégorie alors présentes sur past_transactions sont
-- retirées ; une resynchronisation recrée les affectations).
--
-- Sécurité (mêmes principes que le reste du schéma) :
--   - lecture : uniquement les lignes de sa propre organisation, ET seulement si le module 'past'
--     y est activé ;
--   - écriture côté client ("authenticated") : limitée aux lots et lignes Excel de sa propre
--     organisation ;
--   - les lignes Pennylane ne sont écrites que par la route serveur de synchronisation (clé
--     service_role, après vérification de l'utilisateur, de sa société et du module).

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
