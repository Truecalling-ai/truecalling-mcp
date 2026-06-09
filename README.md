# truecalling-mcp

MCP (Model Context Protocol) server exposing ~40 TrueCalling operations to AI assistants like Claude Code via stdio.

Pilot your TrueCalling tenant (candidates, JDs, scoring, enrichment, Emily, WhatsApp, psy tests, reports…) directly from Claude Code with natural-language prompts.

## What you get (40 tools)

| Domain | Tools |
|---|---|
| Candidates | `list_candidates`, `get_candidate`, `update_candidate`, `update_candidate_status`, `delete_candidate`, `score_candidate`, `enrich_candidate`, `extract_cv`, `parse_cv_file`, `lookup_linkedin_profile` |
| Job Descriptions | `list_jds`, `get_jd`, `create_jd`, `update_jd`, `parse_job_text`, `expand_job_title` |
| Search | `fullenrich_search`, `fullenrich_enrich_linkedin`, `fullenrich_poll`, `search_candidates_pdl` |
| Emily / WhatsApp | `emily_chat`, `emily_analyze`, `emily_score_screening`, `send_whatsapp`, `list_whatsapp_messages`, `list_wa_contacts` |
| Psy | `create_psy_assignment`, `list_psy_items`, `get_psy_submission`, `psy_score` |
| Reports | `generate_candidate_pdf`, `generate_cv`, `send_candidate_report` |
| Enterprises | `get_my_enterprise`, `list_team_members`, `get_enterprise_config` |
| Batch | `sweep_enrich_candidates`, `recalculate_scores`, `compare_jd_candidate`, `match_internal_jds` |

All tools authenticate as a real TrueCalling user (`signInWithPassword` at first tool call) → **RLS applies**. You only see what your account is allowed to see.

## Prerequisites

- **Node.js 20+**
- A TrueCalling account (email + password)
- Claude Code installed locally

## Installation

```bash
# 1. Clone
git clone https://github.com/CohenYarone01/truecalling-mcp.git
cd truecalling-mcp

# 2. Install + build
npm install
npm run build

# 3. Create your .env (gitignored — never commit it)
cp .env.example .env
# then edit .env and fill TC_PASSWORD
```

Required env vars in `.env`:

```env
SUPABASE_URL=https://gxnriabesrpbgpireubf.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOi...   # (provided in .env.example)
TC_EMAIL=your-email@example.com
TC_PASSWORD=your-password
TC_MCP_READONLY=false              # set "true" to disable all writes
```

## Wire to Claude Code

Edit `~/.claude.json` and add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "truecalling": {
      "type": "stdio",
      "command": "node",
      "args": [
        "--env-file=/ABSOLUTE/PATH/TO/truecalling-mcp/.env",
        "/ABSOLUTE/PATH/TO/truecalling-mcp/dist/index.js"
      ]
    }
  }
}
```

Replace `/ABSOLUTE/PATH/TO/` with the real path on your machine (use `pwd` inside the cloned folder).

**Restart Claude Code.** Tools then appear as `mcp__truecalling__<name>` (e.g. `mcp__truecalling__list_candidates`).

## Try it

In Claude Code:
- *"List my 5 most recent candidates"* → calls `list_candidates`
- *"Score candidate `<uuid>`"* → calls `score_candidate`
- *"Show open JDs"* → calls `list_jds({is_active: true})`

## Local testing (without Claude Code)

```bash
# Interactive UI with all 40 tools
npm run inspect
# → opens http://localhost:5173 (MCP Inspector)
```

## Safety

- `TC_MCP_READONLY=true` disables every write/destructive tool.
- Destructive tools (`send_whatsapp`, `delete_candidate`, `send_candidate_report`) have `destructiveHint: true` → Claude Code asks confirmation.
- The MCP hits the **same Supabase + edge functions** as the React TrueCalling app. Every write is immediately visible in the UI. There is no shadow store.

## Architecture

```
src/
├── index.ts            # MCP server entry (stdio)
├── config.ts           # env validation
├── supabase.ts         # client + lazy signInWithPassword
├── edge.ts             # invokeEdge(name, body) helper
├── util.ts             # ok/err/guardWrite helpers
└── tools/
    ├── candidates.ts   # 10
    ├── jobs.ts         #  6
    ├── search.ts       #  4
    ├── emily.ts        #  6
    ├── psy.ts          #  4
    ├── reports.ts      #  3
    ├── enterprises.ts  #  3
    └── batch.ts        #  4
```

Each tool is registered via `server.registerTool(name, { description, inputSchema, annotations }, handler)`. Edge functions are invoked exactly the same way as the React app's `services/fullenrichService.ts` does: `POST /functions/v1/<name>` with `Authorization: Bearer <user_jwt>`.

## Adding a tool

1. Pick the right file under `src/tools/`.
2. Add a `server.registerTool(...)` call following the existing pattern.
3. `npm run build`.
4. Restart Claude Code.

## License

MIT
