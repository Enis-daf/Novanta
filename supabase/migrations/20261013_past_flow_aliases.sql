-- Module "Passé" : noms donnés par l'utilisateur aux flux de l'Analyse d'écarts — nouvelle table,
-- additive, non destructive. Prérequis : 20261007_organization_modules.sql. Idempotent.
--
-- Un alias renomme un FLUX reconnu par le moteur (lib/flowMatching.ts), jamais une transaction :
-- le libellé bancaire d'origine n'est pas modifié, et le regroupement des transactions non plus.
-- Chaîne : libellé bancaire -> identité de flux -> alias de l'organisation -> nom affiché.
--
-- canonical_flow_key est l'identité PROPRE d'un libellé (« sepa:<émetteur>:<mandat> »,
-- « tiers:<contrepartie> », « texte:<libellé normalisé> »), sans la catégorie analytique : un même
-- flux porte le même nom dans toute l'organisation, et le garde s'il est recatégorisé.
--
-- Cette clé est calculée par le moteur. Pour qu'un alias survive à une évolution du moteur, chaque
-- ligne garde de quoi la recalculer : un libellé bancaire d'exemple (sample_label), le nom détecté
-- au moment du renommage (detected_name) et la version du moteur (engine_version).
--
-- Sécurité : lecture et écriture limitées à sa propre organisation, module 'past' activé. Auteur
-- et date de modification posés par trigger, jamais par le client.

create table if not exists past_flow_aliases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  canonical_flow_key text not null check (canonical_flow_key <> ''),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
  detected_name text,
  sample_label text,
  engine_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  unique (organization_id, canonical_flow_key)
);

create or replace function past_poser_modification_alias()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists past_flow_aliases_audit on past_flow_aliases;
create trigger past_flow_aliases_audit
  before insert or update on past_flow_aliases
  for each row execute function past_poser_modification_alias();

alter table past_flow_aliases enable row level security;

drop policy if exists "Alias de flux de sa société" on past_flow_aliases;
create policy "Alias de flux de sa société" on past_flow_aliases
  for all
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_flow_aliases.organization_id
        and m.module_key = 'past' and m.enabled
    )
  )
  with check (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = past_flow_aliases.organization_id
        and m.module_key = 'past' and m.enabled
    )
  );

revoke all on public.past_flow_aliases from anon;
revoke truncate on public.past_flow_aliases from authenticated;
grant select, insert, update, delete on public.past_flow_aliases to authenticated;
