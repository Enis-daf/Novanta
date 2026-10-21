-- Module "Passé" : étage « TVA » — additif, non destructif. Idempotent (réexécutable).
-- Prérequis : 20261015_past_financing_stage.sql.
--
-- Nouvelle destination de correspondance P&L pour les paiements et remboursements de TVA : exclus
-- de la lecture HT estimé, conservés en TTC et dans toute la trésorerie (calculé à la lecture,
-- lib/pastHtEstime.ts). À ne pas confondre avec la colonne vat_rate (taux de conversion HT d'une
-- catégorie), qui n'est pas touchée.
--
-- C'est l'utilisateur qui rattache ses catégories à cet étage. AUCUN mapping existant n'est modifié,
-- aucune transaction, aucun taux, aucune ligne d'historique : seule la liste des valeurs admises
-- pour pnl_stage est élargie. Table, trigger, journal des modifications, politiques RLS et droits
-- sont inchangés.

alter table past_category_mappings drop constraint if exists past_category_mappings_pnl_stage_check;
alter table past_category_mappings add constraint past_category_mappings_pnl_stage_check
  check (pnl_stage in ('revenue', 'gross_margin', 'contribution_margin', 'ebitda', 'extra_pnl', 'vat', 'financing'));
