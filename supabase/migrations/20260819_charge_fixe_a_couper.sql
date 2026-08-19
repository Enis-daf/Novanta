-- Ajoute l'état de simulation "À couper" pour les Charges fixes : permet de tester "que se
-- passe-t-il si je coupe cette charge ?" sans supprimer la donnée. La ligne reste visible et
-- enregistrée ; seule sa participation au calcul (courbe, solde projeté, point bas, synthèse
-- mensuelle) est suspendue tant que la case est cochée.
--
-- Additif et non destructif :
-- - 1 seule nouvelle colonne sur fixed_charges, not null avec valeur par défaut 'false'.
-- - Toutes les charges fixes existantes reçoivent a_couper = false et continuent de
--   participer au calcul exactement comme avant.
-- - Aucune colonne existante n'est modifiée, renommée ou supprimée.
-- - Aucune table n'est vidée, tronquée ou recréée.

alter table fixed_charges add column if not exists a_couper boolean not null default false;
