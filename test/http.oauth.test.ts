import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Black-box test of the Phase 2 OAuth resource-server behavior: boots the
// built bundle with --http against a MOCK GoTrue (/auth/v1/user) and checks
// bearer validation, discovery metadata, and the WWW-Authenticate challenge.
const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "dist", "index.js");

const PORT = 39600 + Math.floor(Math.random() * 200);
const MOCK_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const RESOURCE = "https://mcp.test.example";

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
function makeJwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.${"sig".repeat(10)}`;
}
const GOOD_JWT = makeJwt({ sub: "u-good", aud: RESOURCE, exp: Math.floor(Date.now() / 1000) + 3600 });
const BAD_JWT = makeJwt({ sub: "u-bad", aud: RESOURCE, exp: Math.floor(Date.now() / 1000) + 3600 });
// Valid GoTrue token but minted for the app, not the MCP — must be rejected
// BEFORE any GoTrue call (RFC 8707 audience binding).
const APP_SESSION_JWT = makeJwt({ sub: "u-good", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });

let gotrueHits = 0;
let mock: Server;
let child: ChildProcess;

function startMockGoTrue(): Promise<void> {
  mock = createServer((req, res) => {
    const respond = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.url?.startsWith("/auth/v1/user")) {
      gotrueHits++;
      const auth = req.headers.authorization ?? "";
      if (auth === `Bearer ${GOOD_JWT}`) {
        respond(200, { id: "00000000-0000-0000-0000-0000000000aa", aud: "authenticated", email: "a@b.c" });
      } else {
        respond(401, { msg: "invalid JWT" });
      }
      return;
    }
    respond(404, { error: "not found" });
  });
  return new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));
}

async function waitForHealth(timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become healthy in time");
}

async function toolsList(bearer?: string): Promise<{ status: number; www?: string | null; tools?: string[] }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  if (!res.ok) return { status: res.status, www: res.headers.get("www-authenticate") };
  const json = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
  return { status: res.status, tools: (json.result?.tools ?? []).map((t) => t.name) };
}

before(async () => {
  await startMockGoTrue();
  child = spawn(process.execPath, [SERVER, "--http"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      TC_MCP_HTTP_PORT: String(PORT),
      // Point the whole Supabase base at the mock so /auth/v1/user lands there.
      SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      TC_MCP_RESOURCE_URL: RESOURCE,
      TC_MCP_OAUTH_ENABLED: "true",
      TC_MCP_OAUTH_AUDIENCE: RESOURCE,
      TC_MCP_NO_UPDATE: "1",
    },
  });
  await waitForHealth();
});

after(() => {
  child?.kill("SIGKILL");
  mock?.close();
});

test("well-known protected-resource metadata points at the Supabase auth server", async () => {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const res = await fetch(`${BASE}${path}`);
    assert.equal(res.status, 200);
    const meta = (await res.json()) as { resource: string; authorization_servers: string[] };
    assert.equal(meta.resource, RESOURCE);
    assert.deepEqual(meta.authorization_servers, [`http://127.0.0.1:${MOCK_PORT}/auth/v1`]);
  }
});

test("valid bearer → user context: full tool list, NO auth tools", async () => {
  const { status, tools } = await toolsList(GOOD_JWT);
  assert.equal(status, 200);
  assert.ok(tools!.includes("list_candidates"));
  assert.ok(!tools!.includes("tc_login"), "tc_login must NOT be exposed to OAuth users");
});

test("bearer validation is cached until token expiry", async () => {
  const baseline = gotrueHits;
  await toolsList(GOOD_JWT);
  await toolsList(GOOD_JWT);
  assert.equal(gotrueHits, baseline, "expected no new GoTrue validation calls (cache)");
});

test("rejected bearer → neutral 401 with invalid_token challenge", async () => {
  const { status, www } = await toolsList(BAD_JWT);
  assert.equal(status, 401);
  assert.ok(
    www?.includes(`resource_metadata="${RESOURCE}/.well-known/oauth-protected-resource"`),
    `expected RFC 9728 challenge, got: ${www}`,
  );
  assert.ok(www?.includes(`error="invalid_token"`), `expected RFC 6750 error attr, got: ${www}`);
});

test("app session token (wrong audience) → 401 WITHOUT any GoTrue call", async () => {
  const baseline = gotrueHits;
  const { status } = await toolsList(APP_SESSION_JWT);
  assert.equal(status, 401);
  assert.equal(gotrueHits, baseline, "audience check must reject before contacting GoTrue");
});

test("OPTIONS preflight → 204 with CORS headers, never counts as auth failure", async () => {
  const res = await fetch(`${BASE}/mcp`, { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.ok(res.headers.get("access-control-allow-headers")?.includes("authorization"));
});

test("tokenless request → 401 with WWW-Authenticate challenge", async () => {
  const { status, www } = await toolsList(undefined);
  assert.equal(status, 401);
  assert.ok(www?.includes("Bearer resource_metadata="), `expected challenge, got: ${www}`);
});

test("malformed (non-JWS, non-key) credential → 401", async () => {
  const { status } = await toolsList("definitely-not-a-token");
  assert.equal(status, 401);
});
