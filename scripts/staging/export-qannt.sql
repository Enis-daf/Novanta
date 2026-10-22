-- Export EN LECTURE SEULE des données d'une société, à exécuter par Enis dans l'éditeur SQL de la
-- base d'origine. Un seul SELECT : aucune écriture, aucune fonction, aucune table temporaire.
--
-- 1. Remplacer <COMPANY_ID> par l'identifiant de la société à cloner.
-- 2. Exécuter, copier la valeur JSON renvoyée dans .staging/qannt-export.json (dossier ignoré par
--    Git — ne jamais commiter ce fichier).
-- 3. npm run staging:seed -- --export .staging/qannt-export.json
--
-- Volontairement absents : companies (colonnes Stripe, email de facturation), auth.users,
-- pennylane_connections (credential chiffré), et toutes les tables past_*.
select jsonb_build_object(
  'cash_settings',     (select to_jsonb(t) from cash_settings t where t.company_id = c.id),
  'fixed_charges',     coalesce((select jsonb_agg(to_jsonb(t)) from fixed_charges t where t.company_id = c.id), '[]'::jsonb),
  'recurring_income',  coalesce((select jsonb_agg(to_jsonb(t)) from recurring_income t where t.company_id = c.id), '[]'::jsonb),
  'supplier_invoices', coalesce((select jsonb_agg(to_jsonb(t)) from supplier_invoices t where t.company_id = c.id), '[]'::jsonb),
  'customer_invoices', coalesce((select jsonb_agg(to_jsonb(t)) from customer_invoices t where t.company_id = c.id), '[]'::jsonb),
  'other_expenses',    coalesce((select jsonb_agg(to_jsonb(t)) from other_expenses t where t.company_id = c.id), '[]'::jsonb),
  'financings',        coalesce((select jsonb_agg(to_jsonb(t)) from financings t where t.company_id = c.id), '[]'::jsonb)
) as export
from companies c
where c.id = '<COMPANY_ID>';
