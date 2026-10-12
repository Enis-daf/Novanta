-- Module "Passé" : étage « Virements internes & Financement » — additif, non destructif.
-- Prérequis : 20261009_past_category_mappings.sql. Idempotent (réexécutable).
--
-- Les flux hors exploitation étaient tous rattachés à l'étage 'extra_pnl'. Un second étage,
-- 'financing', accueille les virements entre comptes de l'entreprise et les flux de financement.
-- Il entre dans le Cash flow complet ; l'écran Cash flow peut le laisser de côté (lecture « hors
-- financement »), en entier, sans sous-type ni règle de signe — tout est calculé à la lecture.
--
-- C'est l'utilisateur qui rattache ses catégories à cet étage. AUCUN mapping existant n'est
-- modifié : ce qui est en 'extra_pnl' y reste, et la clé 'extra_pnl' n'est ni renommée ni retirée.
-- Seule la liste des valeurs admises pour pnl_stage est élargie ; table, trigger, politiques RLS
-- et droits sont inchangés.

alter table past_category_mappings drop constraint if exists past_category_mappings_pnl_stage_check;
alter table past_category_mappings add constraint past_category_mappings_pnl_stage_check
  check (pnl_stage in ('revenue', 'gross_margin', 'contribution_margin', 'ebitda', 'extra_pnl', 'financing'));
