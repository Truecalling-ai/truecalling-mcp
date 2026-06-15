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

export interface BuildServerOptions {
  /**
   * Register tc_login/tc_logout/tc_auth_status. Default true (stdio, legacy
   * HTTP). False for self-service-key requests: the key IS the credential,
   * and a shared remote process must never expose a global login/logout.
   */
  exposeAuthTools?: boolean;
  /** Per-key tool allowlist (from mcp_api_keys.allowed_tools). Null/undefined = all. */
  allowedTools?: string[] | null;
}

/**
 * Builds a fully-registered McpServer instance. Shared by the stdio entry
 * (one long-lived instance) and the Streamable HTTP entry (one instance per
 * request in stateless mode).
 */
export function buildServer(options?: BuildServerOptions): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Per-key allowlist: filter at REGISTRATION so disallowed tools never even
  // appear in tools/list — the LLM can't call what it can't see.
  if (options?.allowedTools && options.allowedTools.length > 0) {
    const allowed = new Set(options.allowedTools);
    const original = server.registerTool.bind(server);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool = (name: string, config: any, handler: any) =>
      allowed.has(name) ? original(name, config, handler) : undefined;
  }

  // Register auth tools FIRST so tc_login appears at the top of tools/list.
  // Auth is lazy: tools/list works pre-auth; only handler invocation needs a session.
  if (options?.exposeAuthTools !== false) {
    registerAuthTools(server);
  }

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
