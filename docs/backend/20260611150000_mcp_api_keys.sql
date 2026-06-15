-- 20260611150000_mcp_api_keys.sql
-- À COPIER vers truecalling-app/supabase/migrations/ (voir README.md de ce dossier).
-- Clés API personnelles pour le serveur MCP (Copilot Studio, clients distants).
-- La clé en clair n'est JAMAIS stockée : seulement son sha256 hex. La clé est
-- générée côté client (UI Paramètres → Intégrations) et affichée une seule fois.
-- L'échange clé → JWT court est fait par l'edge function mcp-key-exchange
-- (service_role, bypass RLS). Révocation = revoked_at non nul, effet immédiat.
set search_path = api, public;

create table if not exists api.mcp_api_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  key_hash      text not null unique,          -- sha256(clé) en hex — jamais la clé
  key_prefix    text not null,                 -- ex. "tcmcp_a1b2c3…" pour l'affichage UI
  name          text,                          -- ex. "Copilot Studio", "ChatGPT"
  allowed_tools text[],                        -- null = tous les outils
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

create index if not exists mcp_api_keys_user_idx on api.mcp_api_keys (user_id);

alter table api.mcp_api_keys enable row level security;

-- Un utilisateur ne voit et ne gère que SES clés. L'edge function d'échange
-- passe par service_role et n'est pas concernée par ces policies.
drop policy if exists mcp_api_keys_select_own on api.mcp_api_keys;
create policy mcp_api_keys_select_own on api.mcp_api_keys
  for select to authenticated using (user_id = auth.uid());

drop policy if exists mcp_api_keys_insert_own on api.mcp_api_keys;
create policy mcp_api_keys_insert_own on api.mcp_api_keys
  for insert to authenticated with check (user_id = auth.uid());

-- update = révocation (revoked_at) / renommage uniquement, sur ses propres clés.
drop policy if exists mcp_api_keys_update_own on api.mcp_api_keys;
create policy mcp_api_keys_update_own on api.mcp_api_keys
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists mcp_api_keys_delete_own on api.mcp_api_keys;
create policy mcp_api_keys_delete_own on api.mcp_api_keys
  for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on api.mcp_api_keys to authenticated;
