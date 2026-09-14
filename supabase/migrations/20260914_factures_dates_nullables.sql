-- Corrige une dérive de schéma découverte en diagnostic (échec total et silencieux de la
-- synchronisation Pennylane fournisseurs chez un client : `supplier_invoices` restait à 0 ligne
-- quel que soit le nombre de factures Pennylane réellement synchronisées).
--
-- Cause : schema.sql (référence consolidée) documentait déjà ces 4 colonnes comme nullables
-- (une facture nouvellement ajoutée, ou importée sans date Pennylane disponible, peut ne pas
-- encore avoir de date choisie — voir lib/supabaseRepository.ts, dateOuNull), mais ce
-- "drop not null" n'existait qu'à l'intérieur de schema.sql, jamais comme migration datée
-- séparée. Tout projet Supabase provisionné avant l'ajout de ces lignes à schema.sql, et
-- jamais entièrement rejoué depuis, a donc conservé ces colonnes en NOT NULL.
--
-- Conséquence concrète : une seule facture Pennylane sans échéance NI date (candidat avec
-- dateEcheance = "" -> convertie en NULL par dateOuNull) suffisait à faire échouer l'intégralité
-- du lot d'import (INSERT multi-lignes non résilient à l'époque du diagnostic — voir aussi le
-- fix d'atomicité apporté séparément à lib/supabaseRepository.ts), sans jamais remonter
-- d'erreur visible à l'utilisateur.
--
-- Additif et non destructif :
-- - Assouplit une contrainte existante (NOT NULL -> nullable), ne touche aucune ligne existante.
-- - Idempotent : DROP NOT NULL sur une colonne déjà nullable ne fait rien (pas d'erreur).
-- - Aucune colonne renommée, supprimée ; aucune table vidée, tronquée ou recréée.

alter table customer_invoices alter column date_echeance drop not null;
alter table customer_invoices alter column date_encaissement_anticipee drop not null;
alter table supplier_invoices alter column date_echeance drop not null;
alter table supplier_invoices alter column date_paiement_prevue drop not null;
