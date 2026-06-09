#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { supabase } from "./supabase.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerCandidatesTools } from "./tools/candidates.js";
import { registerJobsTools } from "./tools/jobs.js";
import { registerSearchTools } from "./tools/search.js";
import { registerEmilyTools } from "./tools/emily.js";
import { registerPsyTools } from "./tools/psy.js";
import { registerReportsTools } from "./tools/reports.js";
import { registerEnterprisesTools } from "./tools/enterprises.js";
import { registerBatchTools } from "./tools/batch.js";

async function main() {
  const server = new McpServer({
    name: "truecalling-mcp-server",
    version: "0.2.0",
  });

  // Register auth tools FIRST so tc_login appears at the top of tools/list.
  // Auth is lazy: tools/list works pre-auth; only handler invocation needs a session.
  registerAuthTools(server);

  registerCandidatesTools(server);
  registerJobsTools(server);
  registerSearchTools(server);
  registerEmilyTools(server);
  registerPsyTools(server);
  registerReportsTools(server);
  registerEnterprisesTools(server);
  registerBatchTools(server);

  // Stop the auto-refresh setTimeout on shutdown so the process can exit cleanly.
  const shutdown = () => {
    supabase.auth.stopAutoRefresh().catch(() => undefined);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("[truecalling-mcp] fatal:", e);
  process.exit(1);
});
