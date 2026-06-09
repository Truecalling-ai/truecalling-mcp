function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const SUPABASE_URL = requireEnv("SUPABASE_URL");
export const SUPABASE_ANON_KEY = requireEnv("SUPABASE_ANON_KEY");
export const TC_EMAIL = process.env.TC_EMAIL ?? "";
export const TC_PASSWORD = process.env.TC_PASSWORD ?? "";

export function assertCreds(): void {
  if (!TC_EMAIL) throw new Error("Missing TC_EMAIL in env");
  if (!TC_PASSWORD) throw new Error("Missing TC_PASSWORD in env — fill it in .env then restart Claude Code");
}

export const READONLY = process.env.TC_MCP_READONLY === "true";

export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
