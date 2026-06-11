import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";

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

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
  const server = buildServer();
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
  const apiKey = process.env.TC_MCP_HTTP_API_KEY;
  if (!apiKey || apiKey.length < MIN_API_KEY_LENGTH) {
    console.error(
      `[truecalling-mcp] HTTP mode requires TC_MCP_HTTP_API_KEY (>= ${MIN_API_KEY_LENGTH} chars). ` +
        `Generate one with: node -e "console.log(crypto.randomBytes(32).toString('hex'))"`,
    );
    process.exit(1);
  }

  const port = resolvePort();

  const httpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");

      // Unauthenticated liveness probe for hosting platforms.
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (url.pathname !== "/mcp") {
        jsonError(res, 404, "Not found. MCP endpoint is POST /mcp");
        return;
      }

      const ip = req.socket.remoteAddress ?? "unknown";
      if (authThrottled(ip)) {
        jsonError(res, 429, "Too many failed authentication attempts. Try again in a minute.");
        return;
      }

      const provided = extractApiKey(req);
      if (!provided || !keyMatches(provided, apiKey)) {
        recordAuthFailure(ip);
        jsonError(res, 401, "Unauthorized: provide the API key via x-api-key or Authorization: Bearer");
        return;
      }

      if (req.method !== "POST") {
        // Stateless mode has no standalone SSE stream (GET) and no session to
        // delete (DELETE) — only POST carries JSON-RPC.
        res.setHeader("allow", "POST");
        jsonError(res, 405, "Method not allowed. Use POST.");
        return;
      }

      await handleMcpRequest(req, res);
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
