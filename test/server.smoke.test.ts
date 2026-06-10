import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Black-box smoke test: boot the built bundle over stdio and exercise the
// JSON-RPC surface. Covers "build produced a runnable server", "server starts",
// and "every tool exposes a valid input schema" without any network/auth.
const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "dist", "index.js");

const INIT = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
};
const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

function rpc(requests: unknown[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, TC_MCP_NO_UPDATE: "1" },
    });
    let buf = "";
    const responses: any[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out waiting for server responses"));
    }, 10000);
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try {
            responses.push(JSON.parse(line));
          } catch {
            /* ignore non-JSON noise */
          }
        }
      }
      if (responses.length >= requests.length) {
        clearTimeout(timer);
        child.kill();
        resolve(responses);
      }
    });
    child.on("error", reject);
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
  });
}

let cached: any[] | null = null;
async function tools(): Promise<any[]> {
  if (!cached) {
    const res = await rpc([INIT, LIST]);
    const list = res.find((r) => r.id === 1);
    assert.ok(list, "tools/list responded");
    cached = list.result.tools;
  }
  return cached!;
}

test("server boots and lists tools", async () => {
  const t = await tools();
  assert.ok(Array.isArray(t), "tools is an array");
  assert.ok(t.length >= 51, `expected >= 51 tools, got ${t.length}`);
});

test("every tool has a name, description and an object input schema", async () => {
  for (const tool of await tools()) {
    assert.ok(tool.name, "tool has a name");
    assert.ok(tool.description && tool.description.length > 10, `${tool.name} has a real description`);
    assert.equal(tool.inputSchema?.type, "object", `${tool.name} exposes an object inputSchema`);
  }
});

test("candidate-search and JD-comparison tools expose their expected inputs", async () => {
  const byName = Object.fromEntries((await tools()).map((t) => [t.name, t]));
  assert.ok(byName.list_candidates, "list_candidates present");
  const props = Object.keys(byName.list_candidates.inputSchema.properties ?? {});
  for (const k of ["search", "status", "job_description_id", "limit"]) {
    assert.ok(props.includes(k), `list_candidates exposes "${k}"`);
  }
  assert.ok(byName.compare_jd_candidate, "compare_jd_candidate present");
  assert.ok(byName.search_jd_candidates, "search_jd_candidates present");
  // newly-added tools are wired in
  for (const k of ["generate_interview_questions", "analyze_cv_standalone", "find_recruiter", "generate_writer"]) {
    assert.ok(byName[k], `${k} present`);
  }
});
