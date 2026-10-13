-- Module "Passé" : commentaire de l'utilisateur sur chaque objectif daté — une colonne de plus,
-- additive, non destructive. Prérequis : 20261016_past_performance_targets.sql. Idempotent.
--
-- Le commentaire est une note libre attachée à UNE VERSION d'objectif (une ligne : un type, une
-- catégorie, une date d'effet) : l'hypothèse derrière le chiffre. Il n'est ni global à la
-- catégorie, ni recopié sur une nouvelle version. Aucune ligne existante n'est modifiée : la
-- colonne est vide partout après cette migration.
--
-- Sécurité : la colonne vit sur la ligne d'objectif, donc sous la même politique RLS et les mêmes
-- droits que le reste de la ligne. Rien à ajouter.

alter table past_performance_targets add column if not exists comment text;

alter table past_performance_targets drop constraint if exists past_performance_targets_comment;
alter table past_performance_targets add constraint past_performance_targets_comment
  check (comment is null or char_length(comment) <= 2000);
