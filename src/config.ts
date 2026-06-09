// Public anon defaults — safe to ship. Override via env if needed.
const DEFAULT_SUPABASE_URL = "https://gxnriabesrpbgpireubf.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd4bnJpYWJlc3JwYmdwaXJldWJmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4Nzg1MjksImV4cCI6MjA5MjQ1NDUyOX0.-Wubl7PwAxe5sgv7NEzRhwzEq-ruWmoIFzmPoLTcss4";

export const SUPABASE_URL = process.env.SUPABASE_URL ?? DEFAULT_SUPABASE_URL;
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? DEFAULT_SUPABASE_ANON_KEY;

export const READONLY = process.env.TC_MCP_READONLY === "true";

export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
