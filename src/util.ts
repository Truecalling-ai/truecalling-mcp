import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READONLY } from "./config.js";
import { ensureAuth, NotSignedInError, SESSION_FILE } from "./supabase.js";

export function ok(data: unknown): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: typeof data === "object" && data !== null ? (data as Record<string, unknown>) : { value: data },
  };
}

export function err(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${message}` }],
  };
}

export function guardWrite(toolName: string): CallToolResult | null {
  if (READONLY) {
    return err(`Tool "${toolName}" is disabled because TC_MCP_READONLY=true.`);
  }
  return null;
}

// Keys a tool caller must never set through a free-form patch/payload/extra
// object. Defense-in-depth on top of RLS: strips prototype-pollution keys and
// server-owned identity/timestamp columns always; in "update" mode it also
// blocks re-homing an existing row to another tenant (enterprise_id) or
// poisoning the LinkedIn dedupe key.
const PROTO_KEYS = ["__proto__", "constructor", "prototype"];
const STRIP_ALWAYS = [...PROTO_KEYS, "id", "created_at", "updated_at"];
const STRIP_ON_UPDATE = [...STRIP_ALWAYS, "enterprise_id", "linkedin_norm"];

export function sanitizeWritable<T extends Record<string, unknown>>(obj: T, mode: "create" | "update"): T {
  const out: Record<string, unknown> = { ...obj };
  for (const k of mode === "update" ? STRIP_ON_UPDATE : STRIP_ALWAYS) delete out[k];
  return out as T;
}

/**
 * Canonical not-signed-in error. Returned to the LLM so it knows to call tc_login.
 */
export function notSignedInError(): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          `Not signed in. Call the \`tc_login\` tool with your TrueCalling email and password. ` +
          `Your session will be cached at ${SESSION_FILE} so you only need to do this once per machine.`,
      },
    ],
  };
}

/**
 * Wrap a tool handler so it:
 *  1. Calls ensureAuth() first — guarantees the Supabase client has a session
 *     before any DB query, otherwise all queries silently run as anon.
 *  2. Catches NotSignedInError and returns the canonical user-facing message
 *     instructing the LLM to call `tc_login`.
 *  3. Catches other errors and returns them via `err()`.
 */
export function withAuth<A extends unknown[]>(
  handler: (...args: A) => Promise<CallToolResult>,
): (...args: A) => Promise<CallToolResult> {
  return async (...args: A): Promise<CallToolResult> => {
    try {
      await ensureAuth();
      return await handler(...args);
    } catch (e) {
      if (e instanceof NotSignedInError) return notSignedInError();
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  };
}

/**
 * Returns a wrapper around `server.registerTool` that auto-applies `withAuth`
 * to every handler. Use inside `registerXxxTools(server)` so every tool in
 * that group transparently gets auth-gating + error handling.
 *
 * Usage:
 *   const registerTool = authedRegisterTool(server);
 *   registerTool("foo", { ... }, async (args) => { ... });
 */
type RegisterToolFn = McpServer["registerTool"];
export function authedRegisterTool(server: McpServer): RegisterToolFn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((name: string, config: any, handler: any) => {
    return server.registerTool(name, config, withAuth(handler));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}
