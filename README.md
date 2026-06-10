# TrueCalling MCP

**Drive your TrueCalling workspace from Claude — in plain language.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![Model Context Protocol](https://img.shields.io/badge/MCP-stdio-blue)](https://modelcontextprotocol.io)
[![Tools](https://img.shields.io/badge/tools-51-blue)](#tool-catalog)

TrueCalling MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server that connects AI assistants — **Claude Code, Claude Desktop**, and any MCP-compatible client — to **TrueCalling, your AI recruiting &amp; sourcing platform**. Ask in natural language; Claude searches and scores candidates, sources profiles from LinkedIn, drafts Emily/WhatsApp outreach, runs assessments, and generates reports — all **securely scoped to your own account**.

> *"Find the top candidates for my Senior Data Engineer role, score them against the job, and draft an outreach email for the best match."* → done, end to end.

**Contents** · [Highlights](#highlights) · [Quickstart](#quickstart) · [What you can do](#what-you-can-do) · [Tool catalog](#tool-catalog) · [Security &amp; privacy](#security--privacy) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [Support](#support)

---

## Highlights

- **51 tools** across candidates, jobs, sourcing, scoring, Emily/WhatsApp, assessments, and reports.
- **Same data as the app.** Everything you do in Claude lands in your live TrueCalling workspace instantly — no separate copy of your data to keep in sync.
- **Secure by design.** You act as a real TrueCalling user; row-level security applies, so you only ever see what your account is allowed to see.
- **Zero-friction install.** A one-line installer; no `.env`, no `npm install`, no build step on your machine. Works behind corporate networks.
- **Auto-updating.** New versions ship the moment you reload — no reinstall.

---

## Quickstart

### Prerequisites

- **Node.js 20+** — the installer offers to set this up for you if it's missing.
- **git** — used to install and auto-update the server.
- A **TrueCalling account** (email + password).

### 1. Install

**macOS / Linux**
```bash
curl -fsSL https://raw.githubusercontent.com/Truecalling-ai/truecalling-mcp/main/install.sh | bash
```

**Windows (PowerShell — no admin rights needed)**
```powershell
iwr -useb https://raw.githubusercontent.com/Truecalling-ai/truecalling-mcp/main/install.ps1 | iex
```

The installer checks for Node.js, clones the server, and safely adds a `truecalling` entry to your Claude config — backing it up first and preserving any other servers. It's idempotent: re-run it any time.

### 2. Reload Claude

`Cmd/Ctrl + Shift + P` → **Developer: Reload Window**. The tools appear as `mcp__truecalling__<name>`.

### 3. Sign in

The first time you ask Claude to do something, it will ask for your TrueCalling email and password and call `tc_login`. Your session is cached locally and auto-refreshed — you won't need to sign in again. **Your password is used only to sign in; it is never written to disk or logged.**

```
You:    Log me in to TrueCalling.
Claude: Sure — what's your email and password?
        ✓ Signed in as me@company.com (Acme Recruiting)
```

No `.env` to edit — the connection settings ship with the server.

---

## What you can do

| Ask Claude… | It uses |
|---|---|
| *"List my open job descriptions"* | `list_jds` |
| *"Find the top candidates for my Responsable RH role in Monaco"* | `search_jd_candidates` |
| *"Add this LinkedIn profile to the pipeline for that role"* | `create_candidate` |
| *"Score this candidate against the job and explain why"* | `score_candidate` + `generate_score_explanation` |
| *"Find an email &amp; phone for this candidate"* | `enrich_candidate` |
| *"Draft a cold outreach email for them"* | `generate_writer` |
| *"Generate interview questions for this role"* | `generate_interview_questions` |
| *"Send them a WhatsApp follow-up"* | `send_whatsapp` |
| *"Generate a candidate PDF report"* | `generate_candidate_pdf` |

---

## Tool catalog

51 tools, grouped by domain. All authenticate as you; **RLS applies to every call.**

| Domain | Tools |
|---|---|
| **Auth** | `tc_login`, `tc_logout`, `tc_auth_status` |
| **Candidates** | `list_candidates`, `get_candidate`, `create_candidate`, `update_candidate`, `update_candidate_status`, `delete_candidate`, `score_candidate`, `enrich_candidate`, `extract_cv`, `parse_cv_file`, `lookup_linkedin_profile` |
| **Jobs** | `list_jds`, `get_jd`, `create_jd`, `update_jd`, `parse_job_text`, `expand_job_title` |
| **Sourcing &amp; search** | `search_jd_candidates`, `fullenrich_search`, `fullenrich_enrich_linkedin`, `fullenrich_poll`, `search_candidates_pdl`, `find_recruiter` |
| **Emily / WhatsApp** | `emily_chat`, `emily_analyze`, `emily_score_screening`, `send_whatsapp`, `list_whatsapp_messages`, `list_wa_contacts`, `generate_writer` *(outreach copy)* |
| **Analysis &amp; generation** | `generate_interview_questions`, `analyze_cv_standalone`, `generate_score_explanation`, `interpret_psychometric` |
| **Assessments** | `create_psy_assignment`, `list_psy_items`, `get_psy_submission`, `psy_score` |
| **Reports** | `generate_candidate_pdf`, `generate_cv`, `send_candidate_report` |
| **Enterprise** | `get_my_enterprise`, `list_team_members`, `get_enterprise_config` |
| **Batch** | `sweep_enrich_candidates`, `recalculate_scores`, `compare_jd_candidate`, `match_internal_jds` |

---

## Security &amp; privacy

Security is a first-class concern — the server is designed so an AI assistant can act on your data without overreach.

- **You are the boundary.** Every call carries your user token; TrueCalling's row-level security decides what you can read or write. The server ships only the **public** API key — there is no privileged/service key in it.
- **Tenant isolation.** You cannot see or touch another company's candidates, jobs, or assessments.
- **Read-only mode.** Set `TC_MCP_READONLY=true` to disable every create / update / delete / send / enrich tool at once (read and analysis tools stay available).
- **Destructive-action hints.** `send_whatsapp`, `delete_candidate`, and `send_candidate_report` are marked with a destructive hint so MCP clients can prompt for confirmation. (`delete_candidate` is a reversible **soft-delete**, not a permanent removal.) For a hard guarantee that nothing mutates, use read-only mode.
- **Minimal data exposure.** Search and contact tools return compact results by default; bulky personal data (full enrichment blobs) is opt-in, to keep sensitive PII out of chat transcripts.
- **Safe updates.** Partial-update tools never blindly overwrite a record — protected fields (identity, tenant, server-computed scores) are stripped from free-form input.
- **Credentials.** Your password is only sent at sign-in and is **never** written to disk. Only short-lived access + rotating refresh tokens are cached, in a `0600` file inside a `0700` directory (POSIX).

> **Good to know:** cached tokens are short-lived but not additionally encrypted at rest, so treat the session file like any other local credential — and run `tc_logout` on shared machines (anything that backs up your home directory copies it too).

**Session file location**

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/truecalling-mcp/session.json` |
| Linux | `$XDG_STATE_HOME/truecalling-mcp/session.json` (or `~/.local/state/…`) |
| Windows | `%LOCALAPPDATA%\truecalling-mcp\session.json` |

---

## Configuration

### How the install is wired

The installer clones the server to `~/.truecalling-mcp` (Windows: `%LOCALAPPDATA%\truecalling-mcp\repo`) and points Claude at the launcher `run.mjs` via an absolute Node path:

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

On each launch, `run.mjs` fast-forwards its clone (`git pull`) and runs a committed, **self-contained** bundle — every dependency is inlined, so there is **no `npm install`** on your machine. This is what makes it work behind corporate TLS proxies and removes the stale-cache problems of `npx`.

To pin the current version (skip auto-update), add `"TC_MCP_NO_UPDATE": "1"` to the entry's `env`.

### Claude Desktop

The installer wires **Claude Code**. For **Claude Desktop**, copy the same `truecalling` entry into its config and restart the app:

| OS | Config file |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

> Tip: run the installer once, then copy the ready-made `truecalling` block (with absolute paths already filled in) from `~/.claude.json` into the Desktop config.

---

## Troubleshooting

<details>
<summary><b>Behind a corporate network — "Failed to connect" / <code>UNABLE_TO_VERIFY_LEAF_SIGNATURE</code></b></summary>

A TLS-inspecting proxy or antivirus is presenting a corporate root CA that Node doesn't trust. Two things may need it:

**Runtime** (Node ≥ 20.12) — trust the OS certificate store. Add to the `truecalling` entry's `env`:
```jsonc
"env": { "NODE_OPTIONS": "--use-system-ca", "PATH": "…" }
```

**git through the proxy** — point git at the corporate CA bundle:
```bash
git config --global http.sslCAInfo /path/to/corporate-root-ca.pem
# Last resort, scoped to THIS repo only (never --global):
#   git -C ~/.truecalling-mcp config http.sslVerify false
```
Then re-run the installer and reload Claude.
</details>

<details>
<summary><b>Still on an old version after an update</b></summary>

The launcher auto-updates on each reload. If it's stuck, the `git pull` is failing silently — run it by hand to see why:
```bash
git -C ~/.truecalling-mcp pull --ff-only                         # macOS / Linux
git -C "$env:LOCALAPPDATA\truecalling-mcp\repo" pull --ff-only   # Windows
```
Then reload Claude. (If your config still points at `npx`, re-run the installer to switch to the auto-updating launcher.)
</details>

<details>
<summary><b>Switching accounts</b></summary>

Ask Claude to run `tc_logout` (deletes the cached session), then sign in as the other user. Check who you are with `tc_auth_status`.
</details>

---

## Support

Questions, bugs, or feature requests:

- **Issues:** [github.com/Truecalling-ai/truecalling-mcp/issues](https://github.com/Truecalling-ai/truecalling-mcp/issues)
- **Email:** support@truecalling.ai

---

## For developers

```bash
git clone https://github.com/Truecalling-ai/truecalling-mcp.git
cd truecalling-mcp
npm install        # developers only — builds dist/ via the prepare hook

npm run build      # bundle src → dist/index.js (deps inlined)
npm test           # smoke (server boots + tool schemas) + security tests
npm run typecheck  # tsc --noEmit
npm run dev        # run the server from TypeScript (tsx)
npm run mcp:inspect # open the MCP Inspector UI
```

**Layout**

```
src/
├── index.ts        # MCP server entry (stdio)
├── config.ts       # API URL + public key
├── supabase.ts     # client, session persistence, auth
├── session-*.ts    # cross-platform 0600 session storage
├── edge.ts         # invokeEdge() — call a backend function (+ retry)
├── util.ts         # ok/err, guardWrite, sanitizeWritable, auth wrapper
└── tools/          # 51 tools by domain: auth, candidates, jobs, search,
                    #   emily, psy, reports, enterprises, batch, analysis
run.mjs             # launcher: git pull → run the bundle
tsup.config.ts      # self-contained bundle config
test/               # node --test smoke + security tests
```

Every tool is registered through `authedRegisterTool`, which wraps the handler with an auth check and a friendly "not signed in" message. To add a tool, drop a `registerTool(...)` into the right domain file, then `npm run build`. The shipped `dist/index.js` is committed — **rebuild and commit it with your source change**, or clients won't get the update.

---

## License

[MIT](LICENSE) © TrueCalling
