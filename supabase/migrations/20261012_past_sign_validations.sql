-- Module "Passé" : validation des transactions à signe inhabituel — nouvelle table, additive, non
-- destructive. Prérequis : 20261008_past_transactions.sql. Idempotent (réexécutable).
--
-- Une validation est un simple acquittement : « j'ai vérifié cette anomalie, elle est normale ».
-- Elle ne modifie ni la transaction (montant, signe), ni sa catégorie, ni le mapping, et la
-- transaction reste comptée partout. Elle retire seulement la ligne de la liste des anomalies à
-- vérifier.
--
-- Une ligne par (transaction, catégorie) : pour une transaction ventilée sur plusieurs catégories,
-- chaque part est une anomalie distincte de la liste, donc validée séparément.
--
-- La validation vaut pour le CONTEXTE dans lequel elle a été donnée : l'étage P&L de la catégorie
-- et la règle de signe enfreinte à ce moment-là. Si la catégorie change d'étage et que l'anomalie
-- n'est plus la même, la ligne ne correspond plus et l'anomalie réapparaît (comparaison faite à la
-- lecture, lib/pastSignChecks.ts) ; une nouvelle validation remplace alors l'ancienne.
--
-- transaction_id est l'identifiant interne stable de past_transactions : une resynchronisation
-- Pennylane met la transaction à jour sans changer cet identifiant, la validation est donc
-- conservée. Si la transaction est réellement supprimée, sa validation part avec elle (on delete
-- cascade) et n'est jamais reportée sur une autre.
--
-- Sécurité : lecture et écriture limitées à sa propre organisation, module 'past' activé, et
-- seulement pour une transaction de cette même organisation. L'auteur et la date de validation
-- sont posés par trigger, jamais par le client.

create table if not exists past_transaction_sign_validations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  transaction_id uuid not null references past_transactions(id) on delete cascade,
  source_category_id text not null,
  pnl_stage_at_validation text not null
    check (pnl_stage_at_validation in ('revenue', 'gross_margin', 'contribution_margin', 'ebitda', 'extra_pnl')),
  sign_rule_at_validation text not null check (sign_rule_at_validation in ('ca_negatif', 'cout_positif')),
  validated_at timestamptz not null default now(),
  validated_by uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, transaction_id, source_category_id)
);

create or replace function past_poser_validation_signe()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.validated_by := auth.uid();
  new.validated_at := now();
  return new;
end;
$$;

drop trigger if exists past_transaction_sign_validations_audit on past_transaction_sign_validations;
create trigger past_transaction_sign_validations_audit
  before insert or update on past_transaction_sign_validations
  for each row execute function past_poser_validation_signe();

alter table past_transaction_sign_validations enable row level security;

drop policy if exists "Validations de signe de sa société" on past_transaction_sign_validations;
create policy "Validations de signe de sa société" on past_transaction_sign_validations
  for all
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_transaction_sign_validations.organization_id
        and m.module_key = 'past' and m.enabled
    )
  )
  with check (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_transaction_sign_validations.organization_id
        and m.module_key = 'past' and m.enabled
    )
    and exists (
      select 1 from past_transactions t
      where t.id = past_transaction_sign_validations.transaction_id
        and t.organization_id = past_transaction_sign_validations.organization_id
    )
  );

revoke all on public.past_transaction_sign_validations from anon;
revoke truncate on public.past_transaction_sign_validations from authenticated;
grant select, insert, update, delete on public.past_transaction_sign_validations to authenticated;
