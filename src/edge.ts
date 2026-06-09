import { FUNCTIONS_URL, SUPABASE_ANON_KEY } from "./config.js";
import { getAccessToken } from "./supabase.js";

export async function invokeEdge<T = unknown>(name: string, body?: unknown): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail =
      typeof json === "object" && json && "error" in json
        ? JSON.stringify((json as { error: unknown }).error)
        : text.slice(0, 400);
    throw new Error(`Edge function "${name}" failed (${res.status}): ${detail}`);
  }
  return json as T;
}
