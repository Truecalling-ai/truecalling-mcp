import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { READONLY } from "./config.js";

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
