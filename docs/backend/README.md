# Backend à déployer dans truecalling-app (à faire par vous, plus tard)

Le mode multi-tenant du serveur MCP a besoin de **deux pièces côté backend**
TrueCalling. Les fichiers prêts à copier sont dans ce dossier — **rien n'a été
modifié dans le repo truecalling-app**.

## 1. La table `api.mcp_api_keys`

Copier [`20260611150000_mcp_api_keys.sql`](./20260611150000_mcp_api_keys.sql)
vers `truecalling-app/supabase/migrations/`, puis :

```bash
cd truecalling-app
supabase db push
```

## 2. L'edge function `mcp-key-exchange`

Copier [`mcp-key-exchange.index.ts`](./mcp-key-exchange.index.ts) vers
`truecalling-app/supabase/functions/mcp-key-exchange/index.ts`, ajouter à
`truecalling-app/supabase/config.toml` :

```toml
[functions.mcp-key-exchange]
verify_jwt = false
```

puis configurer le secret (JWT Secret du dashboard, Settings → API) et
déployer :

```bash
supabase secrets set TC_JWT_SECRET='<JWT Secret du projet>'
supabase functions deploy mcp-key-exchange
```

## 3. Créer une clé de test (avant que l'UI existe)

```bash
node truecalling-mcp/scripts/generate-key.mjs raphael@truecalling.ai
```

Le script affiche la clé `tcmcp_…` (à garder) et le SQL `INSERT` à exécuter
dans le SQL Editor de Supabase.

## Vérifications post-déploiement

1. `curl -X POST <FUNCTIONS_URL>/mcp-key-exchange -H 'content-type: application/json' -H 'apikey: <ANON_KEY>' -d '{"api_key":"tcmcp_<clé test>"}'` → `{token, expires_in:300, user_id}`
2. Test E2E d'isolation : 2 comptes réels, vérifier que le compte A ne voit
   pas les candidats de B à travers le MCP (RLS backend).
3. Point d'attention : si une RLS policy dépend du claim `session_id` (logique
   « éjection mono-appareil »), le JWT minté n'en a pas — à vérifier.
