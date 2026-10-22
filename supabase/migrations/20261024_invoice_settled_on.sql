-- Cockpit (module Futur) : date de règlement réel des factures — additif, non destructif.
-- Idempotent (réexécutable).
--
-- settled_on = date de la dernière transaction bancaire rapprochée de la facture chez Pennylane.
-- Sert uniquement à masquer une facture payée 7 jours après son règlement réel, au lieu de 7 jours
-- après son marquage « Payée » dans Novanta (paid_at, inchangé). Nullable, sans valeur par défaut :
-- facture saisie dans Novanta, ou payée chez Pennylane sans transaction rapprochée -> null, et le
-- masquage continue de partir de paid_at. Écrite par la route serveur
-- /api/pennylane/invoices/settlement seulement ; aucune ligne existante n'est modifiée ici.
-- Droits et politiques RLS des deux tables : inchangés.

alter table customer_invoices add column if not exists settled_on date;
alter table supplier_invoices add column if not exists settled_on date;
