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
  // Disable hooks + fsmonitor so a hook planted in the local clone's .git can't
  // run arbitrary code as the user on every launch.
  const git = (args) =>
    spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", dir, ...args], {
      stdio: "ignore",
      timeout: 12000,
    });
  try {
    // Force-sync to origin/main with reset --hard (NOT pull --ff-only): a client
    // clone that drifted — a locally-rebuilt dist/index.js, or CRLF line-ending
    // churn on Windows — would make pull fail the merge and leave the client
    // stuck on an old version forever. Clients never edit the repo, so a hard
    // reset to the fetched tip is the safe, self-healing update. Offline → fetch
    // fails → we keep the bundle already on disk.
    if (git(["fetch", "--quiet", "origin", "main"]).status === 0) {
      git(["reset", "--hard", "--quiet", "origin/main"]);
    }
  } catch {
    // git missing / not a clone — fall through to the bundle on disk
  }
}

const child = spawn(process.execPath, [join(dir, "dist", "index.js")], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
