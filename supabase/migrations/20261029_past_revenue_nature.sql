-- Module "Passé" : nature du revenu des catégories d'Encaissements (offre Pilotage) — revenu
-- récurrent ou revenu ponctuel. Additif et non destructif. Idempotent (réexécutable).
-- Prérequis : 20261009_past_category_mappings.sql, 20261023_past_vat_stage.sql.
--
-- - Une colonne nullable sur past_category_mappings ; AUCUNE ligne existante n'est modifiée,
--   aucune transaction, aucun étage : NULL = nature non renseignée (catégorie « à mapper » tant
--   qu'elle n'est pas classée), jamais assimilée à du ponctuel. Pas de valeur par défaut.
-- - Deux valeurs seulement : 'recurring', 'one_off'. Pas de troisième nature « Non classé ».
-- - La nature n'existe qu'avec l'étage Encaissements (pnl_stage = 'revenue') : une catégorie
--   rattachée à un autre étage ne peut pas en porter une (l'application l'efface en changeant
--   d'étage). L'étage, lui, ne change pas : Encaissements = récurrent + ponctuel partout.
--
-- Droits : la policy RLS existante « Modification des mappings de sa société » s'applique telle
-- quelle. Seul un droit de mise à jour sur cette colonne est ajouté, à côté de pnl_stage et vat_rate.
-- Le journal past_category_mapping_history (trigger sur pnl_stage) n'est pas modifié.
--
-- Atomique. Rollback logique : alter table past_category_mappings drop column revenue_nature.

begin;

alter table past_category_mappings add column if not exists revenue_nature text;

alter table past_category_mappings drop constraint if exists past_category_mappings_revenue_nature_check;
alter table past_category_mappings add constraint past_category_mappings_revenue_nature_check
  check (revenue_nature is null or (revenue_nature in ('recurring', 'one_off') and pnl_stage = 'revenue'));

grant update (revenue_nature) on public.past_category_mappings to authenticated;

commit;
