import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY, TC_EMAIL, TC_PASSWORD, assertCreds } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: true },
});

let signedIn = false;

export async function ensureAuth(): Promise<void> {
  if (signedIn) return;
  assertCreds();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TC_EMAIL,
    password: TC_PASSWORD,
  });
  if (error || !data.session) {
    throw new Error(`Supabase signIn failed for ${TC_EMAIL}: ${error?.message ?? "no session"}`);
  }
  signedIn = true;
}

export async function getAccessToken(): Promise<string> {
  await ensureAuth();
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error("No active Supabase session");
  return data.session.access_token;
}
