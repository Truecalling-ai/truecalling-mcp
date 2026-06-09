import { createClient } from "@supabase/supabase-js";
import { isAuthApiError } from "@supabase/auth-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { sessionFilePath } from "./session-path.js";
import { deleteSessionFile, readSessionFile, writeSessionFile } from "./session-file.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  // TrueCalling's data lives in the `api` Postgres schema (PostgREST's default
  // here), NOT `public`. supabase-js defaults db.schema to `public`, which is a
  // near-empty prototype copy — every table query must target `api` or it reads
  // the wrong tables (e.g. a stale public.job_descriptions with a different schema).
  db: { schema: "api" },
  auth: { persistSession: false, autoRefreshToken: true },
});

export const SESSION_FILE = sessionFilePath();

/**
 * Thrown when a tool needs auth but no session is available.
 * Tool wrappers catch this and convert to a user-facing instruction.
 */
export class NotSignedInError extends Error {
  constructor() {
    super("Not signed in");
    this.name = "NotSignedInError";
  }
}

const EXPIRED_CODES = new Set([
  "refresh_token_not_found",
  "refresh_token_already_used",
  "session_not_found",
  "session_expired",
  "bad_jwt",
]);

// Serialize disk writes from the auth listener so concurrent SIGNED_IN /
// TOKEN_REFRESHED events can't race a half-written session file. Also lets
// signOut() await any in-flight write before deleting the file.
let writeQueue: Promise<void> = Promise.resolve();
// When true the auth listener stops persisting — used to win the race against
// a SIGNED_IN event that fires after signOut() decided to clear state.
let signingOut = false;

function enqueuePersist(session: { access_token: string; refresh_token: string }): void {
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(() => {
      if (signingOut) return;
      return writeSessionFile(SESSION_FILE, session);
    })
    .catch((e) => {
      console.error(`[truecalling-mcp] failed to persist session: ${(e as Error).message}`);
    });
}

// Persist rotated tokens. SYNC callback — async overload is deprecated (deadlock risk).
supabase.auth.onAuthStateChange((event, session) => {
  if (!session) return;
  if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
    enqueuePersist({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
  }
  // intentionally do NOT delete file on SIGNED_OUT — process teardown can emit it
});

/**
 * Tries to rehydrate the Supabase session from disk.
 * Returns true if a valid session was restored.
 * Unlinks the file when refresh tokens are expired/rotated/revoked.
 */
async function tryRestoreFromDisk(): Promise<boolean> {
  const parsed = await readSessionFile(SESSION_FILE);
  if (!parsed) return false;

  try {
    const { data, error } = await supabase.auth.setSession({
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token,
    });
    if (error) {
      const code = isAuthApiError(error) ? error.code : undefined;
      if (code && EXPIRED_CODES.has(code)) {
        console.error(
          `[truecalling-mcp] cached session expired (${code}); please re-run tc_login`,
        );
        await deleteSessionFile(SESSION_FILE);
        return false;
      }
      // unknown error — could be transient (network). Don't blow away the file.
      throw new Error(`Supabase setSession failed: ${error.message}`);
    }
    return Boolean(data.session);
  } catch (e) {
    // Bubble up unknown errors; readSessionFile already handled parse errors.
    throw e;
  }
}

// Memoize the bootstrap so concurrent first calls don't race into two restores.
let authPromise: Promise<boolean> | null = null;

/**
 * Ensures a Supabase session is loaded.
 * Throws NotSignedInError if no session can be established without credentials.
 */
export async function ensureAuth(): Promise<void> {
  if (!authPromise) {
    authPromise = (async () => {
      // If we already have an in-memory session (just signed in this process), short-circuit.
      const { data: cur } = await supabase.auth.getSession();
      if (cur.session) return true;
      return tryRestoreFromDisk();
    })().catch((e) => {
      authPromise = null;
      throw e;
    });
  }
  const ok = await authPromise;
  if (!ok) {
    // Confirm — if signInWithCredentials was called concurrently, session may now exist.
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new NotSignedInError();
  }
}

/**
 * Signs in with email + password. Called by the `tc_login` tool.
 * On success the onAuthStateChange listener persists the session to disk.
 */
export async function signInWithCredentials(
  email: string,
  password: string,
): Promise<{ email: string }> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) {
    throw new Error(`Sign-in failed: ${error?.message ?? "no session returned"}`);
  }
  // Re-arm the memoized auth promise so future ensureAuth() calls see the session.
  authPromise = Promise.resolve(true);
  return { email: data.user.email ?? email };
}

/**
 * Signs out and removes the cached session file. Waits for any pending
 * SIGNED_IN/TOKEN_REFRESHED persistence to drain so the file can't be
 * resurrected after we delete it.
 */
export async function signOut(): Promise<void> {
  signingOut = true;
  try {
    await supabase.auth.signOut().catch(() => undefined);
    // Drain anything the listener queued before the flag flipped.
    await writeQueue.catch(() => undefined);
    await deleteSessionFile(SESSION_FILE);
    authPromise = null;
  } finally {
    signingOut = false;
  }
}

/**
 * Returns current auth status. Does not throw if not signed in.
 */
export async function getAuthStatus(): Promise<{
  logged_in: boolean;
  email: string | null;
  expires_at: number | null;
  session_path: string;
}> {
  // Try to rehydrate from disk if nothing is in memory yet, but never throw.
  try {
    await ensureAuth();
  } catch {
    // not signed in — fall through
  }
  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    return { logged_in: false, email: null, expires_at: null, session_path: SESSION_FILE };
  }
  return {
    logged_in: true,
    email: data.session.user?.email ?? null,
    expires_at: data.session.expires_at ?? null,
    session_path: SESSION_FILE,
  };
}

export async function getAccessToken(): Promise<string> {
  await ensureAuth();
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new NotSignedInError();
  return data.session.access_token;
}
