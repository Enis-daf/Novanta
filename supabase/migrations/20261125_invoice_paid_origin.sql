-- Cockpit (module Futur) : origine du marquage « Payée » des factures — additif, non destructif.
-- Idempotent (réexécutable).
--
-- paid_origin = qui a marqué la facture Payée :
--  - 'manual' : case « Payée » cochée, ou action de « Vérifier mes données » ;
--  - 'sync'   : synchronisation Pennylane (facture soldée chez Pennylane) ;
--  - null     : facture non payée, ou payée avant cette migration (origine inconnue).
-- Sert uniquement au masquage des factures payées (lib/dates.ts::estFactureMasquee) : cochée à la
-- main, une facture reste visible 7 jours après le clic, sans repli sur l'échéance ni sur le
-- règlement réel (décision du 24/11/2026, cas réel KUBII FA451261). Les autres origines gardent la
-- règle actuelle. Aucune ligne existante n'est modifiée ici : null = règle actuelle.
-- Droits et politiques RLS des deux tables : inchangés.
--
-- Rollback logique : alter table ... drop column if exists paid_origin (sur les deux tables).
-- À exécuter AVANT le déploiement du code qui écrit paid_origin (sans la colonne, l'enregistrement
-- d'une facture échoue).

alter table customer_invoices add column if not exists paid_origin text;
alter table supplier_invoices add column if not exists paid_origin text;

alter table customer_invoices drop constraint if exists customer_invoices_paid_origin_check;
alter table customer_invoices add constraint customer_invoices_paid_origin_check
  check (paid_origin is null or paid_origin in ('manual', 'sync'));

alter table supplier_invoices drop constraint if exists supplier_invoices_paid_origin_check;
alter table supplier_invoices add constraint supplier_invoices_paid_origin_check
  check (paid_origin is null or paid_origin in ('manual', 'sync'));

notify pgrst, 'reload schema';
