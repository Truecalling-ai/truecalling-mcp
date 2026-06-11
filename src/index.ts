#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { supabase } from "./supabase.js";
import { buildServer } from "./server.js";
import { startHttpServer } from "./http.js";

async function main() {
  // HTTP mode (Streamable HTTP) for remote clients like Microsoft Copilot
  // Studio. Stdio stays the default so existing Claude configs keep working.
  if (process.argv.includes("--http") || process.env.TC_MCP_TRANSPORT === "http") {
    const httpServer = startHttpServer();
    // PaaS platforms (Railway/Render/Azure) send exactly one SIGTERM per
    // deploy/restart. Registering a listener disables Node's default
    // terminate-on-signal, so we must drain and exit ourselves or the old
    // instance lingers until the grace-period SIGKILL.
    const stop = () => {
      supabase.auth.stopAutoRefresh().catch(() => undefined);
      httpServer.close(() => process.exit(0));
      httpServer.closeIdleConnections();
      // Backstop: don't hang past the platform grace period on a stuck request.
      setTimeout(() => process.exit(0), 10_000).unref();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }

  // Stop the auto-refresh setTimeout on shutdown so the process can exit cleanly.
  const shutdown = () => {
    supabase.auth.stopAutoRefresh().catch(() => undefined);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("[truecalling-mcp] fatal:", e);
  process.exit(1);
});
