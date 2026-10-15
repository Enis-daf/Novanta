-- Doublons de factures : décisions de l'utilisateur et montant source (lib/doublonsFactures.ts).
--
-- Additif et non destructif :
-- - 1 colonne nullable sur customer_invoices et sur supplier_invoices (aucune ligne modifiée) ;
-- - 1 nouvelle table ;
-- - aucune colonne existante modifiée, renommée ou supprimée.
--
-- source_amount : montant de la facture Pennylane, conservé à part quand une fusion a retenu un autre
-- montant pour la prévision. `montant` reste le montant des prévisions. NULL : rien à conserver.
--
-- invoice_duplicate_decisions : une ligne par paire de factures tranchée par l'utilisateur.
--  - 'distinct' : « Ce ne sont pas des doublons » — la paire n'est plus proposée ;
--  - 'merged'   : fusion confirmée. kept_invoice_id reste, removed_invoice_id est retirée ;
--    snapshot garde les deux lignes AVANT fusion, la ligne conservée APRÈS, et les choix faits
--    (historique et restauration possible à la main). removed_pennylane_id : identifiant Pennylane
--    de la ligne retirée, que la synchronisation ne réimporte plus.
-- Pas de clé étrangère vers les factures : une ligne fusionnée est retirée, sa décision demeure.
--
-- Atomique. Rollback logique : drop table invoice_duplicate_decisions ; alter table
-- customer_invoices drop column source_amount ; alter table supplier_invoices drop column
-- source_amount.

begin;

alter table customer_invoices add column if not exists source_amount numeric;
alter table supplier_invoices add column if not exists source_amount numeric;

create table if not exists invoice_duplicate_decisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  direction text not null check (direction in ('customer', 'supplier')),
  -- Paire triée : une seule décision par paire, quel que soit l'ordre d'affichage.
  first_invoice_id uuid not null,
  second_invoice_id uuid not null,
  decision text not null check (decision in ('merged', 'distinct')),
  kept_invoice_id uuid,
  removed_invoice_id uuid,
  removed_pennylane_id text,
  snapshot jsonb,
  decided_by uuid default auth.uid(),
  decided_at timestamptz not null default now(),
  constraint invoice_duplicate_decisions_ordre check (first_invoice_id < second_invoice_id),
  constraint invoice_duplicate_decisions_fusion check (
    decision <> 'merged' or (kept_invoice_id is not null and removed_invoice_id is not null and snapshot is not null)
  ),
  unique (company_id, direction, first_invoice_id, second_invoice_id)
);

create index if not exists idx_invoice_duplicate_decisions_company on invoice_duplicate_decisions(company_id);

alter table invoice_duplicate_decisions enable row level security;

drop policy if exists "Accès société" on invoice_duplicate_decisions;
create policy "Accès société" on invoice_duplicate_decisions
  for all
  using (company_id in (select id from companies where owner_id = auth.uid()))
  with check (company_id in (select id from companies where owner_id = auth.uid()));

grant select, insert, update, delete on public.invoice_duplicate_decisions to authenticated;

commit;

notify pgrst, 'reload schema';
