#!/usr/bin/env node
// TrueCalling MCP launcher.
//
// 1. Best-effort self-update: `git pull` the committed, self-contained bundle.
// 2. Run dist/index.js, handing stdin/stdout straight to it (MCP stdio).
//
// The committed dist/index.js bundles every dependency, so there is NO
// `npm install` here — that kills both the npx cache staleness and the
// corporate-TLS-on-npm failures clients kept hitting. git's output goes to
// /dev/null (stdio: "ignore") so it can never corrupt the JSON-RPC stream.
//
// Set TC_MCP_NO_UPDATE=1 to skip the pull (instant start, no auto-update).
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));

if (process.env.TC_MCP_NO_UPDATE !== "1") {
  try {
    // Disable hooks + fsmonitor during the auto-update pull so a hook planted in
    // the local clone's .git can't run arbitrary code as the user on every launch.
    spawnSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", dir, "pull", "--ff-only", "--quiet"],
      { stdio: "ignore", timeout: 12000 },
    );
  } catch {
    // offline / git missing / not a clone — fall through to the bundle on disk
  }
}

const child = spawn(process.execPath, [join(dir, "dist", "index.js")], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
