import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAuthStatus, SESSION_FILE, signInWithCredentials, signOut } from "../supabase.js";
import { err, ok } from "../util.js";

// In-memory failed-attempt counter — prevents a buggy LLM loop from
// hammering Supabase with brute-force attempts. Resets on success.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;
let failedAttempts = 0;
let lockedUntil = 0;

export function registerAuthTools(server: McpServer): void {
  server.registerTool(
    "tc_login",
    {
      title: "Sign in to TrueCalling",
      description:
        `Sign in to TrueCalling with your email + password. Call this ONCE per machine; your session is cached at ${SESSION_FILE} (mode 0600 plaintext JSON) and auto-refreshed thereafter. ` +
        `Claude: if any other TrueCalling tool returns a "Not signed in" error, ask the user for their TrueCalling email and password and call this tool with them. ` +
        `⚠️ SECURITY: the password is recorded in this conversation's transcript and any MCP client logs. Only access + refresh tokens (not the password) are persisted to disk. ` +
        `After 5 failed attempts the tool refuses further logins for 60 seconds.`,
      inputSchema: {
        email: z.string().email().describe("TrueCalling account email"),
        password: z.string().min(1).describe("TrueCalling account password"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ email, password }) => {
      const now = Date.now();
      if (lockedUntil > now) {
        const secs = Math.ceil((lockedUntil - now) / 1000);
        return err(
          `Too many failed login attempts. Wait ${secs}s before trying again, or check the email/password are correct.`,
        );
      }
      try {
        const { email: signedInEmail } = await signInWithCredentials(email, password);
        failedAttempts = 0;
        lockedUntil = 0;
        return ok({
          signed_in_as: signedInEmail,
          session_cached_at: SESSION_FILE,
          message: `Signed in as ${signedInEmail}. Session cached.`,
        });
      } catch (e) {
        failedAttempts++;
        if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
          lockedUntil = Date.now() + LOCKOUT_MS;
          failedAttempts = 0;
          return err(
            `${e instanceof Error ? e.message : String(e)} — too many failed attempts; locked out for 60s.`,
          );
        }
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "tc_logout",
    {
      title: "Sign out of TrueCalling",
      description:
        "Sign out of TrueCalling. Clears the in-memory session AND deletes the cached session file on disk. " +
        "Use this to switch to a different TrueCalling account.",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        await signOut();
        return ok({ signed_out: true, session_file_removed: SESSION_FILE });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "tc_auth_status",
    {
      title: "Current TrueCalling auth status",
      description:
        "Returns whether you're currently signed in to TrueCalling, the email of the signed-in user, the session expiry (unix seconds), and the on-disk session path.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const status = await getAuthStatus();
        return ok(status);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
