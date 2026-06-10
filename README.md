# truecalling-mcp

MCP (Model Context Protocol) server exposing ~40 TrueCalling operations to AI assistants like Claude Code via stdio.

Pilot your TrueCalling tenant (candidates, JDs, scoring, enrichment, Emily, WhatsApp, psy tests, reports…) directly from Claude Code with natural-language prompts.

## What you get (43 tools)

| Domain | Tools |
|---|---|
| Auth | `tc_login`, `tc_logout`, `tc_auth_status` |
| Candidates | `list_candidates`, `get_candidate`, `update_candidate`, `update_candidate_status`, `delete_candidate`, `score_candidate`, `enrich_candidate`, `extract_cv`, `parse_cv_file`, `lookup_linkedin_profile` |
| Job Descriptions | `list_jds`, `get_jd`, `create_jd`, `update_jd`, `parse_job_text`, `expand_job_title` |
| Search | `fullenrich_search`, `fullenrich_enrich_linkedin`, `fullenrich_poll`, `search_candidates_pdl` |
| Emily / WhatsApp | `emily_chat`, `emily_analyze`, `emily_score_screening`, `send_whatsapp`, `list_whatsapp_messages`, `list_wa_contacts` |
| Psy | `create_psy_assignment`, `list_psy_items`, `get_psy_submission`, `psy_score` |
| Reports | `generate_candidate_pdf`, `generate_cv`, `send_candidate_report` |
| Enterprises | `get_my_enterprise`, `list_team_members`, `get_enterprise_config` |
| Batch | `sweep_enrich_candidates`, `recalculate_scores`, `compare_jd_candidate`, `match_internal_jds` |

All tools authenticate as a real TrueCalling user → **RLS applies**. You only see what your account is allowed to see.

## Prerequisites

- **Node.js 20+**
- A TrueCalling account (email + password)
- Claude Code installed locally

## Installation — one line (recommended)

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Truecalling-ai/truecalling-mcp/main/install.sh | bash
```

### Windows (PowerShell)

```powershell
iwr -useb https://raw.githubusercontent.com/Truecalling-ai/truecalling-mcp/main/install.ps1 | iex
```

That's it. The installer:
- Checks you have Node.js 20+ installed (if not, links you to nodejs.org).
- Backs up `~/.claude.json` (timestamped) before touching it.
- Safely merges the `truecalling` entry into `mcpServers` — other entries are preserved.
- Idempotent: re-run any time, no duplicates.

After it finishes, **reload Claude Code** (`Cmd/Ctrl+Shift+P` → "Developer: Reload Window") and you're done. Tools appear as `mcp__truecalling__<name>`.

**No `.env` editing needed.** Supabase URL + anon key ship as defaults. Credentials are collected interactively by Claude on first use — see "First use — sign in" below.

### What gets added to `~/.claude.json`

The installer clones the server to `~/.truecalling-mcp` (Windows: `%LOCALAPPDATA%\truecalling-mcp\repo`) and points Claude Code at the launcher `run.mjs`, using an absolute path to `node` (VS Code spawns MCP children with a minimal `PATH`):

```json
{
  "mcpServers": {
    "truecalling": {
      "type": "stdio",
      "command": "/abs/path/to/node",
      "args": ["/Users/you/.truecalling-mcp/run.mjs"],
      "env": { "PATH": "/abs/path/to/node/dir:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" }
    }
  }
}
```

On every launch `run.mjs` does two things: `git pull --ff-only` its own clone (so you **auto-update on reload**), then run the committed **self-contained bundle** `dist/index.js`. That bundle inlines every dependency, so there is **no `npm install` on your machine** — which kills both the old npx cache staleness *and* the corporate-TLS-proxy failures that broke `npm`/esbuild downloads. First launch is instant (the clone already contains the prebuilt bundle).

To pin the current version (skip the auto-pull), add `"TC_MCP_NO_UPDATE": "1"` to the entry's `env`.

## Alternative — local clone (for development)

If you want to hack on the server itself:

```bash
git clone https://github.com/Truecalling-ai/truecalling-mcp.git
cd truecalling-mcp
npm install   # auto-runs prepare → builds dist/
```

Then point `~/.claude.json` at your local checkout:

```json
{
  "mcpServers": {
    "truecalling-local": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/truecalling-mcp/dist/index.js"]
    }
  }
}
```

## Troubleshooting

### `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / server shows "Failed to connect" behind a corporate network

If the server registers but shows **Failed to connect** with no output, your network has a **TLS-inspecting proxy / antivirus** presenting a corporate root CA that Node doesn't trust via its bundled CA list. The server's HTTPS calls to Supabase then fail.

> Note: the self-contained bundle means there's **no `npm install`** anymore, so the old esbuild/tsup download failure is gone. What remains is (a) the **runtime** HTTPS to Supabase and (b) the **`git clone`/`pull`** through the proxy.

**(a) Runtime — Node ≥ 20.12 / 22 / 24:** tell Node to trust the OS certificate store with `--use-system-ca`. Add it to the `truecalling` entry's `env` in `~/.claude.json`:

```jsonc
"env": { "NODE_OPTIONS": "--use-system-ca", "PATH": "…" }
```

**(b) git through the proxy:** point git at the corporate CA bundle so clone/pull succeed:

```bash
git config --global http.sslCAInfo /path/to/corporate-root-ca.pem
# (last resort, less safe) git config --global http.sslVerify false
```

Then re-run the installer (it'll clone with your git settings) and reload Claude Code.

### Stale version after an update

The launcher auto-updates on each reload (`git pull` in `~/.truecalling-mcp`). If you're still on an old build, the pull is failing silently — run it by hand to see why (network/proxy, or local edits blocking a fast-forward):

```bash
git -C ~/.truecalling-mcp pull --ff-only                         # macOS / Linux
git -C "$env:LOCALAPPDATA\truecalling-mcp\repo" pull --ff-only   # Windows (PowerShell)
```

Then reload Claude Code. (Older installs used `npx github:…`, which cached the commit — if your `~/.claude.json` entry still points at `npx`, re-run the installer to switch to the auto-updating launcher.)

## First use — sign in

The very first time you ask Claude to do anything with TrueCalling, the tool will return a `Not signed in` error. Claude will then ask you for your email and password in chat, and call `tc_login` with them. Your session is cached on disk and auto-refreshed thereafter — you should not need to sign in again unless you `tc_logout` or your refresh token is revoked server-side.

You can also trigger this manually:
> *"Log me in to TrueCalling — my email is foo@bar.com and my password is hunter2"*

After that, just ask:
- *"List my 5 most recent candidates"* → calls `list_candidates`
- *"Score candidate `<uuid>`"* → calls `score_candidate`
- *"Show open JDs"* → calls `list_jds({is_active: true})`

## Session storage

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/truecalling-mcp/session.json` |
| Linux | `$XDG_STATE_HOME/truecalling-mcp/session.json` (fallback `~/.local/state/truecalling-mcp/session.json`) |
| Windows | `%LOCALAPPDATA%\truecalling-mcp\session.json` |

The file is written atomically with mode `0600` in a `0700` directory (POSIX). Only the access + refresh tokens are stored — never the password.

To switch accounts: ask Claude to call `tc_logout`, which deletes the session file. Then sign in as a different user via `tc_login`.

To check who you're signed in as: ask Claude for *"my TrueCalling auth status"* → calls `tc_auth_status`.

## Security notes

- Your password is sent through the Claude chat transcript on first sign-in (and any subsequent re-login). Only the rotating refresh token + short-lived access token are persisted to disk.
- The session file is mode `0600` (POSIX) — readable only by your user. Tokens are stored as **plaintext JSON**, not encrypted. Anything that backs up your home directory (Time Machine, iCloud Drive, `tar` of `~`) will copy them too.
- Refresh token auto-rotates on every renewal; the rotated token is persisted automatically with `fdatasync` before publishing the rename.
- After 5 failed `tc_login` attempts in a row, the tool refuses further attempts for 60 seconds.

### Running Claude Code + MCP Inspector at the same time

Both processes share the same `session.json`. Supabase refresh tokens are **single-use**: when one process auto-refreshes, the old token in the other's memory is invalidated server-side. If both are open simultaneously, you'll occasionally see one of them prompt for re-login. Workarounds: close one before using the other, or point Inspector at a different `XDG_STATE_HOME` to give it its own session file.

## Local testing (without Claude Code)

```bash
# Interactive UI
npm run inspect
# → opens http://localhost:5173 (MCP Inspector)
# In the inspector, call `tc_login` first to sign in.
```

## Safety

- `TC_MCP_READONLY=true` disables every write/destructive tool.
- Destructive tools (`send_whatsapp`, `delete_candidate`, `send_candidate_report`) have `destructiveHint: true` → Claude Code asks confirmation.
- The MCP hits the **same Supabase + edge functions** as the React TrueCalling app. Every write is immediately visible in the UI. There is no shadow store.

## Architecture

```
src/
├── index.ts            # MCP server entry (stdio)
├── config.ts           # Supabase URL/anon key (defaults baked in)
├── supabase.ts         # client, session persistence, ensureAuth/signIn/signOut
├── session-path.ts     # cross-platform session.json path
├── session-file.ts     # atomic read/write of session.json (mode 0600)
├── edge.ts             # invokeEdge(name, body) helper
├── util.ts             # ok/err/guardWrite + authedRegisterTool (auto withAuth wrapper)
└── tools/
    ├── auth.ts         #  3  (tc_login, tc_logout, tc_auth_status)
    ├── candidates.ts   # 10
    ├── jobs.ts         #  6
    ├── search.ts       #  4
    ├── emily.ts        #  6
    ├── psy.ts          #  4
    ├── reports.ts      #  3
    ├── enterprises.ts  #  3
    └── batch.ts        #  4
```

Each tool is registered via `authedRegisterTool(server)(name, { description, inputSchema, annotations }, handler)`, which transparently wraps the handler with `ensureAuth()` + a `NotSignedInError`-to-user-message converter. Edge functions are invoked exactly the same way as the React app's `services/fullenrichService.ts` does: `POST /functions/v1/<name>` with `Authorization: Bearer <user_jwt>`.

## Adding a tool

1. Pick the right file under `src/tools/`.
2. Add a `registerTool(...)` call following the existing pattern (uses the `authedRegisterTool` wrapper at top of the function).
3. `npm run build`.
4. Restart Claude Code.

## License

MIT
