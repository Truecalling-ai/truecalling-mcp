#!/usr/bin/env node
// Generates a personal MCP API key and prints the SQL to register it —
// onboarding path while the self-service UI doesn't exist yet in the app.
//
// Usage: node scripts/generate-key.mjs <user-email> ["Key name"]
//
// The key is shown ONCE here and never stored anywhere by this script.
// Run the printed SQL in the Supabase SQL Editor (it hashes nothing — the
// hash is precomputed below; the DB never sees the cleartext key).
import { randomBytes, createHash } from "node:crypto";

const email = process.argv[2];
const name = process.argv[3] ?? "Copilot Studio";
if (!email) {
  console.error("Usage: node scripts/generate-key.mjs <user-email> [\"Key name\"]");
  process.exit(1);
}

const key = `tcmcp_${randomBytes(32).toString("hex")}`;
const hash = createHash("sha256").update(key).digest("hex");
const prefix = `${key.slice(0, 12)}…`;

console.log(`\n🔑 Clé API personnelle (à transmettre à l'utilisateur, affichée UNE SEULE FOIS) :\n`);
console.log(`   ${key}\n`);
console.log(`SQL à exécuter dans le SQL Editor Supabase :\n`);
console.log(
  `insert into api.mcp_api_keys (user_id, key_hash, key_prefix, name)
select id, '${hash}', '${prefix}', ${JSON.stringify(name)}
from auth.users where email = ${JSON.stringify(email)};\n`,
);
console.log(`Révocation : update api.mcp_api_keys set revoked_at = now() where key_prefix = '${prefix}';\n`);
