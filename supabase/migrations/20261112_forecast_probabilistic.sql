-- Prévision probabiliste (offre Pilotage) : deux tables nouvelles, additives. Aucune table
-- existante modifiée, aucune donnée supprimée. Prérequis : companies. Idempotent (réexécutable).
-- Retour arrière : voir en fin de fichier.
--
-- forecast_event_assumptions — hypothèses saisies sur une ligne de Futur
--   source_type / source_id : la ligne (facture client, facture fournisseur, financement, charge
--                             fixe, autre dépense, rentrée régulière) et son identifiant
--   probability             : probabilité de survenir, 25 / 50 / 75 / 100 (Incertain → Certain)
--   date_reliability        : fiabilité de la date, 25 / 50 / 75 / 100 (Très incertaine → Ferme)
--   parent_source_*         : ligne dont celle-ci dépend (si le parent ne survient pas, elle non
--                             plus) ; null = indépendante
--   Une ligne sans hypothèse suit les valeurs par défaut (lib/probaEvenements.ts). Une hypothèse
--   dont la ligne a été supprimée est simplement ignorée.
--
-- forecast_payment_profiles — profil de paiement du compte, recalculé à chaque prévision depuis
-- ses propres factures réglées, réécrit seulement quand l'historique change (fingerprint). Un
-- compte n'est jamais calibré avec les données d'un autre.
--   side        : customer (retards de vos clients) | supplier (vos retards fournisseurs)
--   stats       : nombre, médiane, moyenne, écart-type, P50/P75/P90/P95, parts à l'heure, > 7 j,
--                 > 30 j, > 60 j (null sans historique)
--   segments    : mêmes statistiques par taille de facture
--   customers   : mêmes statistiques par tiers, avec le poids de son historique propre
--   outliers    : traitement des retards extrêmes (borne, écrêtés, longue traîne conservée)
--   confidence  : score 0..1 (volume × fraîcheur de l'historique)
--
-- Sécurité : lecture et écriture des hypothèses limitées à sa propre organisation ; profils lus par
-- l'organisation, écrits par le serveur seulement (client admin). L'accès à la fonctionnalité
-- (offre Pilotage) est contrôlé par les routes /api/futur/probabiliste.

create table if not exists forecast_event_assumptions (
  company_id uuid not null references companies(id) on delete cascade,
  source_type text not null check (source_type in ('facture_client', 'facture_fournisseur', 'financement', 'charge_fixe', 'autre_depense', 'rentree_reguliere')),
  source_id text not null check (length(source_id) between 1 and 100),
  probability smallint not null check (probability in (25, 50, 75, 100)),
  date_reliability smallint not null check (date_reliability in (25, 50, 75, 100)),
  parent_source_type text check (parent_source_type in ('facture_client', 'facture_fournisseur', 'financement', 'charge_fixe', 'autre_depense', 'rentree_reguliere')),
  parent_source_id text check (length(parent_source_id) between 1 and 100),
  updated_at timestamptz not null default now(),
  primary key (company_id, source_type, source_id),
  constraint forecast_assumptions_parent_complet check ((parent_source_type is null) = (parent_source_id is null)),
  constraint forecast_assumptions_pas_son_propre_parent check (
    parent_source_type is null or not (parent_source_type = source_type and parent_source_id = source_id)
  )
);

create table if not exists forecast_payment_profiles (
  company_id uuid not null references companies(id) on delete cascade,
  side text not null check (side in ('customer', 'supplier')),
  invoice_count integer not null check (invoice_count >= 0),
  confidence numeric not null check (confidence between 0 and 1),
  stats jsonb,
  segments jsonb not null default '[]'::jsonb,
  customers jsonb not null default '[]'::jsonb,
  outliers jsonb not null default '{}'::jsonb,
  fingerprint text not null,
  computed_at timestamptz not null default now(),
  primary key (company_id, side)
);

alter table forecast_event_assumptions enable row level security;
alter table forecast_payment_profiles enable row level security;

drop policy if exists "Accès société" on forecast_event_assumptions;
create policy "Accès société" on forecast_event_assumptions
  for all
  using (company_id in (select id from companies where owner_id = auth.uid()))
  with check (company_id in (select id from companies where owner_id = auth.uid()));

drop policy if exists "Lecture du profil de paiement de sa société" on forecast_payment_profiles;
create policy "Lecture du profil de paiement de sa société" on forecast_payment_profiles
  for select
  using (company_id in (select id from companies where owner_id = auth.uid()));

revoke all on public.forecast_event_assumptions from anon;
revoke all on public.forecast_payment_profiles from anon;

-- Retour arrière (aucune autre table n'en dépend) :
--   drop table if exists forecast_payment_profiles;
--   drop table if exists forecast_event_assumptions;
