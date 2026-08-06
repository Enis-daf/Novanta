-- 1) Empêche les utilisateurs connectés (rôle "authenticated") de modifier
--    eux-mêmes les colonnes d'abonnement/accès de leur société. La policy RLS
--    actuelle autorise un utilisateur à modifier sa propre ligne "companies"
--    sans distinction de colonne ; combinée aux droits larges accordés par
--    défaut par Supabase à "authenticated", cela permettrait de s'auto-
--    attribuer l'accès ou de falsifier son statut d'abonnement depuis la
--    console du navigateur.
--
-- 2) Corrige la valeur par défaut de access_enabled (true -> false) au niveau
--    de la colonne elle-même. Le code applicatif écrit déjà "false" à chaque
--    création de société ; cette ligne est une protection supplémentaire si
--    un futur insert omettait ce champ par erreur.
--
-- Non destructif : aucune donnée existante modifiée.
-- - REVOKE/GRANT ne change que des droits, jamais des valeurs.
-- - ALTER COLUMN ... SET DEFAULT ne s'applique qu'aux futures insertions qui
--   omettraient la colonne ; aucune ligne déjà présente n'est touchée.
-- Aucune policy RLS modifiée. "service_role" (webhook, routes serveur admin)
-- n'est pas concerné par le REVOKE : c'est un rôle interne Supabase qui
-- contourne RLS et les droits de table par construction.

revoke update on public.companies from authenticated;

grant update (name, first_name, last_name) on public.companies to authenticated;

alter table companies alter column access_enabled set default false;
