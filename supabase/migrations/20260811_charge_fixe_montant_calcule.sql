-- Ajoute le support du "Montant calculé" pour les Charges fixes uniquement (les Rentrées
-- régulières ne peuvent jamais être calculées). Une charge fixe garde soit son montant saisi
-- manuellement ("fixe", comportement actuel inchangé), soit un montant dérivé dynamiquement
-- d'une autre ligne (taux % d'une charge fixe non calculée ou d'une rentrée régulière).
--
-- Additif et non destructif :
-- - 4 nouvelles colonnes sur fixed_charges, toutes nullables ou avec une valeur par défaut.
-- - Aucune colonne existante n'est modifiée, renommée ou supprimée.
-- - Aucune ligne existante n'est touchée : mode_montant vaut 'fixe' par défaut, donc toutes
--   les charges fixes déjà en base continuent de fonctionner exactement comme avant.
-- - Aucune table n'est vidée, tronquée ou recréée.
--
-- Pas de contrainte de clé étrangère sur source_calcul_id : elle peut référencer soit
-- fixed_charges(id) soit recurring_income(id) selon source_calcul_type (deux tables
-- différentes, pas de FK polymorphe simple en Postgres). La protection contre la suppression
-- d'une ligne source utilisée par une charge calculée, et l'interdiction d'utiliser une charge
-- déjà calculée comme source d'une autre, sont appliquées côté application — comme le reste du
-- modèle de données de ce projet, qui n'a aucune FK inter-entités (voir fixed_charges,
-- other_expenses, financings : uniquement des FK vers companies).
--
-- La contrainte fixed_charges_mode_montant_coherent n'impose la cohérence que dans un sens :
-- en mode "fixe", ni taux ni source ne doivent être renseignés. Elle n'impose PAS que
-- taux_calcul/source_calcul_id soient déjà renseignés dès le passage en mode "calcule" : le
-- code applicatif enregistre chaque champ au fil de la saisie de l'utilisateur (comme pour
-- tous les autres champs de cette table, ex. montant=0 ou date_prevue vide sur une ligne tout
-- juste créée) — une ligne "calcule" temporairement incomplète est traitée comme un montant
-- indisponible côté moteur de calcul, jamais comme une erreur bloquante côté Supabase.

alter table fixed_charges add column if not exists mode_montant text not null default 'fixe'
  check (mode_montant in ('fixe', 'calcule'));

alter table fixed_charges add column if not exists taux_calcul numeric;

alter table fixed_charges add column if not exists source_calcul_id uuid;

alter table fixed_charges add column if not exists source_calcul_type text
  check (source_calcul_type in ('charge_fixe', 'rentree_reguliere'));

alter table fixed_charges drop constraint if exists fixed_charges_mode_montant_coherent;
alter table fixed_charges add constraint fixed_charges_mode_montant_coherent check (
  mode_montant != 'fixe' or (taux_calcul is null and source_calcul_id is null and source_calcul_type is null)
);

alter table fixed_charges drop constraint if exists fixed_charges_source_calcul_pas_soi_meme;
alter table fixed_charges add constraint fixed_charges_source_calcul_pas_soi_meme check (
  source_calcul_type is distinct from 'charge_fixe' or source_calcul_id is distinct from id
);
