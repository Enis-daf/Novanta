-- Prévision probabiliste : dimensions d'incertitude et conditions d'activation. Additif :
-- trois colonnes nullables ajoutées à forecast_event_assumptions (20261112), aucune donnée
-- modifiée ni supprimée. Idempotent (réexécutable). Retour arrière : voir en fin de fichier.
--
--   amount_reliability   : fiabilité du montant, 25 / 50 / 75 / 100 (Très incertain → Certain) ;
--                          null = montant certain ou sans objet (factures, charges fixes)
--   target_amount        : valeur cible par échéance d'une rentrée régulière à montant fixe ;
--                          null = le montant saisi dans Futur
--   activation_condition : condition « Dépend de » (jsonb), null = aucune :
--       {"type":"evenement","source":"…","sourceId":"…"}
--       {"type":"seuil","indicateur":"ca_mois_precedent|tresorerie|marge_brute_mois_precedent",
--        "comparateur":">|<","valeur":100000}
--       {"type":"apres_evenement","source":"…","sourceId":"…","decalageMois":0}
--     Les colonnes parent_source_type / parent_source_id restent lisibles (lues comme une condition
--     « evenement ») mais ne sont plus écrites.
--
-- Une ligne « À renseigner » par défaut (rentrée régulière, financement, autre dépense) est
-- renseignée dès qu'une hypothèse existe pour elle : l'existence de la ligne vaut validation.

alter table forecast_event_assumptions
  add column if not exists amount_reliability smallint,
  add column if not exists target_amount numeric,
  add column if not exists activation_condition jsonb;

alter table forecast_event_assumptions drop constraint if exists forecast_assumptions_amount_reliability;
alter table forecast_event_assumptions add constraint forecast_assumptions_amount_reliability
  check (amount_reliability is null or amount_reliability in (25, 50, 75, 100));

alter table forecast_event_assumptions drop constraint if exists forecast_assumptions_target_amount;
alter table forecast_event_assumptions add constraint forecast_assumptions_target_amount
  check (target_amount is null or target_amount > 0);

alter table forecast_event_assumptions drop constraint if exists forecast_assumptions_activation_condition;
alter table forecast_event_assumptions add constraint forecast_assumptions_activation_condition
  check (
    activation_condition is null
    or (jsonb_typeof(activation_condition) = 'object'
        and activation_condition->>'type' in ('evenement', 'seuil', 'apres_evenement'))
  );

-- Retour arrière :
--   alter table forecast_event_assumptions
--     drop constraint if exists forecast_assumptions_activation_condition,
--     drop constraint if exists forecast_assumptions_target_amount,
--     drop constraint if exists forecast_assumptions_amount_reliability,
--     drop column if exists activation_condition,
--     drop column if exists target_amount,
--     drop column if exists amount_reliability;
