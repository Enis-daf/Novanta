-- Synchronisation Pennylane des factures clients/fournisseurs.
-- Additive et non destructive : aucune ligne existante n'est modifiée ni supprimée.
-- pennylane_id est NULL pour toute facture créée manuellement ou importée par fichier —
-- seules les factures issues d'une synchronisation Pennylane le renseignent.

alter table customer_invoices add column if not exists pennylane_id text;
alter table supplier_invoices add column if not exists pennylane_id text;

-- Unicité par société : une même facture Pennylane ne doit jamais correspondre à plus
-- d'une ligne Novanta pour une société donnée (voir lib/pennylaneInvoiceAdapter.ts).
-- Un index unique Postgres ignore les valeurs NULL, donc les factures non issues de
-- Pennylane (pennylane_id = null) ne sont jamais concernées par cette contrainte.
create unique index if not exists idx_customer_invoices_pennylane_id
  on customer_invoices(company_id, pennylane_id);
create unique index if not exists idx_supplier_invoices_pennylane_id
  on supplier_invoices(company_id, pennylane_id);
