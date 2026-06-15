import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";
import {
  API_KEY_RE,
  JWS_RE,
  markHttpMode,
  resolveApiKey,
  resolveBearer,
  runWithContext,
  type UserContext,
} from "./tenants.js";
import { OAUTH_AUDIENCE, OAUTH_ENABLED, RESOURCE_URL, SUPABASE_URL } from "./config.js";

/**
 * Streamable HTTP entry point — lets remote MCP clients (Microsoft Copilot
 * Studio, ChatGPT connectors, etc.) reach the same tools the stdio entry
 * exposes to Claude.
 *
 * Stateless mode: a fresh McpServer + transport per POST. No session ids, so
 * the server can sit behind a load balancer or restart freely. The Supabase
 * session is process-global (single-tenant), exactly like the stdio mode.
 *
 * Security model: HTTP mode refuses to start without TC_MCP_HTTP_API_KEY.
 * Every /mcp request must present it via `x-api-key` or `Authorization:
 * Bearer`. Failed attempts are throttled per source IP. The API key also
 * covers the spec's DNS-rebinding concern (a rebound browser page can't know
 * the key, so it never reaches the MCP layer) — which is why the SDK's
 * deprecated allowedHosts/Origin options are not used here.
 */

const MIN_API_KEY_LENGTH = 16;

// The SDK buffers the whole POST body in memory with no cap of its own, so
// cap it here. 4 MB matches the SDK's historical raw-body default and is far
// above any real JSON-RPC payload.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// Failed-auth throttle: fixed window per source IP so a discovered hostname
// can't be brute-forced at line rate. Behind a reverse proxy every request
// shares the LB's address — the throttle then degrades to a global brake,
// which is still adequate for this single-tenant server.
const AUTH_FAIL_LIMIT = 10;
const AUTH_FAIL_WINDOW_MS = 60_000;
const authFailures = new Map<string, { count: number; resetAt: number }>();

function authThrottled(ip: string): boolean {
  const entry = authFailures.get(ip);
  return entry !== undefined && entry.resetAt > Date.now() && entry.count >= AUTH_FAIL_LIMIT;
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  // Opportunistic sweep so the map can't grow unboundedly across windows.
  if (authFailures.size > 10_000) {
    for (const [key, entry] of authFailures) {
      if (entry.resetAt <= now) authFailures.delete(key);
    }
  }
  const entry = authFailures.get(ip);
  if (!entry || entry.resetAt <= now) {
    authFailures.set(ip, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS });
  } else {
    entry.count++;
  }
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time comparison via digests so length differences don't leak. */
function keyMatches(provided: string, expected: string): boolean {
  return timingSafeEqual(sha256(provided), sha256(expected));
}

function extractApiKey(req: IncomingMessage): string | null {
  const headerKey = req.headers["x-api-key"];
  if (typeof headerKey === "string" && headerKey.length > 0) return headerKey;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return null;
}

// RFC 9728: point OAuth clients (ChatGPT) at the protected-resource metadata
// so they can discover the Supabase authorization server and start the flow.
// The challenge is only emitted when OAuth mode is enabled — otherwise it
// would advertise an authorization server that doesn't exist.
const RESOURCE_METADATA_URL = `${RESOURCE_URL}/.well-known/oauth-protected-resource`;

function setBearerChallenge(res: ServerResponse, invalidToken = false): void {
  if (res.headersSent || !OAUTH_ENABLED) return;
  const attrs = invalidToken ? `error="invalid_token", ` : "";
  res.setHeader("WWW-Authenticate", `Bearer ${attrs}resource_metadata="${RESOURCE_METADATA_URL}"`);
}

function unauthorized(res: ServerResponse, message: string, invalidToken = false): void {
  setBearerChallenge(res, invalidToken);
  jsonError(res, 401, message);
}

/**
 * Real client IP. Azure's front end APPENDS the true client to
 * X-Forwarded-For, so only the RIGHTMOST entry is trustworthy (left entries
 * are attacker-supplied). Falls back to the socket peer when not proxied.
 */
function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const last = xff.split(",").pop()?.trim();
    if (last) {
      // Azure formats IPv4 entries as "ip:port" — strip the port; leave
      // IPv6 (which also contains colons) untouched.
      const v4 = last.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
      return v4 ? v4[1] : last;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

function jsonError(res: ServerResponse, status: number, message: string, code = -32000): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
  );
}

/**
 * Resolves the listen port from TC_MCP_HTTP_PORT, then PORT, then 3000.
 * Fails loudly naming the offending variable — `Number("")` is 0 and
 * `Number("abc")` is NaN, both of which would otherwise either bind a random
 * ephemeral port or crash with a cryptic ERR_SOCKET_BAD_PORT.
 */
function resolvePort(): number {
  const sources: Array<[name: string, raw: string | undefined]> = [
    ["TC_MCP_HTTP_PORT", process.env.TC_MCP_HTTP_PORT],
    ["PORT", process.env.PORT],
  ];
  for (const [name, raw] of sources) {
    if (raw === undefined) continue;
    const port = Number(raw.trim());
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
      console.error(
        `[truecalling-mcp] invalid ${name}="${raw}" — expected an integer between 1 and 65535`,
      );
      process.exit(1);
    }
    return port;
  }
  return 3000;
}

/** Buffers the body up to maxBytes; resolves null when the cap is exceeded. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on("error", (e) => {
      if (!done) reject(e);
    });
  });
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  user: UserContext | null,
): Promise<void> {
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    jsonError(res, 413, `Request body too large (max ${MAX_BODY_BYTES} bytes)`);
    req.destroy();
    return;
  }

  const body = await readBody(req, MAX_BODY_BYTES);
  if (body === null) {
    jsonError(res, 413, `Request body too large (max ${MAX_BODY_BYTES} bytes)`);
    req.destroy();
    return;
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body.toString("utf8"));
  } catch {
    jsonError(res, 400, "Parse error: request body is not valid JSON", -32700);
    return;
  }

  // The SDK hard-requires BOTH media types in Accept and 406s otherwise.
  // With enableJsonResponse the response shape never depends on Accept, so
  // normalize it defensively — proxies and gateways (notably Power Platform's
  // connector infrastructure in front of Copilot Studio) may send `*/*`.
  // The SDK's node wrapper rebuilds headers from rawHeaders (via
  // @hono/node-server), so the parsed `headers` object alone isn't enough.
  const NORMALIZED_ACCEPT = "application/json, text/event-stream";
  req.headers.accept = NORMALIZED_ACCEPT;
  for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
    if (req.rawHeaders[i].toLowerCase() === "accept") req.rawHeaders.splice(i, 2);
  }
  req.rawHeaders.push("accept", NORMALIZED_ACCEPT);

  // Stateless: one server + transport per request, torn down when the
  // response closes. buildServer() is cheap (pure in-memory registration).
  // Self-service-key requests never expose tc_login/tc_logout (the key IS the
  // credential) and honor the per-key tool allowlist.
  const server = buildServer(
    user ? { exposeAuthTools: false, allowedTools: user.allowedTools } : undefined,
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Plain JSON responses (still spec-compliant) — broadest client
    // compatibility, including Copilot Studio.
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

export function startHttpServer(): Server {
  // Arms the fail-closed context check: from here on, any data access that
  // can't see a request context throws instead of touching the legacy session.
  markHttpMode();

  // Legacy single-account key — OPTIONAL now that self-service tcmcp_ keys
  // exist. When set, it must still be strong; when absent, only personal keys
  // are accepted.
  const legacyKey = process.env.TC_MCP_HTTP_API_KEY;
  if (legacyKey !== undefined && legacyKey.length < MIN_API_KEY_LENGTH) {
    console.error(
      `[truecalling-mcp] TC_MCP_HTTP_API_KEY must be >= ${MIN_API_KEY_LENGTH} chars (or unset). ` +
        `Generate one with: node -e "console.log(crypto.randomBytes(32).toString('hex'))"`,
    );
    process.exit(1);
  }
  if (!legacyKey) {
    console.error("[truecalling-mcp] HTTP mode: self-service keys only (no legacy TC_MCP_HTTP_API_KEY)");
  }

  // OAuth mode is fail-closed: without strict audience binding (RFC 8707),
  // ANY Supabase project JWT — including ordinary app session tokens — would
  // become a valid MCP credential. Refuse to start in that state.
  if (OAUTH_ENABLED && !OAUTH_AUDIENCE) {
    console.error(
      "[truecalling-mcp] TC_MCP_OAUTH_ENABLED=true requires TC_MCP_OAUTH_AUDIENCE " +
        "(the resource URL minted into tokens by the Supabase aud Auth Hook — see docs/OAUTH_PHASE2.md).",
    );
    process.exit(1);
  }

  const port = resolvePort();

  const httpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");

      // CORS preflights: answer before any auth/throttle logic — a preflight
      // carries no Authorization header by definition and must never count as
      // an auth failure.
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, x-api-key, mcp-protocol-version",
          "access-control-max-age": "86400",
        });
        res.end();
        return;
      }

      // Unauthenticated liveness probe for hosting platforms.
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      // RFC 9728 protected-resource metadata — public by design, but only
      // once OAuth mode is enabled (otherwise it would advertise a dead
      // authorization server). Also served under the path-suffixed variant
      // some clients derive for /mcp.
      if (
        url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === "/.well-known/oauth-protected-resource/mcp"
      ) {
        if (!OAUTH_ENABLED) {
          jsonError(res, 404, "OAuth is not enabled on this server");
          return;
        }
        res.writeHead(200, {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        });
        res.end(
          JSON.stringify({
            resource: RESOURCE_URL,
            authorization_servers: [`${SUPABASE_URL}/auth/v1`],
            bearer_methods_supported: ["header"],
          }),
        );
        return;
      }

      if (url.pathname !== "/mcp") {
        jsonError(res, 404, "Not found. MCP endpoint is POST /mcp");
        return;
      }

      const ip = clientIp(req);
      if (authThrottled(ip)) {
        setBearerChallenge(res);
        jsonError(res, 429, "Too many failed authentication attempts. Try again in a minute.");
        return;
      }

      const provided = extractApiKey(req);
      if (!provided) {
        // Spec-mandated unauthenticated first contact (RFC 9728 discovery) —
        // answer with the challenge but do NOT count it as a failed attempt.
        unauthorized(res, "Unauthorized: provide an API key (x-api-key) or an OAuth bearer token");
        return;
      }

      // Personal self-service key (tcmcp_*) → per-user context via the
      // key-exchange edge function. Neutral 401 on any failure: never reveal
      // whether a key exists, is revoked, or is malformed.
      if (API_KEY_RE.test(provided)) {
        const user = await resolveApiKey(provided);
        if (!user) {
          recordAuthFailure(ip);
          unauthorized(res, "Invalid or revoked API key");
          return;
        }
        if (req.method !== "POST") {
          res.setHeader("allow", "POST");
          jsonError(res, 405, "Method not allowed. Use POST.");
          return;
        }
        await runWithContext(user, () => handleMcpRequest(req, res, user));
        return;
      }

      // Legacy single-account key (owner use) — exact match, checked before
      // the JWS branch so a legacy key can never be misrouted. Runs under an
      // explicit legacy marker so the fail-closed check can tell "legacy on
      // purpose" from "context lost".
      if (legacyKey && keyMatches(provided, legacyKey)) {
        if (req.method !== "POST") {
          res.setHeader("allow", "POST");
          jsonError(res, 405, "Method not allowed. Use POST.");
          return;
        }
        await runWithContext({ legacy: true }, () => handleMcpRequest(req, res, null));
        return;
      }

      // OAuth bearer token (Phase 2 — ChatGPT, Copilot Studio in OAuth mode):
      // a Supabase-issued JWT, validated against GoTrue on every new token.
      // OPT-IN: without TC_MCP_OAUTH_ENABLED, project JWTs (e.g. app session
      // tokens) are NOT acceptable MCP credentials.
      if (OAUTH_ENABLED && JWS_RE.test(provided)) {
        const user = await resolveBearer(provided);
        if (!user) {
          recordAuthFailure(ip);
          unauthorized(res, "Invalid or expired token", true);
          return;
        }
        if (req.method !== "POST") {
          res.setHeader("allow", "POST");
          jsonError(res, 405, "Method not allowed. Use POST.");
          return;
        }
        await runWithContext(user, () => handleMcpRequest(req, res, user));
        return;
      }

      recordAuthFailure(ip);
      unauthorized(res, "Invalid or revoked credentials");
    })().catch((e) => {
      console.error("[truecalling-mcp] http request error:", e);
      jsonError(res, 500, "Internal server error", -32603);
    });
  });

  httpServer.listen(port, () => {
    console.error(`[truecalling-mcp] Streamable HTTP listening on port ${port} (POST /mcp)`);
  });

  return httpServer;
}
