# Spec UI — Page « Intégrations / Clés MCP » dans truecalling-app

> À implémenter plus tard dans `truecalling-app` (Paramètres). Prérequis :
> la migration `docs/backend/20260611150000_mcp_api_keys.sql` est appliquée.
> Aucun backend supplémentaire n'est nécessaire : la table est en RLS
> « chacun gère ses clés », tout se fait depuis le client Supabase de l'app.

## Emplacement

Paramètres → nouvel onglet **« Intégrations »** (ou section dans l'onglet
existant). Visible pour tout utilisateur connecté.

## Fonction 1 — Générer une clé

1. Bouton **« Générer une clé MCP »** → modale demandant un nom
   (placeholder : « Copilot Studio », « ChatGPT », « Claude »).
2. À la validation, **côté client** :
   ```ts
   const bytes = crypto.getRandomValues(new Uint8Array(32));
   const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
   const key = `tcmcp_${hex}`;                       // la clé — jamais envoyée au serveur en stockage
   const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
   const keyHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

   await supabase.schema("api").from("mcp_api_keys").insert({
     user_id: user.id,            // RLS exige user_id = auth.uid()
     key_hash: keyHash,
     key_prefix: `${key.slice(0, 12)}…`,
     name,
   });
   ```
3. Afficher la clé **une seule fois** dans la modale : champ readonly + bouton
   **Copier** + avertissement « Cette clé ne sera plus jamais affichée.
   Traitez-la comme un mot de passe. »

## Fonction 2 — Lister / révoquer

Tableau des clés de l'utilisateur (`select` sur la table, RLS scope déjà) :

| Colonne | Source |
|---|---|
| Nom | `name` |
| Clé | `key_prefix` (jamais la clé) |
| Créée le | `created_at` |
| Dernière utilisation | `last_used_at` (« Jamais » si null) |
| Statut | `revoked_at` null → Active ; sinon Révoquée |
| Action | bouton **Révoquer** → `update … set revoked_at = now()` (confirmation requise) |

Effet d'une révocation : immédiat pour tout nouvel échange ; ≤ 5 min pour les
sessions en cours (cache JWT côté serveur MCP).

## Fonction 3 — Aide à la connexion

Sous le tableau, bloc d'aide repliable « Connecter votre assistant » :

- **Microsoft Copilot Studio** : Tools → Add a tool → New tool →
  Model Context Protocol → URL `https://mcp.truecalling.ai/mcp` →
  Authentication **API key**, header **`x-api-key`**, valeur = votre clé.
- **Claude Code** : `claude mcp add truecalling-remote --transport http https://mcp.truecalling.ai/mcp --header "x-api-key: <votre clé>"`.
- ChatGPT : disponible après la Phase 2 (OAuth) — voir `docs/OAUTH_PHASE2.md`.

## Garde-fous

- Ne jamais logguer la clé ; ne jamais l'envoyer à un endpoint qui la stocke.
- Limite raisonnable : max 10 clés actives par utilisateur (check applicatif).
- i18n FR/EN comme le reste des Paramètres.
