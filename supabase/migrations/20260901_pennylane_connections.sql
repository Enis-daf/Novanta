-- Intégration Pennylane MVP (Company API Token) — nouvelle table, additive, non destructive.
-- Aucune table existante modifiée, aucune donnée supprimée.
--
-- Stocke UNIQUEMENT le credential chiffré et son statut — jamais de transactions bancaires
-- Pennylane (aucun ledger permanent, voir architecture : récupération à la demande uniquement).
--
-- Protection : contrairement aux autres tables de ce schéma, AUCUN grant n'est accordé au rôle
-- "authenticated" sur cette table. Toutes les lectures/écritures passent exclusivement par des
-- routes serveur Next.js utilisant la clé service_role (contourne RLS), après vérification de
-- l'ownership (company_id dérivé du token de l'utilisateur connecté, jamais fourni par le client
-- — voir lib/supabaseServer.ts::requireUser). Le navigateur ne peut donc jamais lire
-- token_ciphertext, même en cas de bug applicatif : la table lui est invisible au niveau SQL.

create table if not exists pennylane_connections (
  company_id uuid primary key references companies(id) on delete cascade,
  token_ciphertext text not null,
  status text not null default 'connected' check (status in ('connected', 'invalid')),
  last_tested_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table pennylane_connections enable row level security;

-- Aucune policy n'est créée pour "authenticated" : sans policy ET sans grant, l'accès est refusé
-- par défaut. Cohérent avec le reste du schéma (RLS activé partout) tout en interdisant tout accès
-- direct côté client à cette table spécifique.
