-- Module "Futur" : étage P&L des dépenses (charges fixes, factures fournisseurs, autres dépenses).
-- Additif et non destructif. Idempotent (réexécutable).
--
-- Même nomenclature que Passé (lib/pastCategoryMapping.ts::ETAGES_PNL), sans l'étage
-- « Encaissements » : on ne classe ici que des dépenses.
--
-- Trois notions, sans rien dupliquer :
--   - choix manuel : pnl_stage_manual (null = aucun choix explicite dans Futur) ;
--   - étage automatique : JAMAIS stocké. Il se résout à la lecture, comme dans Passé :
--     facture -> catégories Pennylane (pennylane_categories) -> past_category_mappings -> étage.
--     Changer la correspondance reclasse donc toutes les factures sans choix manuel ;
--   - étage utilisé : choix manuel s'il existe, sinon étage automatique, sinon « À classer ».
-- Aucune ligne existante n'est classée par cette migration : toutes restent « À classer ».
-- Aucune table de mapping n'est créée ni modifiée : Futur relit la correspondance de Passé.
--
-- pennylane_categories : catégories analytiques de la facture telles que Pennylane les renvoie
-- (GET /supplier_invoices/{id}/categories) — [{ id, label, groupId, weight }]. null = jamais lues ;
-- [] = lues, aucune catégorie. Écrite par la route serveur /api/pennylane/invoices/categories
-- seulement ; aucune incidence sur le montant, l'échéance, la date prévue ou la trésorerie.
--
-- Droits : les politiques RLS « Accès société » existantes des trois tables s'appliquent telles
-- quelles (organisation de l'utilisateur connecté).
--
-- Rollback logique : drop function future_pnl_correspondance(); puis
--   alter table <table> drop column pnl_stage_manual (x3),
--   alter table supplier_invoices drop column pennylane_categories, drop column pennylane_categories_synced_at.

begin;

alter table fixed_charges add column if not exists pnl_stage_manual text;
alter table other_expenses add column if not exists pnl_stage_manual text;
alter table supplier_invoices add column if not exists pnl_stage_manual text;
alter table supplier_invoices add column if not exists pennylane_categories jsonb;
alter table supplier_invoices add column if not exists pennylane_categories_synced_at timestamptz;

alter table fixed_charges drop constraint if exists fixed_charges_pnl_stage_manual_check;
alter table fixed_charges add constraint fixed_charges_pnl_stage_manual_check
  check (pnl_stage_manual is null or pnl_stage_manual in ('gross_margin', 'contribution_margin', 'ebitda', 'extra_pnl', 'vat', 'financing'));
alter table other_expenses drop constraint if exists other_expenses_pnl_stage_manual_check;
alter table other_expenses add constraint other_expenses_pnl_stage_manual_check
  check (pnl_stage_manual is null or pnl_stage_manual in ('gross_margin', 'contribution_margin', 'ebitda', 'extra_pnl', 'vat', 'financing'));
alter table supplier_invoices drop constraint if exists supplier_invoices_pnl_stage_manual_check;
alter table supplier_invoices add constraint supplier_invoices_pnl_stage_manual_check
  check (pnl_stage_manual is null or pnl_stage_manual in ('gross_margin', 'contribution_margin', 'ebitda', 'extra_pnl', 'vat', 'financing'));

-- Correspondance catégorie -> étage, lisible depuis Futur SANS le module Passé.
-- La RLS de past_category_mappings exige le module Passé : un utilisateur Futur seul n'y a pas
-- accès, et ce droit n'est pas élargi. Cette fonction ne renvoie que le strict nécessaire au
-- classement — identifiant de catégorie, axe, étage ; ni nom, ni montant, ni historique — pour la
-- SEULE société de l'utilisateur connecté (auth.uid()), et seulement les catégories rattachées.
-- Lecture seule : aucune écriture possible par ce biais.
create or replace function future_pnl_correspondance()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'axe', (select s.reporting_analytic_group_id from past_settings s where s.organization_id = c.id),
    'correspondances', coalesce(
      (select jsonb_agg(jsonb_build_object('id', m.source_category_id, 'axe', m.source_group_id, 'etage', m.pnl_stage))
       from past_category_mappings m
       where m.organization_id = c.id and m.pnl_stage is not null),
      '[]'::jsonb
    )
  )
  from companies c
  where c.owner_id = auth.uid();
$$;

revoke all on function future_pnl_correspondance() from public;
revoke all on function future_pnl_correspondance() from anon;
grant execute on function future_pnl_correspondance() to authenticated;

commit;

notify pgrst, 'reload schema';
