-- Module "Passé" : début d'exercice par organisation — deux colonnes ajoutées à past_settings.
-- Additif et réexécutable ; aucune donnée existante n'est modifiée.
--
-- L'exercice est une caractéristique de l'entreprise, donc en base (contrairement à la dernière
-- période consultée, simple préférence locale du navigateur). Seule la règle récurrente de DÉBUT
-- est stockée, sans année : la fin d'exercice et les semestres / trimestres s'en déduisent
-- (lib/fiscalPeriods.ts). Défaut : 1er janvier, soit l'année civile — rien ne change pour une
-- organisation qui ne configure rien.
--
-- Le jour doit exister TOUS les ans dans le mois choisi : 31 mars ou 30 septembre sont acceptés,
-- 31 avril et 29 février sont refusés (une règle annuelle ne peut pas reposer sur une date qui
-- n'existe qu'une année sur quatre). Même règle que l'écran de saisie et que le code applicatif.
--
-- Droits : inchangés. past_settings est déjà lisible et modifiable par l'organisation elle-même
-- uniquement, module 'past' activé (voir 20261008_past_transactions.sql).

alter table past_settings add column if not exists fiscal_year_start_month integer not null default 1;
alter table past_settings add column if not exists fiscal_year_start_day integer not null default 1;

alter table past_settings drop constraint if exists past_settings_fiscal_year_start_month_check;
alter table past_settings add constraint past_settings_fiscal_year_start_month_check
  check (fiscal_year_start_month between 1 and 12);

alter table past_settings drop constraint if exists past_settings_fiscal_year_start_day_check;
alter table past_settings add constraint past_settings_fiscal_year_start_day_check
  check (
    fiscal_year_start_day >= 1
    and fiscal_year_start_day <= case
      when fiscal_year_start_month = 2 then 28
      when fiscal_year_start_month in (4, 6, 9, 11) then 30
      else 31
    end
  );
