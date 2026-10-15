-- Module "Passé" : BFR historique — deux tables nouvelles, additives. Aucune table existante
-- modifiée, aucune donnée supprimée. Prérequis : companies, organization_modules.
--
-- 1. past_bfr_invoices : les faits Pennylane nécessaires au BFR, une ligne par facture (client ou
--    fournisseur), payées comprises. Écrite UNIQUEMENT par la route serveur /api/passe/bfr (clé
--    service_role, après vérification de l'utilisateur, de sa société et du module), relue par
--    l'organisation. Rafraîchie à chaque synchronisation : c'est l'état Pennylane du moment, à
--    partir duquel le solde de chaque facture à une date passée est reconstitué
--    (lib/pastBfr.ts). Jamais alimentée par les factures du module Futur.
--
-- 2. past_bfr_situations : les situations BFR VALIDÉES (photographies de gestion figées), une par
--    organisation et fin de mois. Les situations provisoires ne sont pas stockées : elles sont
--    recalculées à chaque lecture, donc toujours enrichies par la dernière synchronisation. Une
--    synchronisation n'écrit jamais dans cette table ; une modification n'y est possible que par
--    une révision explicite, tracée dans `revisions` (garanti par trigger).
--
-- Droits : lecture, validation et révision réservées à l'organisation propriétaire, module 'past'
-- activé — mêmes règles que les autres tables du module. Aucune suppression de situation validée.

create table if not exists past_bfr_invoices (
  organization_id uuid not null references companies(id) on delete cascade,
  invoice_type text not null check (invoice_type in ('customer', 'supplier')),
  pennylane_id text not null,
  invoice_number text not null,
  party_label text not null,
  issue_date date,
  due_date date,
  currency text not null default 'EUR',
  amount_incl_tax numeric not null,
  amount_excl_tax numeric,
  remaining_incl_tax numeric not null,
  remaining_excl_tax numeric,
  exclusion text check (exclusion in ('brouillon', 'archivee', 'annulee', 'avoir', 'hors_facture')),
  credited_pennylane_id text,
  -- Transactions bancaires rapprochées : [{ "date": "YYYY-MM-DD", "montant": 123.45 }].
  -- null = pas encore récupérées (ou inutiles : rien n'est réglé).
  settlements jsonb,
  pennylane_updated_at timestamptz,
  synced_at timestamptz not null,
  primary key (organization_id, invoice_type, pennylane_id)
);

create index if not exists past_bfr_invoices_issue_date on past_bfr_invoices (organization_id, issue_date);

create table if not exists past_bfr_situations (
  organization_id uuid not null references companies(id) on delete cascade,
  reference_date date not null,
  receivables_excl_tax numeric not null,
  inventory_excl_tax numeric not null,
  payables_excl_tax numeric not null,
  working_capital_excl_tax numeric not null,
  computed_at timestamptz not null,
  data_synced_on date,
  -- Factures retenues et leur solde HT à la date de référence : de quoi expliquer le chiffre.
  receivables_lines jsonb not null default '[]'::jsonb,
  payables_lines jsonb not null default '[]'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  validated_at timestamptz not null default now(),
  validated_by uuid default auth.uid(),
  -- Versions remplacées par des révisions explicites, de la plus ancienne à la plus récente.
  revisions jsonb not null default '[]'::jsonb,
  primary key (organization_id, reference_date),
  constraint past_bfr_situations_formule check (
    abs(working_capital_excl_tax - (receivables_excl_tax + inventory_excl_tax - payables_excl_tax)) < 0.01
  )
);

-- Une situation validée ne change jamais en silence : toute mise à jour doit ajouter une révision.
create or replace function past_bfr_revision_obligatoire()
returns trigger
language plpgsql
as $$
begin
  if jsonb_array_length(new.revisions) <= jsonb_array_length(old.revisions) then
    raise exception 'Une situation BFR validée ne se modifie que par une révision tracée.';
  end if;
  return new;
end;
$$;

drop trigger if exists past_bfr_situations_revision on past_bfr_situations;
create trigger past_bfr_situations_revision
  before update on past_bfr_situations
  for each row execute function past_bfr_revision_obligatoire();

alter table past_bfr_invoices enable row level security;
alter table past_bfr_situations enable row level security;

drop policy if exists "Lecture des factures BFR de sa société" on past_bfr_invoices;
create policy "Lecture des factures BFR de sa société" on past_bfr_invoices
  for select
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_bfr_invoices.organization_id
        and m.module_key = 'past' and m.enabled
    )
  );

-- Lecture, validation et révision ; pas de suppression : une photographie validée reste.
drop policy if exists "Lecture des situations BFR de sa société" on past_bfr_situations;
create policy "Lecture des situations BFR de sa société" on past_bfr_situations
  for select
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_bfr_situations.organization_id
        and m.module_key = 'past' and m.enabled
    )
  );

drop policy if exists "Validation d'une situation BFR de sa société" on past_bfr_situations;
create policy "Validation d'une situation BFR de sa société" on past_bfr_situations
  for insert
  with check (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_bfr_situations.organization_id
        and m.module_key = 'past' and m.enabled
    )
  );

drop policy if exists "Révision d'une situation BFR de sa société" on past_bfr_situations;
create policy "Révision d'une situation BFR de sa société" on past_bfr_situations
  for update
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_bfr_situations.organization_id
        and m.module_key = 'past' and m.enabled
    )
  )
  with check (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_bfr_situations.organization_id
        and m.module_key = 'past' and m.enabled
    )
  );
