-- Factures prévisionnelles (module Futur, section Entrées) : factures que l'entreprise prévoit
-- d'émettre mais qui n'existent pas encore. Entité DISTINCTE de customer_invoices : une vraie
-- facture (saisie ou Pennylane) n'est jamais transformée en prévisionnelle, ni l'inverse.
-- Voir lib/facturesPrevisionnelles.ts.
--
-- Règle de double compte (appliquée par l'application, voir estPrevisionnelleActive) :
--   matched_at IS NULL     -> « À facturer » : compte dans la projection à date_encaissement_prevue ;
--   matched_at IS NOT NULL -> « Facturée » : rapprochée d'une vraie facture, ne compte plus jamais,
--                             quel que soit ensuite le statut de la vraie facture (Payée comprise).
--
-- Additif et non destructif :
-- - 1 nouvelle table, ses index, sa RLS et son déclencheur de suivi des modifications ;
-- - aucune table existante modifiée (aucune colonne ajoutée, renommée ou supprimée) ;
-- - aucune ligne existante lue, modifiée ou supprimée. Impact sur les données existantes : nul.
--
-- Atomique : tout le fichier s'exécute dans une seule transaction ; au moindre échec, rien n'est
-- appliqué. Idempotent : réexécutable sans effet.
--
-- Rollback (perd les prévisionnelles saisies depuis, rien d'autre) :
--   begin;
--   drop trigger if exists future_change_event on forecast_customer_invoices;
--   drop table if exists forecast_customer_invoices;
--   commit;

begin;

create table if not exists forecast_customer_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  client text not null default '',                 -- client ou libellé
  montant numeric not null default 0,
  date_facturation_prevue date,                    -- informative (rapprochement)
  date_encaissement_prevue date,                   -- pilote le cash
  -- Rapprochement avec une vraie facture. SET NULL, jamais CASCADE : la prévisionnelle survit à
  -- la suppression de sa vraie facture et reste « Facturée » (matched_at fait foi) — aucune
  -- annulation implicite ; la copie ci-dessous identifie toujours la facture concernée.
  customer_invoice_id uuid references customer_invoices(id) on delete set null,
  invoice_number text,
  invoice_pennylane_id text,                       -- réattachement d'une facture réimportée
  invoice_amount numeric,
  matched_at timestamptz,
  -- Vraies factures écartées par « Ignorer » (clés « pennylane:<id> » ou « id:<uuid> ») : plus
  -- jamais suggérées pour cette prévisionnelle. Sans effet sur le calcul.
  ignored_invoice_keys text[] not null default '{}',
  created_at timestamptz not null default now(),
  -- Posé par l'application à chaque modification (pas de trigger).
  updated_at timestamptz not null default now(),
  -- Un lien vers une facture implique un rapprochement daté avec sa copie.
  constraint forecast_customer_invoices_match_snapshot check (
    (matched_at is null and customer_invoice_id is null and invoice_number is null and invoice_amount is null and invoice_pennylane_id is null)
    or (matched_at is not null and invoice_number is not null and invoice_amount is not null)
  )
);

create index if not exists idx_forecast_customer_invoices_company
  on forecast_customer_invoices(company_id);
-- Une vraie facture ne remplace qu'une seule prévisionnelle (identité interne, puis Pennylane).
create unique index if not exists idx_forecast_customer_invoices_one_per_invoice
  on forecast_customer_invoices(customer_invoice_id)
  where customer_invoice_id is not null;
create unique index if not exists idx_forecast_customer_invoices_one_per_pennylane_invoice
  on forecast_customer_invoices(company_id, invoice_pennylane_id)
  where invoice_pennylane_id is not null;

alter table forecast_customer_invoices enable row level security;

-- Même règle d'accès que customer_invoices : la société de l'utilisateur connecté.
drop policy if exists "Accès société" on forecast_customer_invoices;
create policy "Accès société" on forecast_customer_invoices
  for all
  using (company_id in (select id from companies where owner_id = auth.uid()))
  with check (company_id in (select id from companies where owner_id = auth.uid()));

revoke all on public.forecast_customer_invoices from anon;
grant select, insert, update, delete on public.forecast_customer_invoices to authenticated;

-- Fiabilité de la projection : toute modification d'une prévisionnelle est tracée comme celles des
-- autres lignes de Futur (fonction de 20261026_future_forecast_reliability.sql), sinon une
-- référence pourrait être capturée « inchangée » à tort. Ignoré si cette migration n'est pas passée.
do $$
begin
  if to_regprocedure('public.future_noter_modification()') is not null then
    execute 'drop trigger if exists future_change_event on forecast_customer_invoices';
    execute 'create trigger future_change_event after insert or update or delete on forecast_customer_invoices for each row execute function future_noter_modification(''company_id'')';
  end if;
end;
$$;

commit;
