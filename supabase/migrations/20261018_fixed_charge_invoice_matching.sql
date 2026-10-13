-- Rapprochement Facture fournisseur <-> occurrence de Charge fixe : évite de compter deux fois une
-- dépense déjà prévue en Charge fixe quand sa facture réelle arrive (voir
-- lib/rapprochementChargesFixes.ts).
--
-- Additif et non destructif :
-- - 1 colonne nullable ajoutée à supplier_invoices (aucune ligne existante modifiée) ;
-- - 2 nouvelles tables ;
-- - aucune colonne existante modifiée, renommée ou supprimée, aucune table vidée ou recréée.
--
-- Atomique : tout le fichier s'exécute dans une seule transaction ; au moindre échec, rien n'est
-- appliqué.
--
-- Rollback logique : drop table fixed_charge_supplier_mappings ; drop table
-- fixed_charge_invoice_links ; alter table supplier_invoices drop column pennylane_supplier_id.

begin;

-- Identité stable du fournisseur côté Pennylane (supplier.id de la liste supplier_invoices).
-- NULL pour une facture saisie à la main, importée par fichier, ou synchronisée avant cette
-- migration (renseignée ensuite par la synchronisation, uniquement via pennylane_id).
alter table supplier_invoices add column if not exists pennylane_supplier_id text;

-- Une ligne par décision de l'utilisateur sur un couple facture <-> occurrence de Charge fixe :
--  - 'confirmed' : la facture remplace l'occurrence (fixed_charge_id, occurrence_date), qui ne
--    génère plus de flux prévisionnel. Indépendant de supplier_invoices.paid : l'occurrence reste
--    remplacée quand la facture passe Payée.
--  - 'rejected' : « Ce n'est pas la même dépense » — ce couple n'est plus reproposé.
create table if not exists fixed_charge_invoice_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  fixed_charge_id uuid not null references fixed_charges(id) on delete cascade,
  -- SET NULL, jamais CASCADE : une décision survit à la suppression de sa facture (suppression
  -- manuelle ou version archivée dans Pennylane). Un rapprochement confirmé garde son occurrence
  -- remplacée ; le lien sans facture est signalé « à revoir » par l'application (état dérivé,
  -- non stocké).
  supplier_invoice_id uuid references supplier_invoices(id) on delete set null,
  occurrence_date date not null,
  status text not null check (status in ('confirmed', 'rejected')),
  -- Copie de la facture au moment de la décision : identifie durablement la facture concernée,
  -- même si elle n'existe plus dans supplier_invoices. invoice_pennylane_id est renseigné par
  -- l'application pour toute facture issue de Pennylane, confirmée comme refusée : c'est lui qui
  -- permet de reconnaître la décision quand la même facture est réimportée sous un nouvel
  -- identifiant interne.
  invoice_label text,
  supplier_label text,
  invoice_amount numeric,
  invoice_cash_date date,
  invoice_pennylane_id text,
  supplier_pennylane_id text,
  -- Renseigné quand l'utilisateur choisit « Laisser remplacée » sur un lien dont la facture a
  -- disparu : l'avertissement « à revoir » n'est plus affiché pour ce lien.
  review_dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  -- Posé par l'application à chaque modification (pas de trigger).
  updated_at timestamptz not null default now(),
  constraint fixed_charge_invoice_links_confirmed_snapshot check (
    status <> 'confirmed' or (invoice_amount is not null and supplier_label is not null)
  )
);

-- Une seule décision par couple facture <-> Charge fixe, sur l'identité interne...
create unique index if not exists idx_fc_invoice_links_pair
  on fixed_charge_invoice_links(supplier_invoice_id, fixed_charge_id)
  where supplier_invoice_id is not null;
-- ... et sur l'identité Pennylane : une facture réimportée sous un nouvel identifiant interne ne
-- peut ni recréer un rapprochement déjà confirmé, ni rouvrir un couple déjà refusé.
create unique index if not exists idx_fc_invoice_links_pair_pennylane
  on fixed_charge_invoice_links(company_id, invoice_pennylane_id, fixed_charge_id)
  where invoice_pennylane_id is not null;
-- Une facture ne remplace qu'une seule occurrence (identité interne, puis identité Pennylane).
create unique index if not exists idx_fc_invoice_links_one_per_invoice
  on fixed_charge_invoice_links(supplier_invoice_id)
  where status = 'confirmed' and supplier_invoice_id is not null;
create unique index if not exists idx_fc_invoice_links_one_per_pennylane_invoice
  on fixed_charge_invoice_links(company_id, invoice_pennylane_id)
  where status = 'confirmed' and invoice_pennylane_id is not null;
-- Une occurrence n'est remplacée que par une seule facture.
create unique index if not exists idx_fc_invoice_links_one_per_occurrence
  on fixed_charge_invoice_links(fixed_charge_id, occurrence_date)
  where status = 'confirmed';
create index if not exists idx_fc_invoice_links_company
  on fixed_charge_invoice_links(company_id);

-- Mémoire fournisseur <-> Charge fixe, écrite à chaque confirmation (suggérée ou manuelle).
-- L'identifiant Pennylane du fournisseur fait foi quand il existe ; le nom normalisé ne sert de
-- repli que pour un fournisseur sans identifiant Pennylane. Un même fournisseur peut être associé
-- à plusieurs Charges fixes (plusieurs prestations récurrentes) : l'unicité inclut la charge.
create table if not exists fixed_charge_supplier_mappings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  fixed_charge_id uuid not null references fixed_charges(id) on delete cascade,
  pennylane_supplier_id text,
  supplier_name_key text not null check (supplier_name_key <> ''),
  supplier_label text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_fc_supplier_mappings_by_id
  on fixed_charge_supplier_mappings(company_id, fixed_charge_id, pennylane_supplier_id)
  where pennylane_supplier_id is not null;
create unique index if not exists idx_fc_supplier_mappings_by_name
  on fixed_charge_supplier_mappings(company_id, fixed_charge_id, supplier_name_key)
  where pennylane_supplier_id is null;

alter table fixed_charge_invoice_links enable row level security;
alter table fixed_charge_supplier_mappings enable row level security;

-- Même règle d'accès que fixed_charges et supplier_invoices : la société de l'utilisateur connecté.
drop policy if exists "Accès société" on fixed_charge_invoice_links;
create policy "Accès société" on fixed_charge_invoice_links
  for all
  using (company_id in (select id from companies where owner_id = auth.uid()))
  with check (company_id in (select id from companies where owner_id = auth.uid()));

drop policy if exists "Accès société" on fixed_charge_supplier_mappings;
create policy "Accès société" on fixed_charge_supplier_mappings
  for all
  using (company_id in (select id from companies where owner_id = auth.uid()))
  with check (company_id in (select id from companies where owner_id = auth.uid()));

revoke all on public.fixed_charge_invoice_links from anon;
revoke all on public.fixed_charge_supplier_mappings from anon;
grant select, insert, update, delete on public.fixed_charge_invoice_links to authenticated;
grant select, insert, update, delete on public.fixed_charge_supplier_mappings to authenticated;

commit;
