import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { KEY_EXCHANGE_URL, OAUTH_AUDIENCE, SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";

/**
 * Per-request user context for the multi-tenant HTTP mode.
 *
 * A personal API key (`tcmcp_<64 hex>`, generated self-service in the
 * TrueCalling app) is exchanged against the `mcp-key-exchange` edge function
 * for a short-lived user JWT. Every Supabase access during that request then
 * carries THAT user's token — RLS does the data isolation. No session is ever
 * stored server-side.
 *
 * Fail-closed: in HTTP mode, losing the AsyncLocalStorage context is a hard
 * error — we never silently fall back to the legacy global session, which
 * would be a cross-tenant leak. The legacy fallback only exists for stdio
 * (local Claude) and for the explicit legacy single-key HTTP mode, which runs
 * under a `{ legacy: true }` marker context.
 */

export interface UserContext {
  userId: string;
  /** Short-lived Supabase JWT minted by mcp-key-exchange (~5 min). */
  accessToken: string;
  /** sha256(key) prefix — safe for logs; never the key itself. */
  keyFingerprint: string;
  /** Per-key tool allowlist from the DB; null = all tools. */
  allowedTools: string[] | null;
}

export type RequestContext = UserContext | { legacy: true };

export const API_KEY_RE = /^tcmcp_[0-9a-f]{64}$/;

const als = new AsyncLocalStorage<RequestContext>();

let httpMode = false;
/** Called once by startHttpServer() — arms the fail-closed context check. */
export function markHttpMode(): void {
  httpMode = true;
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/**
 * The single accessor the data layer uses to decide whose credentials apply.
 * - UserContext  → per-user JWT (self-service key).
 * - undefined    → legacy global session (stdio, or legacy HTTP key whose
 *                  requests run under the `{legacy:true}` marker).
 * - HTTP mode + no context at all → throw (context was lost; never leak the
 *   legacy account to an unidentified request).
 */
export function activeUser(): UserContext | undefined {
  const store = als.getStore();
  if (store) return "userId" in store ? store : undefined;
  if (httpMode) {
    throw new Error("internal: request context lost — refusing legacy-session fallback");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// API key → UserContext resolution, with a small TTL cache so we hit the
// exchange function ~once per 4 minutes per key instead of once per request.
// ---------------------------------------------------------------------------

const CACHE_MAX = 1000;
/** Refresh the JWT one minute before it actually expires. */
const EXPIRY_SAFETY_MS = 60_000;

interface CacheEntry {
  ctx: UserContext;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export async function resolveApiKey(apiKey: string): Promise<UserContext | null> {
  const fullHash = createHash("sha256").update(apiKey).digest("hex");
  const now = Date.now();

  const hit = cache.get(fullHash);
  if (hit && hit.expiresAt > now) return hit.ctx;
  cache.delete(fullHash);

  let res: Response;
  try {
    res = await fetch(KEY_EXCHANGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ api_key: apiKey }),
    });
  } catch (e) {
    console.error(`[truecalling-mcp] key-exchange unreachable: ${(e as Error).message}`);
    return null;
  }
  if (!res.ok) {
    if (res.status !== 401) {
      console.error(`[truecalling-mcp] key-exchange failed with status ${res.status}`);
    }
    return null;
  }

  const data = (await res.json().catch(() => null)) as {
    token?: string;
    expires_in?: number;
    user_id?: string;
    allowed_tools?: string[] | null;
  } | null;
  if (!data?.token || !data.user_id) return null;

  const ctx: UserContext = {
    userId: data.user_id,
    accessToken: data.token,
    keyFingerprint: fullHash.slice(0, 12),
    allowedTools: data.allowed_tools ?? null,
  };
  const ttlMs = Math.max((data.expires_in ?? 300) * 1000 - EXPIRY_SAFETY_MS, 30_000);

  if (cache.size >= CACHE_MAX) {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
    // Still full of live entries → drop oldest insertions (bounded memory
    // beats keeping every key warm; the next request just re-exchanges).
    while (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  cache.set(fullHash, { ctx, expiresAt: now + ttlMs });
  return ctx;
}

// ---------------------------------------------------------------------------
// Phase 2 — OAuth bearer tokens (ChatGPT, Copilot Studio in OAuth mode).
// The MCP server is an OAuth resource server: it validates each incoming
// Supabase-issued JWT by asking GoTrue itself (GET /auth/v1/user) — signature,
// expiry and revocation are checked server-side by Supabase, so this process
// holds NO signing secret and works with both HS256 (current project) and a
// future asymmetric-key migration. Validated tokens are cached until just
// before their own `exp`.
// ---------------------------------------------------------------------------

/** Three dot-separated base64url segments — the JWS compact serialization. */
export const JWS_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

interface JwtPayload {
  exp?: number;
  aud?: string | string[];
}

/** Decode (NOT verify — GoTrue verifies) the payload for exp/aud bookkeeping. */
function decodeJwtPayload(jwt: string): JwtPayload | null {
  try {
    const payload = jwt.split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JwtPayload;
  } catch {
    return null;
  }
}

const bearerCache = new Map<string, CacheEntry>();

export async function resolveBearer(jwt: string): Promise<UserContext | null> {
  const tokenHash = createHash("sha256").update(jwt).digest("hex");
  const now = Date.now();

  const hit = bearerCache.get(tokenHash);
  if (hit && hit.expiresAt > now) return hit.ctx;
  bearerCache.delete(tokenHash);

  const payload = decodeJwtPayload(jwt);
  if (!payload) return null;

  // RFC 8707 audience binding — enforced once the Supabase `aud` Auth Hook is
  // configured and TC_MCP_OAUTH_AUDIENCE is set. Unset = accept any audience
  // GoTrue itself validates (still a real TrueCalling user token).
  if (OAUTH_AUDIENCE) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(OAUTH_AUDIENCE)) {
      // DIAGNOSTIC (temporaire) — logue seulement l'aud (pas le jeton) pour
      // pointer un mismatch hook/audience. À retirer une fois OAuth validé.
      console.error(
        `[oauth-debug] bearer REJECTED on audience: token aud=${JSON.stringify(payload.aud)} expected=${JSON.stringify(OAUTH_AUDIENCE)}`,
      );
      return null;
    }
  }

  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${jwt}` },
    });
  } catch (e) {
    console.error(`[truecalling-mcp] token validation unreachable: ${(e as Error).message}`);
    return null;
  }
  if (!res.ok) {
    // DIAGNOSTIC (temporaire) — GoTrue a rejeté le jeton (signature/expiré/
    // révoqué). Logue le statut + l'aud, jamais le jeton. À retirer ensuite.
    console.error(
      `[oauth-debug] bearer REJECTED by GoTrue: status=${res.status} aud=${JSON.stringify(payload.aud)}`,
    );
    return null;
  }
  console.error(`[oauth-debug] bearer ACCEPTED: aud=${JSON.stringify(payload.aud)}`);

  const user = (await res.json().catch(() => null)) as { id?: string } | null;
  if (!user?.id) return null;

  const ctx: UserContext = {
    userId: user.id,
    accessToken: jwt,
    keyFingerprint: tokenHash.slice(0, 12),
    allowedTools: null,
  };
  // Cache until just before the token's own expiry (GoTrue already checked
  // it). Tokens in their final minute — or without a usable exp — are NOT
  // cached: the cache must never outlive the token itself.
  const expMs = payload.exp ? payload.exp * 1000 - now - EXPIRY_SAFETY_MS : 0;
  if (expMs > 0) {
    const ttlMs = Math.min(expMs, 4 * 60_000);
    if (bearerCache.size >= CACHE_MAX) {
      for (const [key, entry] of bearerCache) {
        if (entry.expiresAt <= now) bearerCache.delete(key);
      }
      while (bearerCache.size >= CACHE_MAX) {
        const oldest = bearerCache.keys().next().value;
        if (oldest === undefined) break;
        bearerCache.delete(oldest);
      }
    }
    bearerCache.set(tokenHash, { ctx, expiresAt: now + ttlMs });
  }
  return ctx;
}
