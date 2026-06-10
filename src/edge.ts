import { FUNCTIONS_URL, SUPABASE_ANON_KEY } from "./config.js";
import { getAccessToken } from "./supabase.js";

// Transient statuses worth retrying — gateway timeouts / rate limits / cold edges.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function invokeEdge<T = unknown>(name: string, body?: unknown): Promise<T> {
  // getAccessToken throws NotSignedInError if no session is loaded.
  // Tool handlers should be wrapped with withAuth() to convert that into a user-facing message.
  const token = await getAccessToken();
  const url = `${FUNCTIONS_URL}/${name}`;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  let lastErr: Error = new Error(`Edge function "${name}" failed`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
        },
        body: payload,
      });
    } catch (e) {
      // Network error — retry a few times before giving up.
      lastErr = e as Error;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(600 * attempt * attempt);
        continue;
      }
      throw lastErr;
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (res.ok) return json as T;

    const detail =
      typeof json === "object" && json && "error" in json
        ? JSON.stringify((json as { error: unknown }).error)
        : text.slice(0, 400);
    lastErr = new Error(`Edge function "${name}" failed (${res.status}): ${detail}`);

    // Retry transient failures (e.g. FullEnrich/edge 504) with backoff; fail fast on 4xx like 400/401.
    if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
      await sleep(600 * attempt * attempt);
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}
