// mcp-key-exchange — À COPIER vers
// truecalling-app/supabase/functions/mcp-key-exchange/index.ts
// (voir README.md de ce dossier ; verify_jwt=false dans config.toml).
//
// Échange une clé API MCP personnelle (tcmcp_<64 hex>) contre un JWT
// utilisateur court (5 min).
//
// Sécurité :
// - La clé arrive en clair (HTTPS) et est hashée ICI — la table ne contient
//   que des sha256, donc une fuite de la table ne donne aucune crédential.
// - Le JWT est signé avec le secret JWT du projet (HS256, le même que GoTrue)
//   → PostgREST/RLS et les autres edge functions l'acceptent comme un vrai
//   jeton utilisateur. TTL 5 min : la révocation d'une clé prend effet en
//   ≤ 5 min côté MCP (cache) et immédiatement pour tout nouvel échange.
// - Le service_role ne sort JAMAIS d'ici ; le serveur MCP ne détient ni le
//   service_role ni le secret JWT.
//
// Secret requis (le runtime n'injecte pas le secret JWT) :
//   supabase secrets set TC_JWT_SECRET=<JWT Secret du dashboard (Settings → API)>
import { create } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { corsResponse, handleOptions } from '../_shared/cors.ts';
import { supabaseAdmin } from '../_shared/supabase-client.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const JWT_SECRET = Deno.env.get('TC_JWT_SECRET') ?? Deno.env.get('SUPABASE_JWT_SECRET') ?? '';
const TOKEN_TTL_SECONDS = 300;
const KEY_RE = /^tcmcp_[0-9a-f]{64}$/;

let hmacKeyPromise: Promise<CryptoKey> | null = null;
function hmacKey(): Promise<CryptoKey> {
  if (!hmacKeyPromise) {
    hmacKeyPromise = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
  }
  return hmacKeyPromise;
}

async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const invalidKey = () => corsResponse({ error: 'Invalid or revoked API key' }, 401);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return handleOptions();
  if (req.method !== 'POST') return corsResponse({ error: 'POST only' }, 405);
  if (!JWT_SECRET) {
    console.error('[mcp-key-exchange] TC_JWT_SECRET is not set — run: supabase secrets set TC_JWT_SECRET=...');
    return corsResponse({ error: 'Server misconfigured' }, 500);
  }

  let apiKey = '';
  try {
    apiKey = (await req.json())?.api_key ?? '';
  } catch {
    /* corps invalide → format check ci-dessous échoue */
  }
  if (typeof apiKey !== 'string' || !KEY_RE.test(apiKey)) return invalidKey();

  const keyHash = await sha256hex(apiKey);
  const { data: row, error } = await supabaseAdmin
    .schema('api')
    .from('mcp_api_keys')
    .select('id,user_id,revoked_at,allowed_tools')
    .eq('key_hash', keyHash)
    .maybeSingle();
  if (error) {
    console.error('[mcp-key-exchange] lookup failed:', error.message);
    return corsResponse({ error: 'Server error' }, 500);
  }
  if (!row || row.revoked_at) return invalidKey();

  const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.getUserById(row.user_id);
  if (userErr || !userData?.user) return invalidKey();

  // Best-effort, ne bloque pas la réponse.
  supabaseAdmin
    .schema('api')
    .from('mcp_api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', row.id)
    .then(
      () => undefined,
      (e: unknown) => console.error('[mcp-key-exchange] last_used_at update failed:', e),
    );

  const now = Math.floor(Date.now() / 1000);
  const token = await create(
    { alg: 'HS256', typ: 'JWT' },
    {
      sub: row.user_id,
      role: 'authenticated',
      aud: 'authenticated',
      email: userData.user.email ?? undefined,
      iss: `${SUPABASE_URL}/auth/v1`,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
      // Marqueur d'audit : permet de tracer/filtrer les requêtes issues d'une
      // clé MCP (et de la retrouver par id dans les logs Postgres si besoin).
      tc_mcp_key_id: row.id,
    },
    await hmacKey(),
  );

  return corsResponse({
    token,
    expires_in: TOKEN_TTL_SECONDS,
    user_id: row.user_id,
    allowed_tools: row.allowed_tools ?? null,
  });
});
