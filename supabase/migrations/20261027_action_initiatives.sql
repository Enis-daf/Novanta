-- Module "Action" : LE chantier de rentabilité prioritaire — trois tables nouvelles, additives.
-- Aucune table existante modifiée, aucune donnée supprimée. Prérequis : companies,
-- organization_modules. Idempotent (réexécutable). Retour arrière : voir en fin de fichier.
--
-- Passé → Action → Futur : ce que le dirigeant décide de changer maintenant. Volontairement simple :
--   - un seul chantier ACTIF par organisation (index unique partiel) ;
--   - exactement 3 indicateurs par chantier (trigger de contrainte différé : vérifié à la fin de
--     la transaction, donc le chantier et ses 3 indicateurs s'insèrent ensemble, via
--     action_lancer_chantier) ;
--   - au plus 1 indicateur personnalisé (saisie manuelle) par chantier (index unique partiel).
--
-- action_initiatives — le chantier
--   title               : la priorité (« Votre priorité »)
--   change_description  : ce qui change concrètement
--   period_type         : month | quarter | semester | year (trimestres, semestres et années de
--                         l'exercice de l'organisation, lib/fiscalPeriods.ts)
--   start_date/end_date : bornes exactes, incluses
--   status              : active | completed ; completed_at posé à la clôture
--
-- action_initiative_kpis — ses 3 indicateurs
--   position            : 1, 2 ou 3 (ordre d'affichage)
--   kpi_key             : clé du catalogue (lib/actionChantier.ts), ou 'custom'
--   custom_name/unit    : obligatoires pour 'custom', absents sinon
--   direction           : up (plus haut = mieux) | down (plus bas = mieux) ; fixée par le
--                         catalogue pour un indicateur automatique, choisie pour 'custom'
--   reference_*         : point de référence FIGÉ au lancement (valeur, libellé daté, origine,
--                         période). reference_value null = aucune référence disponible : jamais 0.
--                         reference_origin : equivalent (période équivalente passée), previous
--                         (dernière période complète comparable), indicative (historique partiel,
--                         signalé comme tel), situation (BFR validé), manual (saisie), none.
--   target_value        : cible FIXE, valeur finale à atteindre (pas de trajectoire mensuelle)
--
-- action_initiative_manual_values — valeurs observées de l'indicateur personnalisé, une par mois
--   month               : premier jour du mois
--
-- Sécurité : lecture et écriture limitées à sa propre organisation, module 'past' activé (Action
-- lit les données du module Passé) — mêmes règles que les tables past_*.

create table if not exists action_initiatives (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references companies(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 200),
  change_description text not null check (length(btrim(change_description)) between 1 and 2000),
  period_type text not null check (period_type in ('month', 'quarter', 'semester', 'year')),
  start_date date not null,
  end_date date not null,
  status text not null default 'active' check (status in ('active', 'completed')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint action_initiatives_dates check (start_date <= end_date),
  constraint action_initiatives_cloture check ((status = 'completed') = (completed_at is not null))
);

-- Un seul chantier actif à la fois par organisation.
create unique index if not exists action_initiatives_un_actif
  on action_initiatives (organization_id) where status = 'active';

create table if not exists action_initiative_kpis (
  id uuid primary key default gen_random_uuid(),
  initiative_id uuid not null references action_initiatives(id) on delete cascade,
  organization_id uuid not null references companies(id) on delete cascade,
  position smallint not null check (position between 1 and 3),
  kpi_key text not null check (kpi_key ~ '^[a-z_]{1,64}$'),
  custom_name text,
  custom_unit text,
  direction text not null check (direction in ('up', 'down')),
  reference_value numeric,
  reference_label text,
  reference_origin text not null check (reference_origin in ('equivalent', 'previous', 'indicative', 'situation', 'manual', 'none')),
  reference_start date,
  reference_end date,
  target_value numeric not null,
  created_at timestamptz not null default now(),
  unique (initiative_id, position),
  unique (initiative_id, kpi_key),
  constraint action_kpis_personnalise check (
    (kpi_key = 'custom' and length(btrim(coalesce(custom_name, ''))) between 1 and 80
      and length(btrim(coalesce(custom_unit, ''))) between 1 and 20)
    or (kpi_key <> 'custom' and custom_name is null and custom_unit is null)
  ),
  -- Une référence existe (valeur + libellé daté + origine) ou n'existe pas du tout.
  constraint action_kpis_reference check (
    (reference_origin = 'none' and reference_value is null and reference_label is null)
    or (reference_origin <> 'none' and reference_value is not null and length(btrim(coalesce(reference_label, ''))) > 0)
  ),
  constraint action_kpis_reference_periode check (
    reference_start is null or reference_end is null or reference_start <= reference_end
  )
);

-- Au plus un indicateur personnalisé (saisie manuelle) par chantier — redondant avec
-- unique (initiative_id, kpi_key), gardé explicite : c'est une règle métier, pas un hasard.
create unique index if not exists action_initiative_kpis_un_manuel
  on action_initiative_kpis (initiative_id) where kpi_key = 'custom';

create table if not exists action_initiative_manual_values (
  id uuid primary key default gen_random_uuid(),
  kpi_id uuid not null references action_initiative_kpis(id) on delete cascade,
  organization_id uuid not null references companies(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  value numeric not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  unique (kpi_id, month)
);

-- Cohérence : l'organisation d'un indicateur est celle de son chantier ; une valeur manuelle ne
-- s'attache qu'à l'indicateur personnalisé, de la même organisation, dans les mois du chantier.
create or replace function action_verifier_kpi()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1 from action_initiatives i where i.id = new.initiative_id and i.organization_id = new.organization_id
  ) then
    raise exception 'Indicateur rattaché à un chantier d''une autre organisation.';
  end if;
  return new;
end;
$$;

drop trigger if exists action_initiative_kpis_coherence on action_initiative_kpis;
create trigger action_initiative_kpis_coherence
  before insert or update on action_initiative_kpis
  for each row execute function action_verifier_kpi();

create or replace function action_verifier_valeur_manuelle()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1
    from action_initiative_kpis k
    join action_initiatives i on i.id = k.initiative_id
    where k.id = new.kpi_id
      and k.kpi_key = 'custom'
      and k.organization_id = new.organization_id
      and new.month between date_trunc('month', i.start_date)::date and i.end_date
  ) then
    raise exception 'Valeur manuelle réservée à l''indicateur personnalisé, dans les mois du chantier.';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists action_initiative_manual_values_coherence on action_initiative_manual_values;
create trigger action_initiative_manual_values_coherence
  before insert or update on action_initiative_manual_values
  for each row execute function action_verifier_valeur_manuelle();

-- Exactement 3 indicateurs : vérifié en fin de transaction (contrainte différée), à la création
-- du chantier comme à toute suppression ou ajout ultérieur d'indicateur.
create or replace function action_verifier_trois_kpis()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  chantier uuid;
  nombre integer;
begin
  -- Champs lus branche par branche : NEW et OLD n'ont pas la même structure selon la table.
  if tg_table_name = 'action_initiatives' then
    chantier := new.id;
  elsif tg_op = 'DELETE' then
    chantier := old.initiative_id;
  else
    chantier := new.initiative_id;
  end if;
  -- Chantier supprimé dans la même transaction (cascade) : rien à vérifier.
  if not exists (select 1 from action_initiatives where id = chantier) then
    return null;
  end if;
  select count(*) into nombre from action_initiative_kpis where initiative_id = chantier;
  if nombre <> 3 then
    raise exception 'Un chantier compte exactement 3 indicateurs (% trouvé(s)).', nombre;
  end if;
  return null;
end;
$$;

drop trigger if exists action_initiatives_trois_kpis on action_initiatives;
create constraint trigger action_initiatives_trois_kpis
  after insert on action_initiatives
  deferrable initially deferred
  for each row execute function action_verifier_trois_kpis();

drop trigger if exists action_initiative_kpis_trois_kpis on action_initiative_kpis;
create constraint trigger action_initiative_kpis_trois_kpis
  after insert or delete or update of initiative_id on action_initiative_kpis
  deferrable initially deferred
  for each row execute function action_verifier_trois_kpis();

create or replace function action_poser_modification()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists action_initiatives_modification on action_initiatives;
create trigger action_initiatives_modification
  before update on action_initiatives
  for each row execute function action_poser_modification();

-- Lancement atomique : le chantier et ses 3 indicateurs, en une transaction. SECURITY INVOKER :
-- la RLS ci-dessous s'applique telle quelle à l'appelant.
create or replace function action_lancer_chantier(
  p_organization_id uuid,
  p_title text,
  p_change_description text,
  p_period_type text,
  p_start_date date,
  p_end_date date,
  p_kpis jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  chantier uuid;
  kpi jsonb;
begin
  if jsonb_typeof(p_kpis) <> 'array' or jsonb_array_length(p_kpis) <> 3 then
    raise exception 'Un chantier compte exactement 3 indicateurs.';
  end if;

  insert into action_initiatives (organization_id, title, change_description, period_type, start_date, end_date)
  values (p_organization_id, btrim(p_title), btrim(p_change_description), p_period_type, p_start_date, p_end_date)
  returning id into chantier;

  for kpi in select * from jsonb_array_elements(p_kpis) loop
    insert into action_initiative_kpis (
      initiative_id, organization_id, position, kpi_key, custom_name, custom_unit, direction,
      reference_value, reference_label, reference_origin, reference_start, reference_end, target_value
    ) values (
      chantier,
      p_organization_id,
      (kpi->>'position')::smallint,
      kpi->>'kpi_key',
      nullif(btrim(kpi->>'custom_name'), ''),
      nullif(btrim(kpi->>'custom_unit'), ''),
      kpi->>'direction',
      (kpi->>'reference_value')::numeric,
      kpi->>'reference_label',
      kpi->>'reference_origin',
      (kpi->>'reference_start')::date,
      (kpi->>'reference_end')::date,
      (kpi->>'target_value')::numeric
    );
  end loop;

  return chantier;
end;
$$;

alter table action_initiatives enable row level security;
alter table action_initiative_kpis enable row level security;
alter table action_initiative_manual_values enable row level security;

drop policy if exists "Chantier de sa société" on action_initiatives;
create policy "Chantier de sa société" on action_initiatives
  for all
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = action_initiatives.organization_id and m.module_key = 'past' and m.enabled
    )
  )
  with check (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = action_initiatives.organization_id and m.module_key = 'past' and m.enabled
    )
  );

drop policy if exists "Indicateurs du chantier de sa société" on action_initiative_kpis;
create policy "Indicateurs du chantier de sa société" on action_initiative_kpis
  for all
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = action_initiative_kpis.organization_id and m.module_key = 'past' and m.enabled
    )
  )
  with check (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = action_initiative_kpis.organization_id and m.module_key = 'past' and m.enabled
    )
  );

drop policy if exists "Valeurs manuelles du chantier de sa société" on action_initiative_manual_values;
create policy "Valeurs manuelles du chantier de sa société" on action_initiative_manual_values
  for all
  using (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = action_initiative_manual_values.organization_id and m.module_key = 'past' and m.enabled
    )
  )
  with check (
    organization_id in (select id from companies where owner_id = auth.uid())
    and exists (
      select 1 from organization_modules m
      where m.organization_id = action_initiative_manual_values.organization_id and m.module_key = 'past' and m.enabled
    )
  );

revoke all on public.action_initiatives, public.action_initiative_kpis, public.action_initiative_manual_values from anon;
revoke truncate on public.action_initiatives, public.action_initiative_kpis, public.action_initiative_manual_values from authenticated;
grant select, insert, update, delete on public.action_initiatives, public.action_initiative_kpis, public.action_initiative_manual_values to authenticated;
revoke all on function public.action_lancer_chantier(uuid, text, text, text, date, date, jsonb) from public, anon;
grant execute on function public.action_lancer_chantier(uuid, text, text, text, date, date, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Retour arrière (à exécuter seul, manuellement) — supprime le module Action et ses données :
--
--   drop function if exists public.action_lancer_chantier(uuid, text, text, text, date, date, jsonb);
--   drop table if exists action_initiative_manual_values;
--   drop table if exists action_initiative_kpis;
--   drop table if exists action_initiatives;
--   drop function if exists action_verifier_kpi();
--   drop function if exists action_verifier_valeur_manuelle();
--   drop function if exists action_verifier_trois_kpis();
--   drop function if exists action_poser_modification();
-- ---------------------------------------------------------------------------------------------
