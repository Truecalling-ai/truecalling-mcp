import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Black-box test of the multi-tenant HTTP mode: boots the built bundle with
// --http against a MOCK key-exchange endpoint, and exercises auth + tool
// visibility per key type. No real Supabase access (only tools/list is called).
const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "dist", "index.js");

const PORT = 39300 + Math.floor(Math.random() * 200);
const MOCK_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;

const KEY_A = `tcmcp_${"a".repeat(64)}`; // valid, all tools
const KEY_B = `tcmcp_${"b".repeat(64)}`; // revoked → exchange 401
const KEY_C = `tcmcp_${"c".repeat(64)}`; // valid, allowlist [list_candidates]
const LEGACY_KEY = "legacy-key-0123456789abcdef";

let exchangeHits: Record<string, number> = {};
let mock: Server;
let child: ChildProcess;

function startMockExchange(): Promise<void> {
  mock = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const apiKey = (() => {
        try {
          return JSON.parse(body).api_key as string;
        } catch {
          return "";
        }
      })();
      exchangeHits[apiKey] = (exchangeHits[apiKey] ?? 0) + 1;
      const respond = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (apiKey === KEY_A) {
        respond(200, {
          token: "fake-jwt-user-a",
          expires_in: 300,
          user_id: "00000000-0000-0000-0000-00000000000a",
          allowed_tools: null,
        });
      } else if (apiKey === KEY_C) {
        respond(200, {
          token: "fake-jwt-user-c",
          expires_in: 300,
          user_id: "00000000-0000-0000-0000-00000000000c",
          allowed_tools: ["list_candidates"],
        });
      } else {
        respond(401, { error: "Invalid or revoked API key" });
      }
    });
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

async function toolsList(key?: string): Promise<{ status: number; tools?: string[] }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["x-api-key"] = key;
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  if (!res.ok) return { status: res.status };
  const json = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
  return { status: res.status, tools: (json.result?.tools ?? []).map((t) => t.name) };
}

before(async () => {
  await startMockExchange();
  child = spawn(process.execPath, [SERVER, "--http"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      TC_MCP_HTTP_PORT: String(PORT),
      TC_MCP_KEY_EXCHANGE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      TC_MCP_HTTP_API_KEY: LEGACY_KEY,
      TC_MCP_NO_UPDATE: "1",
    },
  });
  await waitForHealth();
});

after(() => {
  child?.kill("SIGKILL");
  mock?.close();
});

test("personal key resolves to a user context: full tool list, NO auth tools", async () => {
  const { status, tools } = await toolsList(KEY_A);
  assert.equal(status, 200);
  assert.ok(tools!.includes("list_candidates"), "expected business tools");
  assert.ok(!tools!.includes("tc_login"), "tc_login must NOT be exposed to self-service keys");
  assert.ok(!tools!.includes("tc_logout"), "tc_logout must NOT be exposed to self-service keys");
});

test("key exchange is cached: two requests, one exchange call", async () => {
  exchangeHits = {};
  await toolsList(KEY_A);
  await toolsList(KEY_A);
  assert.equal(exchangeHits[KEY_A] ?? 0, 0, "expected cache hit from previous test (no new exchange)");
});

test("revoked key → neutral 401", async () => {
  const { status } = await toolsList(KEY_B);
  assert.equal(status, 401);
});

test("unknown tcmcp_ key → 401; garbage key → 401; missing key → 401", async () => {
  assert.equal((await toolsList(`tcmcp_${"d".repeat(64)}`)).status, 401);
  assert.equal((await toolsList("not-a-real-key-aaaaaaaa")).status, 401);
  assert.equal((await toolsList(undefined)).status, 401);
});

test("per-key allowlist filters tools/list to exactly the allowed set", async () => {
  const { status, tools } = await toolsList(KEY_C);
  assert.equal(status, 200);
  assert.deepEqual(tools, ["list_candidates"]);
});

test("legacy single key still works and keeps auth tools (owner mode)", async () => {
  const { status, tools } = await toolsList(LEGACY_KEY);
  assert.equal(status, 200);
  assert.ok(tools!.includes("tc_login"), "legacy mode keeps tc_login");
  assert.ok(tools!.includes("list_candidates"));
});

test("OAuth disabled (default): a Supabase-style JWT is NOT an acceptable credential", async () => {
  const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = `${b64url({ alg: "HS256" })}.${b64url({ sub: "u", aud: "authenticated" })}.sig`;
  const { status } = await toolsList(jwt);
  assert.equal(status, 401);
});

test("OAuth disabled (default): protected-resource metadata is not served", async () => {
  const res = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
  assert.equal(res.status, 404);
});
