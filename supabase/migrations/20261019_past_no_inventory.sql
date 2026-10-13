-- Module "Passé" : organisation déclarée sans stock — une colonne ajoutée à past_settings.
--
-- Tant qu'aucun stock de fin de mois n'est saisi, le module signale « stocks non renseignés ».
-- Une organisation qui n'a pas de stock le déclare ici, et le signal disparaît. La valeur est
-- ignorée dès qu'un stock est saisi : ce sont alors les mois manquants qui sont signalés.
--
-- Droits : inchangés. past_settings est déjà lisible et modifiable par l'organisation elle-même.

alter table past_settings add column if not exists no_inventory boolean not null default false;
