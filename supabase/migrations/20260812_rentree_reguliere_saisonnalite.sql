-- Ajoute le support du "Montant saisonnalisé" pour les Rentrées régulières uniquement (les
-- Charges fixes ne sont pas concernées). Une rentrée régulière garde soit son montant saisi
-- manuellement ("fixe", comportement actuel inchangé), soit un montant dérivé chaque mois d'un
-- montant annuel et d'une pondération mensuelle (12 valeurs en %, un profil qui se répète à
-- l'identique chaque année).
--
-- Additif et non destructif :
-- - 2 nouvelles colonnes sur recurring_income, toutes nullables ou avec valeur par défaut.
-- - Aucune colonne existante n'est modifiée, renommée ou supprimée.
-- - Aucune ligne existante n'est touchée : mode_montant vaut 'fixe' par défaut, donc toutes les
--   rentrées déjà en base continuent de fonctionner exactement comme avant.
-- - Aucune table n'est vidée, tronquée ou recréée.
--
-- profil_saisonnalite (jsonb) contient { montantAnnuel: number, ponderationsMensuelles: number[12] }.
-- Choix : une seule colonne JSON plutôt que 12 colonnes ou une table séparée — la relation est
-- 1:1 avec la rentrée, il n'y a aucun workflow ni relation supplémentaire qui justifierait une
-- table dédiée. La validation (12 valeurs, pondérations non négatives, total proche de 100 %)
-- est faite côté application, exactement comme le taux/la source des Charges fixes calculées
-- ne sont pas non plus validés en profondeur côté base (voir fixed_charges_mode_montant_coherent).
--
-- La contrainte ci-dessous n'impose la cohérence que dans un sens : en mode "fixe", pas de
-- profil de saisonnalité renseigné. Elle n'impose PAS que profil_saisonnalite soit déjà complet
-- dès le passage en mode "saisonnalise" : l'application enregistre chaque champ au fil de la
-- saisie (montant annuel, puis pondérations une par une) — un profil temporairement incomplet
-- ou dont le total est hors tolérance est traité comme un montant indisponible côté moteur de
-- calcul, jamais comme une erreur bloquante côté Supabase.

alter table recurring_income add column if not exists mode_montant text not null default 'fixe'
  check (mode_montant in ('fixe', 'saisonnalise'));

alter table recurring_income add column if not exists profil_saisonnalite jsonb;

alter table recurring_income drop constraint if exists recurring_income_mode_montant_coherent;
alter table recurring_income add constraint recurring_income_mode_montant_coherent check (
  mode_montant != 'fixe' or profil_saisonnalite is null
);

-- Élargit la fréquence des Rentrées régulières pour autoriser "hebdomadaire" (alignement avec
-- fixed_charges.recurrence, qui l'autorise déjà). Nécessaire pour que la saisonnalité (toujours
-- mensuelle en interne) puisse être répartie en occurrences hebdomadaires, comme elle l'est déjà
-- en quotidien/mensuel. Additif : aucune ligne existante n'est modifiée, les valeurs déjà en
-- usage restent valides.
alter table recurring_income drop constraint if exists recurring_income_frequence_check;
alter table recurring_income add constraint recurring_income_frequence_check
  check (frequence in ('ponctuel', 'quotidien', 'hebdomadaire', 'mensuel'));
