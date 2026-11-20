-- Prévision probabiliste : hypothèses sur les factures prévisionnelles (forecast_customer_invoices,
-- migration 20261118). Élargit les deux CHECK de forecast_event_assumptions (20261112) à la source
-- 'facture_previsionnelle'. Aucune donnée modifiée ni supprimée ; toutes les valeurs déjà
-- autorisées le restent. Idempotent (réexécutable). Retour arrière : voir en fin de fichier.
--
-- Les CHECK d'origine sont des contraintes de colonne sans nom explicite : Postgres les a nommées
-- <table>_<colonne>_check. Elles sont remplacées par des contraintes nommées.

alter table forecast_event_assumptions drop constraint if exists forecast_event_assumptions_source_type_check;
alter table forecast_event_assumptions drop constraint if exists forecast_assumptions_source_type;
alter table forecast_event_assumptions add constraint forecast_assumptions_source_type
  check (source_type in ('facture_client', 'facture_previsionnelle', 'facture_fournisseur', 'financement', 'charge_fixe', 'autre_depense', 'rentree_reguliere'));

alter table forecast_event_assumptions drop constraint if exists forecast_event_assumptions_parent_source_type_check;
alter table forecast_event_assumptions drop constraint if exists forecast_assumptions_parent_source_type;
alter table forecast_event_assumptions add constraint forecast_assumptions_parent_source_type
  check (parent_source_type is null or parent_source_type in ('facture_client', 'facture_previsionnelle', 'facture_fournisseur', 'financement', 'charge_fixe', 'autre_depense', 'rentree_reguliere'));

-- Retour arrière (à condition qu'aucune hypothèse ne porte sur une facture prévisionnelle) :
--   alter table forecast_event_assumptions drop constraint if exists forecast_assumptions_source_type;
--   alter table forecast_event_assumptions add constraint forecast_event_assumptions_source_type_check
--     check (source_type in ('facture_client', 'facture_fournisseur', 'financement', 'charge_fixe', 'autre_depense', 'rentree_reguliere'));
--   alter table forecast_event_assumptions drop constraint if exists forecast_assumptions_parent_source_type;
--   alter table forecast_event_assumptions add constraint forecast_event_assumptions_parent_source_type_check
--     check (parent_source_type in ('facture_client', 'facture_fournisseur', 'financement', 'charge_fixe', 'autre_depense', 'rentree_reguliere'));
