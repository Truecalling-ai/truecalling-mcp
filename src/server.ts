import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerCandidatesTools } from "./tools/candidates.js";
import { registerJobsTools } from "./tools/jobs.js";
import { registerSearchTools } from "./tools/search.js";
import { registerEmilyTools } from "./tools/emily.js";
import { registerPsyTools } from "./tools/psy.js";
import { registerReportsTools } from "./tools/reports.js";
import { registerEnterprisesTools } from "./tools/enterprises.js";
import { registerBatchTools } from "./tools/batch.js";
import { registerAnalysisTools } from "./tools/analysis.js";

export const SERVER_NAME = "truecalling-mcp-server";
export const SERVER_VERSION = "0.2.0";

/**
 * Builds a fully-registered McpServer instance. Shared by the stdio entry
 * (one long-lived instance) and the Streamable HTTP entry (one instance per
 * request in stateless mode).
 */
export function buildServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
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
  registerAnalysisTools(server);

  return server;
}
