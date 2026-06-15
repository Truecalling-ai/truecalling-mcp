-- 20260611160000_mcp_oauth_aud_hook.sql
-- À COPIER vers truecalling-app/supabase/migrations/ (Phase 2 / OAuth — ChatGPT).
--
-- Custom Access Token Hook : étiquette `aud = <resource MCP>` UNIQUEMENT sur
-- les jetons émis par le serveur OAuth de Supabase (clients type ChatGPT),
-- pour que le serveur MCP puisse vérifier l'audience (RFC 8707).
--
-- ⚠️ SÉCURITÉ CRITIQUE : ce hook se déclenche pour TOUS les jetons, y compris
-- les sessions normales de l'app web. Le garde `if client_id is not null`
-- garantit qu'on ne touche QUE les jetons OAuth — les sessions de l'app sont
-- renvoyées telles quelles (aud reste "authenticated"), donc l'app n'est PAS
-- impactée. NE PAS retirer ce garde.
--
-- ⚠️ BETA : le serveur OAuth de Supabase est en beta. Le nom exact du champ
-- qui porte l'identifiant du client OAuth dans `event` doit être CONFIRMÉ sur
-- un vrai jeton de ton projet (voir le bloc VÉRIFICATION en bas). Le hook ci-
-- dessous suppose `event->>'client_id'`, conforme à l'exemple Supabase MCP.

create or replace function public.mcp_oauth_aud_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims    jsonb := event -> 'claims';
  client_id text := event ->> 'client_id';          -- présent seulement pour les flux OAuth
  mcp_aud   constant text := 'https://mcp.truecalling.ai';
begin
  -- App sessions (password / otp / magiclink / refresh d'une session app) :
  -- pas de client_id OAuth → on ne touche à rien, l'app reste intacte.
  if client_id is not null then
    claims := jsonb_set(claims, '{aud}', to_jsonb(mcp_aud));
    event  := jsonb_set(event, '{claims}', claims);
  end if;
  return event;
end;
$$;

-- Le moteur d'auth (GoTrue) doit pouvoir exécuter le hook ; personne d'autre.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.mcp_oauth_aud_hook to supabase_auth_admin;
revoke execute on function public.mcp_oauth_aud_hook from authenticated, anon, public;

-- ---------------------------------------------------------------------------
-- ACTIVER LE HOOK (l'un OU l'autre) :
--   • Dashboard : Authentication → Hooks → "Custom Access Token" →
--     sélectionner public.mcp_oauth_aud_hook → Enable.
--   • OU config.toml (self-host / CLI) :
--       [auth.hook.custom_access_token]
--       enabled = true
--       uri = "pg-functions://postgres/public/mcp_oauth_aud_hook"
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- VÉRIFICATION OBLIGATOIRE avant de pousser en prod (feature beta) :
--
-- 1) APP NON CASSÉE : se connecter normalement à l'app, décoder le JWT
--    (jwt.io) → `aud` doit toujours valoir "authenticated". Si ce n'est pas
--    le cas, le garde n'a pas fonctionné → NE PAS activer en prod, me notifier.
--
-- 2) JETON OAuth CORRECT : faire un flux OAuth (ChatGPT, ou un client test),
--    décoder l'access token → `aud` doit valoir "https://mcp.truecalling.ai".
--    Si `aud` vaut encore "authenticated", c'est que `client_id` n'est pas le
--    bon champ dans `event` → logguer `event` une fois (raise log
--    'mcp hook event: %', event) pour voir la vraie structure et ajuster.
--
-- 3) REFRESH : laisser le jeton OAuth se rafraîchir une fois et re-décoder →
--    `aud` doit RESTER "https://mcp.truecalling.ai" (sinon le MCP rejettera le
--    jeton rafraîchi). Si le refresh perd l'aud, basculer le test sur
--    authentication_method au lieu de client_id.
-- ===========================================================================
