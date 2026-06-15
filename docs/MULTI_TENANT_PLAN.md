# Plan technique — TrueCalling MCP multi-tenant (Copilot Studio + ChatGPT)

> Statut : **PLAN — rien n'est implémenté ni commité.**
> Révision 2 : intègre (a) l'idée « clé API par utilisateur en self-service
> depuis la plateforme » et (b) les findings de la revue adversariale du plan
> initial. L'ancien modèle « clés par entreprise en variable d'environnement »
> est conservé en annexe comme variante dégradée.

---

## 0. Les trois modèles possibles, comparés

| | **A. Clés par entreprise (env var)** — plan initial | **B. Clés par UTILISATEUR, self-service (DB)** — RECOMMANDÉ | **C. OAuth par utilisateur (Supabase OAuth 2.1)** |
|---|---|---|---|
| Granularité d'isolation | Entreprise (1 clé = 1 compte partagé) | **Utilisateur individuel** | Utilisateur individuel |
| Qui crée/révoque les clés | Vous, à la main, dans Azure (+ restart) | **L'utilisateur, dans l'app** (effet immédiat) | n/a (sign-in) |
| Sessions côté serveur MCP | Oui (1 par tenant — fragile) | **Non — stateless** (JWT émis par requête) | Non — stateless |
| Copilot Studio | ✅ API key (clé partagée par entreprise) | ✅ API key (chaque utilisateur colle SA clé dans sa connexion) | ✅ OAuth « Dynamic discovery » |
| ChatGPT | ⚠️ clé dans l'URL uniquement | ⚠️ clé dans l'URL uniquement | ✅ natif (DCR) |
| Claude (stdio local) | inchangé | inchangé (+ option : distant avec sa clé) | inchangé |
| Scale-out Azure (2+ instances) | 🔴 casse (sessions/refresh en mémoire+disque) | 🟢 OK (état en DB) | 🟢 OK |
| Effort | ~3–5 j (MCP seul) | **~1–1,5 sem** (MCP + table + UI app) | ~1,5–3 sem (+ beta Supabase) |

**Décision recommandée : modèle B maintenant, modèle C plus tard si ChatGPT
grand public devient prioritaire.** B donne l'isolation par individu sans
OAuth, supprime toute gestion de session côté serveur, et le self-service
supprime le provisionnement manuel. C réutilisera la même plomberie
(contexte par requête, validation par Bearer).

---

## 1. État des lieux — ce que le code fait aujourd'hui

### Les 3 chokepoints (vérifiés dans le code)

1. **`ensureAuth()`** (`src/supabase.ts:109`) — appelé par `withAuth()`
   (`src/util.ts:73`) qui enrobe **tous** les handlers via
   `authedRegisterTool()`.
2. **`getAccessToken()`** (`src/supabase.ts:191`) — appelé par `invokeEdge()`
   (`src/edge.ts:12`), canal de **44 appels** edge dans 8 fichiers d'outils.
   Le jeton part en `Authorization: Bearer` vers les edge functions.
3. **Le client `supabase` global** (`src/supabase.ts:7`) — singleton avec état
   d'auth, importé par 8 fichiers d'outils (~19 usages : requêtes PostgREST
   `from(...)` dans `candidates.ts`, `jobs.ts`, `enterprises.ts`, `psy.ts`,
   et quelques `supabase.auth.*` — le rename mécanique doit couvrir LES DEUX,
   y compris `search.ts:12` qui dérive un chemin de cache de `SESSION_FILE`).

État mono-tenant actuel : un `authPromise` global, un fichier de session
unique, lockout `tc_login` au niveau module, `writeQueue` global.

### Fait clé : l'isolation des données est déjà dans le backend

Toutes les requêtes partent en PostgREST (schéma `api`) ou en edge functions
avec un Bearer ; **les RLS policies Supabase scoppent chaque requête à
l'utilisateur du jeton**. `sanitizeWritable()` (`src/util.ts`) bloque déjà le
re-homing d'`enterprise_id` en update.

➡️ **Aucun `.where("tenant_id", ...)` à ajouter dans les 51 outils.** Le
chantier = « acheminer le BON jeton par requête ». C'est tout l'objet du plan.

⚠️ **Vérification E2E obligatoire** : 2 comptes réels, confirmer que A ne voit
pas les données de B à travers le MCP (toutes familles d'outils). Une fuite =
bug RLS **backend** à corriger côté Supabase, pas côté MCP.

---

## 2. Phase 1 (modèle B) — Clés API par utilisateur, self-service

### 2.1 Vue d'ensemble du flux

```
Recruteur → app.truecalling.ai → Paramètres → « Générer ma clé MCP »
  └─ clé affichée UNE fois : tcmcp_<64 hex>   (stockée hashée en DB)

Copilot Studio / client MCP → POST https://mcp.truecalling.ai/mcp
  Header x-api-key: tcmcp_...
  └─ MCP : hash(clé) → lookup DB → user_id → émission JWT court (5 min)
     signé pour CET utilisateur → PostgREST + edge functions sous RLS
     → l'utilisateur ne voit QUE ses données. Aucune session stockée.
```

### 2.2 Côté backend TrueCalling (table + edge function) — ~1–2 jours

**Table `api.mcp_api_keys`** :

```sql
create table api.mcp_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key_hash text not null unique,          -- sha256(clé), jamais la clé
  key_prefix text not null,               -- "tcmcp_ab12…" pour l'UI
  name text,                              -- "Copilot Studio", "ChatGPT"…
  created_at timestamptz default now(),
  last_used_at timestamptz,
  revoked_at timestamptz                   -- révocation = soft, effet immédiat
);
-- RLS : un utilisateur ne voit/gère que SES clés.
```

**Edge function `mcp-key-exchange`** (la pièce de sécurité centrale) :

- Entrée : `{ key_hash }` (le MCP envoie le hash, jamais la clé).
- Vérifie : existe, non révoquée → met à jour `last_used_at`.
- Sortie : **JWT court (TTL 5 min)** signé pour `user_id` (rôle
  `authenticated`), utilisable tel quel contre PostgREST + edge functions.
- Utilise le `service_role` **uniquement à l'intérieur de cette fonction**
  (le MCP ne détient JAMAIS le service_role ni le secret JWT — finding de
  revue : ne pas faire signer les JWTs par le serveur MCP lui-même).
- Le MCP cache le JWT en mémoire ~4 min par fingerprint de clé (1 appel
  d'échange par client toutes les ~4 min, pas par requête).

### 2.3 Côté app TrueCalling (UI) — ~1–2 jours

Page Paramètres → « Intégrations » :
- Bouton « Générer une clé MCP » → modale qui affiche la clé **une seule
  fois** + bouton copier ;
- Liste des clés actives : nom, préfixe, `last_used_at`, bouton **Révoquer** ;
- Lien d'aide « Connecter Copilot Studio / ChatGPT » (doc utilisateur).

### 2.4 Côté serveur MCP — ~2–3 jours

**Nouveau `src/tenants.ts`** (~150 lignes) :
- `UserContext { userId, keyFingerprint, accessToken }` ;
- `AsyncLocalStorage<UserContext>` + `runWithUser(ctx, fn)` / `currentUser()` ;
- ⚠️ **Fail-closed (finding de revue)** : en mode HTTP, si un appel d'outil ne
  trouve PAS de contexte ALS → erreur explicite, jamais de retombée silencieuse
  sur le compte legacy. La retombée legacy n'existe qu'en mode stdio.
- Cache JWT : `Map<fingerprint, {token, exp}>` avec éviction par taille (LRU
  1 000 entrées) et par expiration — pas de croissance non bornée (finding).

**`src/supabase.ts`** :
- Les exports `ensureAuth()` / `getAccessToken()` gardent leur signature mais
  deviennent contextuels : en présence d'un `UserContext` → renvoyer/poser le
  JWT du contexte ; sinon → comportement legacy (stdio) inchangé.
  → `util.ts` et `edge.ts` : **zéro diff**.
- `export function db()` : client PostgREST construit avec
  `global.headers.Authorization = Bearer <jwt du contexte>` (client léger par
  requête, pas d'état d'auth) ; en stdio → le singleton actuel.
- Rename mécanique dans les 8 fichiers d'outils : `supabase.` → `db().`
  (~19 sites, **y compris** les usages `supabase.auth.*` à auditer un par un —
  certains n'ont pas de sens hors session et devront passer par le contexte).
- `search.ts:12` : remplacer `dirname(SESSION_FILE)` par un `stateDir()`
  explicite ; le cache de paramètres devient par-utilisateur en HTTP
  (ou simplement désactivé en HTTP — décision d'implémentation).

**`src/http.ts`** :
- `x-api-key: tcmcp_*` → sha256 → `mcp-key-exchange` (avec cache) →
  `runWithUser(...)`.
- **Coexistence des modes sur le même endpoint (finding de revue)** : ordre de
  résolution documenté — préfixe `tcmcp_` = clé utilisateur (DB) ; sinon si
  `TC_MCP_HTTP_API_KEY` est défini et que la clé correspond = mode legacy
  (compte unique actuel, pour VOTRE usage) ; un Bearer contenant des points
  (format JWS `a.b.c`) sera réservé à l'OAuth de la Phase 2. Pas de flip
  brutal : le legacy reste actif pendant la migration (finding).
- Variante ChatGPT : `POST /mcp/<clé>` (mode « no auth » côté ChatGPT). Mêmes
  lookup/throttle/révocation. Compensations (finding) : la clé n'apparaît
  jamais dans les logs serveur (le chemin est tronqué au logging), TTL court
  du JWT, révocation immédiate en DB.
- Throttling : l'anti-brute-force par IP existant est conservé ; le throttle
  par fingerprint est **abandonné** (finding : cardinalité contrôlée par
  l'attaquant, n'ajoute rien sous LB partagé).
- **Messages d'erreur HTTP assainis (finding)** : `notSignedInError()` expose
  aujourd'hui le chemin du fichier de session — en mode HTTP, message neutre
  (« invalid or revoked API key »), jamais de chemin filesystem ni de détail
  backend brut.

**`src/server.ts`** :
- `buildServer({ exposeAuthTools, allowedTools })` : en HTTP self-service,
  `tc_login`/`tc_logout`/`tc_auth_status` **ne sont pas enregistrés** (l'auth
  est portée par la clé — ces outils n'ont plus de sens) ; allowlist d'outils
  optionnelle conservée (utile pour des pilotes restreints).
- Stdio : strictement inchangé.

### 2.5 Ce qui disparaît par construction (vs plan initial)

Les findings les plus sérieux de la revue visaient les **sessions par tenant
côté serveur**. Le modèle B les supprime :
- ❌ Sessions/refresh tokens serveur → plus de rotation qui casse au scale-out
  Azure, plus de « session morte sans personne pour se reloguer » ;
- ❌ Provisionnement manuel + redémarrages pour ajouter/retirer un client ;
- ❌ Rotation de clés impossible → l'utilisateur génère une nouvelle clé et
  révoque l'ancienne, sans vous ;
- ❌ Fichiers `session-<tenant>.json` sur Azure (persistance `/home`,
  permissions POSIX sur Azure Files…) → plus aucun fichier d'état en HTTP.

### 2.6 Tests

| Test | Vérifie |
|---|---|
| clé valide → contexte du bon `user_id` | mapping DB |
| clé révoquée / inconnue → 401 neutre | révocation immédiate |
| JWT mis en cache puis rafraîchi après expiration | cache d'échange |
| appel d'outil sans contexte en HTTP → erreur (pas de fallback legacy) | fail-closed |
| clé legacy `TC_MCP_HTTP_API_KEY` → comportement actuel | rétro-compat |
| stdio sans env → identique à aujourd'hui | Claude intact |
| allowlist filtre `tools/list` | exigence allowlist |
| **E2E 2 comptes réels : A ne voit pas B** (toutes familles d'outils) | RLS backend |
| throttle IP : 10 échecs/min → 429 | anti-brute-force |

### 2.7 Config de prod

Azure (Application settings) — plus de registre de clés en env :

```bash
TC_MCP_TRANSPORT=http
TC_MCP_KEY_EXCHANGE_URL=<URL de l’edge function mcp-key-exchange>
# Optionnel, pendant la migration uniquement :
TC_MCP_HTTP_API_KEY=<clé legacy actuelle>
```

Copilot Studio (chez chaque client) : Tools → Add tool → MCP →
URL `https://mcp.truecalling.ai/mcp`, auth **API key**, header `x-api-key` —
**chaque utilisateur** colle **sa** clé dans sa carte « Connect » (les
connexions Power Platform sont par utilisateur → un agent partagé, données
par recruteur). ⚠️ Les clients ont besoin de leur licence Copilot Studio ;
votre tenant GoDaddy ne bloque que votre propre accès de création.

ChatGPT (en attendant la Phase 2) : connecteur « no auth » sur
`https://mcp.truecalling.ai/mcp/<clé personnelle>`.

### 2.8 Ordre d'implémentation (chaque étape compile + tests verts)

1. Backend : table `mcp_api_keys` + RLS + edge `mcp-key-exchange`
2. MCP : `tenants.ts` (ALS fail-closed + cache JWT) — rien branché
3. MCP : `supabase.ts` contextuel + `db()` + rename des 8 fichiers d'outils
4. MCP : `http.ts` (résolution tcmcp_/legacy, erreurs neutres, `/mcp/<clé>`)
5. MCP : `server.ts` (`exposeAuthTools:false` en HTTP self-service, allowlist)
6. Tests + README
7. App : UI « Intégrations / Clés MCP »
8. Staging → E2E 2 comptes → prod (legacy conservé, retiré plus tard)

---

## 3. Phase 2 — OAuth par utilisateur (Supabase OAuth 2.1) — si/quand ChatGPT devient prioritaire

Inchangée sur le fond (voir révision 1) ; points durcis par la revue :

- **Découverte** : `/.well-known/oauth-protected-resource` (RFC 9728) +
  401 `WWW-Authenticate`. Claim `aud` via Auth Hook (RFC 8707) — vérifier en
  live qu'il s'applique aux access tokens du serveur OAuth.
- **Validation (finding de revue)** : ne pas présumer JWKS/RS256 — les projets
  Supabase historiques signent en **HS256** (secret partagé). Vérifier l'algo
  du projet TrueCalling ; si HS256, soit migrer les clés de signature du
  projet vers asymétrique (Supabase le supporte), soit valider via l'API
  `auth.getUser()` (latence) — décision à prendre à ce moment-là.
  Prévoir la latence de révocation (TTL court + vérif périodique).
- **Coexistence** : Bearer JWS (`a.b.c`) = OAuth ; `tcmcp_*` = clé API ;
  legacy = clé unique env. Les trois cohabitent sur `/mcp` sans ambiguïté.
- Statut **beta** du serveur OAuth Supabase ; Copilot Studio attend de
  l'OAuth 2.0 (valider le wizard « Dynamic discovery » en réel) ; rotation des
  refresh tokens longue durée depuis ChatGPT/Copilot à tester.

Effort : ~1,5–3 semaines, réutilise le contexte-par-requête de la Phase 1.

---

## 4. Annexe — modèle A (clés par entreprise en env var), conservé pour mémoire

Le modèle du document initial (`TC_MCP_TENANT_KEYS` + sessions par tenant
côté serveur) reste implémentable en ~3–5 jours, mais la revue a confirmé ses
faiblesses structurelles : rotation de clés = restart global, sessions
serveur fragiles (expiration sans re-login possible, rotation de refresh
tokens cassée au scale-out Azure, fichiers d'état sur Azure Files), lockout
et état en mémoire non partagés entre instances, provisionnement manuel.
Il n'a de sens que si l'UI app (modèle B) ne peut pas être livrée — et même
dans ce cas, des clés par entreprise stockées en DB (sans UI, créées par un
script admin) seraient préférables aux env vars.

---

## 5. Décisions — VALIDÉES le 2026-06-11

1. **Go modèle B** ✅ — implémenté côté MCP (voir l'état ci-dessous).
2. Variante ChatGPT `/mcp/<clé>` : **rejetée** ❌ — ChatGPT passera par
   l'OAuth Phase 2 uniquement.
3. UI app : **plus tard dans truecalling-app** — spec livrée dans
   `docs/APP_UI_SPEC.md` ; en attendant, onboarding par
   `scripts/generate-key.mjs`.
4. Phase 2 OAuth : **préparée maintenant** — plan actionnable dans
   `docs/OAUTH_PHASE2.md`.

### État d'implémentation (Phase 1, non commité)

- ✅ MCP : `src/tenants.ts` (contexte ALS fail-closed + cache JWT),
  `supabase.ts` contextuel (`db()`, `getCurrentUserId()`), rename des 8
  fichiers d'outils, `http.ts` (résolution `tcmcp_` + legacy optionnelle,
  401 neutres), `server.ts` (`exposeAuthTools`, `allowedTools`).
- ✅ Tests : 12/12 verts (dont 6 nouveaux multi-tenant black-box).
- 📦 Backend à déployer par vous (truecalling-app intouché) :
  `docs/backend/` (migration SQL + edge function + instructions).
