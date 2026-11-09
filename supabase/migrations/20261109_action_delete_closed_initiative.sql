-- Module "Action" : suppression définitive d'un chantier CLÔTURÉ — additive : une fonction, aucune
-- table modifiée, aucune donnée touchée à l'exécution. Prérequis : 20261027_action_initiatives.sql,
-- 20261028_action_closing_snapshot.sql. Idempotent (réexécutable). Retour arrière : en fin de fichier.
--
-- Clôturer = terminer le chantier en gardant son historique. Supprimer = retirer définitivement un
-- chantier clôturé qui ne doit plus exister (créé par erreur, devenu sans objet).
--
-- Règles, tenues ici et non dans l'écran :
--   - un chantier ACTIF ne se supprime jamais : il faut d'abord le clôturer (erreur 55000) ;
--   - mêmes droits que les autres écritures d'un chantier (RLS des tables action_*) : sa propre
--     société, module 'past' activé (erreur 42501 sinon) ;
--   - chantier introuvable (déjà supprimé, ou d'une autre société) : 'absent', rien n'est écrit ;
--   - ce qui part : la ligne action_initiatives (avec sa photographie de clôture closing_snapshot
--     et ses dates de clôture), ses 3 indicateurs (action_initiative_kpis) et les valeurs saisies
--     de son indicateur personnalisé (action_initiative_manual_values), par les cascades existantes ;
--   - ce qui ne part jamais : transactions, factures, données Pennylane, correspondance P&L,
--     ajustements, BFR, paramètres de la société, autres chantiers. Le chantier n'est qu'une couche
--     de suivi lue au-dessus de ces données ; aucune d'elles ne le référence.
--
-- Le droit DELETE direct reste retiré au rôle authenticated (20261028) : cette fonction est le seul
-- chemin de suppression depuis l'application. SECURITY DEFINER pour passer ce retrait ; elle
-- revérifie donc elle-même, explicitement, tout ce que la RLS vérifierait.

create or replace function action_supprimer_chantier(p_organization_id uuid, p_initiative_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  statut text;
begin
  if auth.uid() is null
    or not exists (select 1 from companies c where c.id = p_organization_id and c.owner_id = auth.uid())
    or not exists (
      select 1 from organization_modules m
      where m.organization_id = p_organization_id and m.module_key = 'past' and m.enabled
    )
  then
    raise exception 'Suppression refusée : ce chantier n''appartient pas à votre société.' using errcode = '42501';
  end if;

  select i.status into statut
  from action_initiatives i
  where i.id = p_initiative_id and i.organization_id = p_organization_id
  for update;

  if not found then
    return 'absent';
  end if;

  if statut <> 'completed' then
    raise exception 'Un chantier actif ne peut pas être supprimé : clôturez-le d''abord.' using errcode = '55000';
  end if;

  delete from action_initiatives
  where id = p_initiative_id and organization_id = p_organization_id and status = 'completed';

  return 'supprime';
end;
$$;

revoke all on function public.action_supprimer_chantier(uuid, uuid) from public, anon;
grant execute on function public.action_supprimer_chantier(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Retour arrière (à exécuter seul, manuellement) — aucun chantier n'est restauré :
--
--   drop function if exists public.action_supprimer_chantier(uuid, uuid);
-- ---------------------------------------------------------------------------------------------
