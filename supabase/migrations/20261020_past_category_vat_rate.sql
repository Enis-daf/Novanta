-- Module "Passé" : taux de TVA estimé par catégorie, pour la lecture « HT estimé » du reporting
-- (lib/pastHtEstime.ts). Les transactions restent TTC ; ce taux ne sert qu'à une projection.
--
-- Additif et non destructif :
-- - une colonne nullable sur past_category_mappings ; aucune ligne existante n'est modifiée ;
-- - NULL = « Non défini », jamais assimilé à 0 % ; 0 est un taux valide ;
-- - pas de valeur par défaut : aucun taux n'est prérempli.
--
-- Droits : la policy RLS existante « Modification des mappings de sa société » (organisation de
-- l'utilisateur, module Passé activé) s'applique telle quelle. Seul un droit de mise à jour sur
-- cette colonne est ajouté, à côté de celui de pnl_stage.
--
-- Atomique. Rollback logique : alter table past_category_mappings drop column vat_rate.

begin;

alter table past_category_mappings add column if not exists vat_rate numeric(5, 2);

alter table past_category_mappings drop constraint if exists past_category_mappings_vat_rate_check;
alter table past_category_mappings add constraint past_category_mappings_vat_rate_check
  check (vat_rate is null or (vat_rate >= 0 and vat_rate < 100));

grant update (vat_rate) on public.past_category_mappings to authenticated;

commit;
