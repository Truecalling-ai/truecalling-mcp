// Public anon defaults — safe to ship. Override via env if needed.
const DEFAULT_SUPABASE_URL = "https://gxnriabesrpbgpireubf.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd4bnJpYWJlc3JwYmdwaXJldWJmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4Nzg1MjksImV4cCI6MjA5MjQ1NDUyOX0.-Wubl7PwAxe5sgv7NEzRhwzEq-ruWmoIFzmPoLTcss4";

export const SUPABASE_URL = process.env.SUPABASE_URL ?? DEFAULT_SUPABASE_URL;
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? DEFAULT_SUPABASE_ANON_KEY;

export const READONLY = process.env.TC_MCP_READONLY === "true";

export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

// Endpoint that exchanges a personal MCP API key (tcmcp_*) for a short-lived
// user JWT. Overridable for tests / non-default deployments.
export const KEY_EXCHANGE_URL =
  process.env.TC_MCP_KEY_EXCHANGE_URL ?? `${FUNCTIONS_URL}/mcp-key-exchange`;

// OAuth resource-server identity (RFC 9728). Served in the protected-resource
// metadata and the WWW-Authenticate challenge so OAuth clients (ChatGPT) can
// discover the Supabase authorization server.
export const RESOURCE_URL = process.env.TC_MCP_RESOURCE_URL ?? "https://mcp.truecalling.ai";

// OAuth bearer support is OPT-IN: without this flag the server accepts only
// API keys, and a Supabase JWT presented as a bearer is rejected outright.
// This prevents ordinary app session tokens from being replayable against the
// MCP before the Supabase OAuth Server + aud hook are configured.
export const OAUTH_ENABLED = process.env.TC_MCP_OAUTH_ENABLED === "true";

// RFC 8707 audience enforcement for incoming OAuth bearer tokens. REQUIRED
// when OAUTH_ENABLED (startup fails otherwise): only tokens minted for this
// resource (via the Supabase `aud` Auth Hook — see docs/OAUTH_PHASE2.md) are
// accepted, never generic project/session JWTs.
export const OAUTH_AUDIENCE = process.env.TC_MCP_OAUTH_AUDIENCE || undefined;
