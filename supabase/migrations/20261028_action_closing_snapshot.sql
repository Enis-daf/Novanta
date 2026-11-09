-- Module "Action" : historique des chantiers clôturés — additive, non destructive. Prérequis :
-- 20261027_action_initiatives.sql. Idempotent (réexécutable). Retour arrière : en fin de fichier.
--
-- Un chantier clôturé reste consultable, en lecture seule, tel qu'il était à sa clôture :
--   - closing_snapshot : photographie de la fiche au moment de la clôture (priorité, changement,
--     période, les 3 indicateurs avec libellé, unité, référence et son libellé, cible, valeur
--     finale, atteinte, séries mensuelles avec leur statut clos / en cours, date de clôture).
--     Format : lib/actionChantier.ts (PhotographieChantier, version 1). Elle n'est jamais
--     recalculée : une écriture modifiée, un mapping changé ou un calcul qui évolue ne la touchent
--     pas. Obligatoire pour toute nouvelle clôture (contrainte NOT VALID : un chantier éventuellement
--     clôturé avant cette migration n'est pas rejeté ; sa fiche dit qu'elle n'a pas de photographie) ;
--   - un chantier clôturé ne se modifie plus, ne se rouvre pas, et ses indicateurs et valeurs
--     saisies non plus (triggers) ;
--   - rien ne se supprime depuis l'application : le droit DELETE est retiré au rôle authenticated.
--     La suppression d'une société continue d'emporter ses chantiers (cascade).

alter table action_initiatives add column if not exists closing_snapshot jsonb;

alter table action_initiatives drop constraint if exists action_initiatives_photographie;
alter table action_initiatives add constraint action_initiatives_photographie
  check (status = 'active' or closing_snapshot is not null) not valid;

-- Historique : chantiers clôturés d'une organisation, du plus récent au plus ancien.
create index if not exists action_initiatives_historique
  on action_initiatives (organization_id, completed_at desc) where status = 'completed';

-- Lecture seule après clôture.
create or replace function action_proteger_chantier_cloture()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'completed' then
    raise exception 'Chantier clôturé : il est en lecture seule.';
  end if;
  return new;
end;
$$;

drop trigger if exists action_initiatives_lecture_seule on action_initiatives;
create trigger action_initiatives_lecture_seule
  before update on action_initiatives
  for each row execute function action_proteger_chantier_cloture();

create or replace function action_proteger_enfant_cloture()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  chantier uuid;
begin
  if tg_table_name = 'action_initiative_kpis' then
    chantier := new.initiative_id;
  else
    select k.initiative_id into chantier from action_initiative_kpis k where k.id = new.kpi_id;
  end if;
  if exists (select 1 from action_initiatives i where i.id = chantier and i.status = 'completed') then
    raise exception 'Chantier clôturé : il est en lecture seule.';
  end if;
  return new;
end;
$$;

drop trigger if exists action_initiative_kpis_lecture_seule on action_initiative_kpis;
create trigger action_initiative_kpis_lecture_seule
  before insert or update on action_initiative_kpis
  for each row execute function action_proteger_enfant_cloture();

drop trigger if exists action_initiative_manual_values_lecture_seule on action_initiative_manual_values;
create trigger action_initiative_manual_values_lecture_seule
  before insert or update on action_initiative_manual_values
  for each row execute function action_proteger_enfant_cloture();

revoke delete on public.action_initiatives, public.action_initiative_kpis, public.action_initiative_manual_values from authenticated;

-- ---------------------------------------------------------------------------------------------
-- Retour arrière (à exécuter seul, manuellement) — les photographies de clôture sont perdues :
--
--   drop trigger if exists action_initiative_manual_values_lecture_seule on action_initiative_manual_values;
--   drop trigger if exists action_initiative_kpis_lecture_seule on action_initiative_kpis;
--   drop trigger if exists action_initiatives_lecture_seule on action_initiatives;
--   drop function if exists action_proteger_enfant_cloture();
--   drop function if exists action_proteger_chantier_cloture();
--   drop index if exists action_initiatives_historique;
--   alter table action_initiatives drop constraint if exists action_initiatives_photographie;
--   alter table action_initiatives drop column if exists closing_snapshot;
--   grant delete on public.action_initiatives, public.action_initiative_kpis, public.action_initiative_manual_values to authenticated;
-- ---------------------------------------------------------------------------------------------
