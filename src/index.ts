#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
    version: "0.1.0",
  });

  // Auth is lazy: getAccessToken() calls ensureAuth() on first tool invocation.
  // This way tools/list still works even if TC_PASSWORD is missing.
  registerCandidatesTools(server);
  registerJobsTools(server);
  registerSearchTools(server);
  registerEmilyTools(server);
  registerPsyTools(server);
  registerReportsTools(server);
  registerEnterprisesTools(server);
  registerBatchTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("[truecalling-mcp] fatal:", e);
  process.exit(1);
});
