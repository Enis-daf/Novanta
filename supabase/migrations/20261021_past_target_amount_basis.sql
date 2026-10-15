-- Module "Passé" : base des montants d'un objectif de coûts de structure (HT ou TTC), pour la
-- lecture « HT estimé » du reporting (lib/pastTargets.ts, lib/pastHtEstime.ts).
--
-- Additif et non destructif :
-- - une colonne nullable sur past_performance_targets ; aucune ligne existante n'est modifiée ;
-- - NULL = objectif historique, posé avant cette migration : il est lu comme TTC (les montants
--   saisis l'étaient sur des montants TTC). Aucune conversion n'est faite ;
-- - la base n'a de sens que pour un montant : elle reste NULL pour les objectifs de marge, qui sont
--   des pourcentages, identiques dans les deux lectures ;
-- - pas de valeur par défaut en base : le HT par défaut des nouveaux objectifs est posé par
--   l'application, explicitement.
-- - l'unicité (organisation, type, dimension, date d'effet) est inchangée : une seule version
--   d'objectif par date, quelle que soit sa base.
--
-- Droits : la table accorde déjà select / insert / update / delete à authenticated, sous la policy
-- RLS existante. Rien à ajouter.
--
-- Atomique. Rollback logique : alter table past_performance_targets drop column amount_basis.

begin;

alter table past_performance_targets add column if not exists amount_basis text;

alter table past_performance_targets drop constraint if exists past_performance_targets_amount_basis;
alter table past_performance_targets add constraint past_performance_targets_amount_basis check (
  amount_basis is null or (amount_basis in ('ht', 'ttc') and target_type = 'structure_cost_monthly')
);

commit;

notify pgrst, 'reload schema';
