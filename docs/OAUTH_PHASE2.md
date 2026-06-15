# Phase 2 — OAuth par utilisateur (Supabase OAuth 2.1) → ChatGPT natif

> **STATUT (2026-06-11) : côté serveur MCP, la Phase 2 est IMPLÉMENTÉE et
> testée** (validation des bearers via GoTrue, audience RFC 8707 stricte,
> well-known RFC 9728, challenges RFC 6750, 22/22 tests). Elle est **inactive
> par défaut** (opt-in par env vars) tant que les prérequis dashboard ne sont
> pas faits. Vérifié en live pendant la revue : le serveur OAuth du projet
> Supabase est **désactivé aujourd'hui** (`feature_disabled`) — c'est le seul
> bloqueur restant, et il est de votre côté.
>
> Objectif : chaque recruteur connecte **ChatGPT** (et, en option, Copilot
> Studio en mode OAuth) à TrueCalling en se connectant avec **son compte
> TrueCalling** — sans clé à copier. La décision « pas de clé dans l'URL »
> rend cette phase obligatoire pour ChatGPT.

## Runbook d'activation (dans l'ordre)

1. Dashboard Supabase : activer **OAuth Server** + **DCR** + **Auth Hook
   `aud`** (détails ci-dessous).
2. Vérifier qu'un token minté porte bien
   `aud = "https://mcp.truecalling.ai"`.
3. Azure → Application settings :
   ```bash
   TC_MCP_OAUTH_ENABLED=true
   TC_MCP_OAUTH_AUDIENCE=https://mcp.truecalling.ai
   ```
   (Sans ces deux variables, le serveur **rejette tout bearer** et ne sert pas
   le well-known — sécurité fail-closed : sans liaison d'audience, un simple
   jeton de session de l'app web serait rejouable contre le MCP. Le serveur
   refuse de démarrer si `ENABLED` est mis sans `AUDIENCE`.)
4. Connecter ChatGPT (Developer mode → New connector →
   `https://mcp.truecalling.ai/mcp`) et dérouler le E2E à 2 comptes.

## Pourquoi OAuth (rappel)

ChatGPT (Developer mode / connecteurs) ne supporte que **OAuth** ou « no
auth » — pas de header `x-api-key` custom. La spec MCP fait du serveur un
**resource server OAuth 2.1** : il valide un Bearer par requête et délègue le
login à un **authorization server** — pour nous, **Supabase lui-même** (son
OAuth 2.1 Server, beta 2026, réutilise les comptes TrueCalling existants).

## Pré-requis à faire par vous (dashboard Supabase)

1. **Activer l'OAuth Server** : Dashboard → Authentication → OAuth Server
   (beta — vérifier le statut/SLA au moment de l'activation).
2. **Dynamic Client Registration** : activé (ChatGPT et Copilot s'enregistrent
   seuls).
3. **Auth Hook `aud`** (exigence RFC 8707 de la spec MCP) : hook qui pose
   `aud = "https://mcp.truecalling.ai"` sur les access tokens des clients
   OAuth `mcp-*`. ⚠️ Vérifier en live que le hook s'applique bien aux tokens
   du serveur OAuth (pas seulement aux JWTs `signInWithPassword`).
4. **Algo de signature** : si le projet signe en **HS256** (legacy secret) —
   c'est le cas aujourd'hui (l'anon key est HS256) — migrer vers les clés
   asymétriques (Settings → API → JWT keys) pour que le MCP valide via JWKS
   sans détenir de secret. Sinon, fallback : validation par appel
   `auth.getUser()` (latence + dépendance réseau par requête).

## Travaux côté serveur MCP (~1–2 semaines)

La plomberie Phase 1 (contexte par requête, `db()`, fail-closed) est réutilisée
telle quelle — seule la **source** du contexte change.

1. **Découverte** (`src/http.ts`) :
   - `GET /.well-known/oauth-protected-resource` (RFC 9728) :
     `{ "resource": "https://mcp.truecalling.ai", "authorization_servers": ["https://gxnriabesrpbgpireubf.supabase.co/auth/v1"] }`
   - 401 sans token : ajouter
     `WWW-Authenticate: Bearer resource_metadata="https://mcp.truecalling.ai/.well-known/oauth-protected-resource"`.
2. **Détection du type de credential** sur `/mcp` (ordre de résolution) :
   - `tcmcp_*` → Phase 1 (clé personnelle) ;
   - Bearer au format JWS (`a.b.c`) → **OAuth Phase 2** ;
   - sinon clé legacy env.
3. **Validation OAuth** (`src/tenants.ts`, nouvelle fonction
   `resolveBearer(jwt)`) : signature via JWKS Supabase (cache + rotation des
   clés), `exp`, `aud === "https://mcp.truecalling.ai"`, extraction de `sub` →
   construit le même `UserContext` que Phase 1 (`accessToken` = le JWT reçu).
   Aucune session, aucun état.
4. **Outils** : zéro changement (le contexte est identique à la Phase 1).
5. **Tests** : JWT valide → 200 + contexte ; expiré → 401 ; mauvais `aud` →
   401 ; JWKS rotation ; tokenless → 401 + `WWW-Authenticate`.

## ⚠️ Côté app TrueCalling — PAGE DE CONSENTEMENT (découvert 2026-06-15, BLOQUANT)

Supabase OAuth Server **n'héberge PAS** d'écran de consentement : l'app DOIT
exposer une page (ex. `https://app.truecalling.ai/oauth/consent`) vers laquelle
Supabase redirige pendant `/oauth/authorize`. Sans elle, après login
l'utilisateur reste sur l'app et ChatGPT ne reçoit jamais le code (symptôme
observé en test réel : « atterri sur l'app web »).

- Référence prête à intégrer : `docs/backend/OAuthConsent.tsx` (React + supabase-js).
- La page : lit `authorization_id`, exige une session (sinon login en
  préservant `authorization_id`), `getAuthorizationDetails` → écran « Autoriser
  ChatGPT ? » → `approveAuthorization` → redirige vers le `redirect_url`
  (qui porte le code vers ChatGPT). `denyAuthorization` pour le refus.
- Config Supabase : pointer le « Authorization path » du OAuth Server sur
  l'URL de cette page.
- Route **publique** (hors guard d'auth) sinon le guard mange `authorization_id`.

## Côté clients

- **ChatGPT** : Settings → Connectors → Developer mode → New connector → URL
  `https://mcp.truecalling.ai/mcp`. ChatGPT lit le well-known, s'enregistre en
  DCR auprès de Supabase, et chaque recruteur voit l'écran de login
  TrueCalling (Supabase). PKCE S256 imposé par ChatGPT — supporté.
- **Copilot Studio** (optionnel, alternative aux clés) : MCP → OAuth 2.0 →
  « Dynamic discovery ». Chaque utilisateur a sa carte « Connect ».
  ⚠️ Copilot attend de l'OAuth **2.0** ; valider en réel que le flux Supabase
  (2.1/PKCE) passe le wizard.

## Risques connus

- **Beta** Supabase OAuth Server : SLA/pricing post-beta non garantis ; CIMD
  pas encore supporté → s'appuyer sur **DCR**.
- Rotation des **refresh tokens** longue durée depuis ChatGPT/Copilot : à
  tester en conditions réelles (sessions de plusieurs jours).
- Latence de révocation : un access token reste valide jusqu'à `exp` —
  garder des TTL courts côté Supabase.

## Definition of done

- [ ] OAuth Server activé + DCR + hook `aud` vérifié sur un token réel ← **vous**
- [x] Validation par GoTrue (zéro secret côté MCP — marche en HS256 ET après
      migration asymétrique ; JWKS local = optimisation future)
- [x] well-known RFC 9728 (+ variante `/mcp`) + WWW-Authenticate RFC 6750
      (`error="invalid_token"` sur jeton rejeté) servis par le MCP
- [x] `resolveBearer` (audience stricte, cache borné par l'`exp` du jeton) +
      garde-fou au démarrage (`ENABLED` sans `AUDIENCE` = refus) + 22/22 tests
- [x] Revue adversariale (12 agents) : 7 findings confirmés, tous corrigés ou
      documentés — dont IP réelle via X-Forwarded-For (throttle Azure),
      premier contact non compté en échec, préflight CORS
- [ ] `TC_MCP_OAUTH_ENABLED` + `TC_MCP_OAUTH_AUDIENCE` posées sur Azure ← **vous**
- [ ] Connexion ChatGPT de bout en bout avec 2 comptes → isolation vérifiée
- [ ] (option) Connexion Copilot Studio en OAuth Dynamic discovery
