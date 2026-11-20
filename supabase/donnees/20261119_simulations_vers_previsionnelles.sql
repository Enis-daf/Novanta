-- Factures clients « Simulation » -> Factures prévisionnelles. Ponctuel, éditeur SQL Supabase.
-- Fermer les onglets Novanta avant l'étape 2 (un onglet ouvert pourrait ré-enregistrer une ligne).
--
-- Migrées : `facture` contient « simulation » (casse ignorée), non payée, non litigieuse, sans
-- pennylane_id, non réglée chez Pennylane, non rapprochée d'une prévisionnelle. Les autres ne sont
-- pas touchées (étape 1 : statut « À REVOIR »).
-- client -> client ; montant -> montant ; encaissement anticipé -> encaissement prévu (même date,
-- donc même trésorerie) ; date de facturation prévue -> vide (aucune source fiable).

-- ===== ÉTAPE 1 — LECTURE SEULE : ce qui sera migré =====
select
  co.name as societe,
  ci.facture, ci.client, ci.montant, ci.date_echeance,
  ci.date_encaissement_anticipee as encaissement_prevu,
  ci.pennylane_id, ci.paid as payee, ci.litigieuse,
  case
    when ci.pennylane_id is not null then 'À REVOIR : pennylane_id'
    when ci.settled_on is not null then 'À REVOIR : réglée chez Pennylane'
    when ci.paid then 'À REVOIR : Payée'
    when ci.litigieuse then 'À REVOIR : Litigieuse'
    when exists (select 1 from forecast_customer_invoices f where f.customer_invoice_id = ci.id)
      then 'À REVOIR : rapprochée'
    else 'MIGRÉE'
  end as statut
from customer_invoices ci
join companies co on co.id = ci.company_id
where ci.facture ilike '%simulation%'
order by statut, co.name, ci.date_encaissement_anticipee;

-- ===== ÉTAPE 2 — MIGRATION (exécuter seule, après lecture de l'étape 1) =====
-- Une seule instruction, donc atomique : les prévisionnelles sont créées À PARTIR des lignes
-- supprimées — jamais l'une sans l'autre. Relancée, elle ne trouve plus rien : aucun doublon.
-- Le résultat affiché (libellé d'origine compris) est la trace : l'exporter en CSV.
with supprimees as (
  delete from customer_invoices ci
  where ci.facture ilike '%simulation%'
    and ci.pennylane_id is null
    and ci.settled_on is null
    and not ci.paid
    and not ci.litigieuse
    and not exists (select 1 from forecast_customer_invoices f where f.customer_invoice_id = ci.id)
  returning ci.*
),
creees as (
  insert into forecast_customer_invoices (company_id, client, montant, date_facturation_prevue, date_encaissement_prevue)
  select company_id, client, montant, null, date_encaissement_anticipee
  from supprimees
  returning id, company_id, client, montant, date_encaissement_prevue
)
select s.id as ancienne_facture_id, s.facture as libelle_origine, s.client, s.montant,
       s.date_encaissement_anticipee as encaissement_prevu, s.date_echeance,
       (select count(*) from creees) as nb_previsionnelles_creees
from supprimees s
order by s.date_encaissement_anticipee;
