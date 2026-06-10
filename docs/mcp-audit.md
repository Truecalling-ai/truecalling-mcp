# TrueCalling MCP — Audit

_Audit date: 2026-06-10 · server `truecalling-mcp` @ `3b89986`_

> **Scope correction up front.** The MCP is a **standalone repo** (`truecalling-mcp`), not code inside `truecalling-app`. The "edge functions" live in `truecalling-app/supabase/functions/` and are **never modified from here** — the MCP only *calls* them (or the Supabase `api` schema) with the signed-in user's JWT. So "productionize the 40 functions" in practice means: **map app edge functions → MCP tools, expose the worthwhile gaps, and harden/optimize the existing tools.** `truecalling-app` is treated as read-only.

---

## 1. What exists today

**Stack:** Node 20 + TypeScript, official `@modelcontextprotocol/sdk` over **stdio**, `zod` schemas, `@supabase/supabase-js` (forced to the `api` schema). Built with `tsup` into a **single self-contained bundle** (`dist/index.js`, deps inlined) that is committed and run by a `git pull` launcher (`run.mjs`) — see [§8](#8-distribution).

**Repo layout**
```
src/
├── index.ts          # MCP server entry (stdio)
├── config.ts         # Supabase URL + public anon key (baked-in, by design)
├── supabase.ts       # client (db.schema="api"), session persistence, ensureAuth
├── session-path.ts   # cross-platform session.json path
├── session-file.ts   # atomic 0600 read/write
├── edge.ts           # invokeEdge() + transient-retry (429/5xx)
├── util.ts           # ok/err, guardWrite, sanitizeWritable, authedRegisterTool
└── tools/            # 45 tools, grouped by domain
    auth(3) candidates(11) jobs(6) search(5) emily(6) psy(4) reports(3) enterprises(3) batch(4)
run.mjs               # launcher: git pull → run bundle
install.sh / .ps1     # clone + wire ~/.claude.json
tsup.config.ts        # noExternal bundle
```

**Auth model:** every tool is wrapped by `authedRegisterTool` → `withAuth` → `ensureAuth` before any query. All calls carry the **user JWT** + public anon key. **RLS in the `api` schema is the only server-side authorization boundary** — there is no service-role key in the MCP (correct, but it means RLS correctness *is* the security perimeter; see [§6](#6-risks)).

**45 tools** (README says 44 — it omits `search_jd_candidates` from the Search row; fix the count):

| Domain | Tools |
|---|---|
| Auth (3) | tc_login, tc_logout, tc_auth_status |
| Candidates (11) | list_candidates, get_candidate, **create_candidate**, update_candidate, update_candidate_status, delete_candidate, score_candidate, enrich_candidate, extract_cv, parse_cv_file, lookup_linkedin_profile |
| Jobs (6) | list_jds, get_jd, create_jd, update_jd, parse_job_text, expand_job_title |
| Search (5) | search_jd_candidates, fullenrich_search, fullenrich_enrich_linkedin, fullenrich_poll, search_candidates_pdl |
| Emily (6) | emily_chat, emily_analyze, emily_score_screening, send_whatsapp, list_whatsapp_messages, list_wa_contacts |
| Psy (4) | create_psy_assignment, list_psy_items, get_psy_submission, psy_score |
| Reports (3) | generate_candidate_pdf, generate_cv, send_candidate_report |
| Enterprises (3) | get_my_enterprise, list_team_members, get_enterprise_config |
| Batch (4) | sweep_enrich_candidates, recalculate_scores, compare_jd_candidate, match_internal_jds |

---

## 2. Edge-function coverage (the "40 functions" reality)

`truecalling-app/supabase/functions/` holds **117 edge functions**. The MCP reaches **21** of them; the other **96** are uncovered — but **~70 are infra-only** and *should not* be MCP tools (webhooks, Twilio/email inbound, crons, sweeps, OAuth callbacks, admin/provisioning, `test-*`). So the real "missing agent actions" set is **~25**, of which the top 10 are listed in [§7](#7-gaps).

- **Covered (21):** score-candidate, fullenrich-proxy, extract-cv, parse-cv-file, lookup-linkedin-profile, sweep-enrich-candidates, recalculate-scores, compare-jd-candidate, match-internal-jds, parse-job-text, expand-job-title, extract-search-params, emily-chat, emily-analyze, emily-score-screening, send-whatsapp, psy-score, generate-candidate-pdf, generate-cv, send-candidate-report, search-candidates-pdl.
- **Dangling tools (MCP tool calling a non-existent edge fn):** **none** — all 21 invoked functions exist.

Cross-referenced with `FEATURES_PAGE_for_mcp.md`, the user-facing areas with **zero** MCP coverage are: **interview workflow** (questions + slot scheduling), **recruiter sourcing / job search** (search-jobs, find/enrich-recruiter), and **outreach writer** (generate-writer).

---

## 3. What's broken

- **Nothing currently broken in the shipped tools.** Build is clean (`tsc --noEmit` passes, `tsup` succeeds), and the bundle self-test (run with no `node_modules`) responds to `initialize` and lists tools.
- **Historic bugs already fixed this cycle:** `api` schema gotcha (was hitting `public`), multi-enterprise `get_my_enterprise`, `enrich_candidate` hitting the service-role sweep cron (401), token-overflow on `fullenrich_search`, Windows `chmod`, JD text bulletizing.
- **Minor doc drift:** README "44 tools" should read **45**; the Search row is missing `search_jd_candidates`.

---

## 4. What's slow / heavy

| Area | Issue | Note |
|---|---|---|
| `search_jd_candidates` | up to `max_pages`=50 × 100 profiles, then up to `ai_score_top`=**5000** `score-candidate` (OpenAI) calls at concurrency 12 | biggest latency + cost path; ceiling is high. Lower max `ai_score_top` to ~500. |
| `enrich_candidate` | polls FullEnrich up to `wait_seconds`=180 | bounded, but can hold a call 3 min. |
| Large payloads | `fullenrich_poll` / `enrich_candidate` / `get_candidate` returned raw PII blobs by default | **fixed** this cycle (now compact / opt-in) — see [§5](#5-security-fixes-applied). |
| Startup | self-contained bundle, no `npm install` at launch | fast; the only startup cost is the launcher's `git pull` (≤12 s, skippable via `TC_MCP_NO_UPDATE=1`). |
| Defaults/limits | `list_*` default 50 / max 200; search bounded | reasonable. Could add a `concise`/`detail` switch on list tools (TODO). |

---

## 5. Security fixes applied this cycle

Committed in `3b89986` (and the preceding hardening commits). All verified line-by-line:

1. **`fullenrich_enrich_linkedin`** now honors `TC_MCP_READONLY` (`guardWrite`) — it was the only billable/mutating tool bypassing the kill-switch.
2. **PII minimization into the transcript:** `fullenrich_poll` raw payload is opt-in (`raw:false` default); `enrich_candidate` no longer echoes the raw FullEnrich blob (kept only for the DB column); `get_candidate` omits `fullenrich_contact` unless `include_raw_contact:true`.
3. **Mass-assignment defense-in-depth:** `sanitizeWritable()` strips prototype-pollution keys + server-owned `id`/timestamps from every free-form `patch`/`payload`/`extra`; in update mode it also strips `enterprise_id`/`linkedin_norm` so a caller can't re-home a row cross-tenant or poison the dedupe key. Applied to `update_candidate`, `create_candidate(extra)`, `create_jd`, `update_jd`.
4. **Transient resilience:** `invokeEdge` retries 429/5xx with backoff.

**Confirmed safe (no action):** baked anon key is the public `role:anon` JWT (no service-role anywhere); passwords never logged/persisted; session file `0600` in `0700`, atomic; stdio discipline clean (all logs → stderr); PostgREST values parameterized, `.or()` sanitized; prototype-pollution-via-spread not exploitable.

---

## 6. Risks (need owner action — cannot be fixed from MCP code)

1. **RLS is the whole ballgame.** Every cross-tenant guarantee depends on `api.*` tables having RLS enabled + `WITH CHECK (enterprise_id = …)` on INSERT/UPDATE, and edge functions re-checking caller claims (not trusting body `enterprise_id`). **Run the Supabase security advisor on the prod project** before beta — the MCP-connected account here lacks org privileges, so the CTO must run it (Dashboard → Advisors → Security, or `supabase` CLI). This validates findings around `update_*`/`create_*`/`create_psy_assignment`.
2. **Auto-update = supply-chain RCE surface.** `run.mjs` pulls `main` and runs the committed bundle with no signature/pin. **Enable branch protection on `Truecalling-ai/truecalling-mcp` (required PR review, no force-push, org 2FA) before beta.** Harden the launcher pull (`-c core.hooksPath=/dev/null -c core.fsmonitor=false`, absolute `git`). Longer term: signed release tags + `git verify-tag`.
3. **`create_psy_assignment`** inserts from `candidate_id` with no ownership check — relies entirely on RLS on `psy_assignments`. Verify.
4. **README advised `git config --global http.sslVerify false`** as a last resort — disables TLS for *all* the user's git. Should be removed/scoped (TODO §9).

---

## 7. Gaps — top MCP-worthy edge functions to expose next

Prioritized (each is a real agent action, not infra). Cross-referenced to the FEATURES doc.

1. **generate-interview-questions** — tailored questions from score + JD (FEATURES §9 Interview Prep).
2. **analyze-cv-standalone** — score a raw CV with no candidate record yet.
3. **generate-score-explanation** — plain-language "why this score" (pairs with `score_candidate`).
4. **interpret-psychometric** — deep psychometric interpretation (complements `psy_score`).
5. **search-jobs** — multi-source job search (FEATURES §13/§15 Outplacement/Google Jobs).
6. **find-recruiter** + **enrich-recruiter** — locate + enrich a JD's recruiter (sourcing/outreach).
7. **generate-writer** — draft cold/follow-up outreach email.
8. **analyze-behavioral** — grade free-text behavioral answers.
9. **generate-traits** — derive JD competency/motivation traits.
10. **translate-text** — 12-language helper, cheap and broadly useful.

Runners-up: suggest-job-titles, competency-description, list-available-slots + approve-interview-slot (interview scheduling), enterprises-search.

---

## 8. Distribution

Switched off `npx github:` (cache staleness + corporate-TLS-on-npm) to: **committed self-contained bundle + `git pull` launcher**. Clients need only git + Node 20 — no `npm install`. `install.sh`/`install.ps1` clone to `~/.truecalling-mcp` and point `~/.claude.json` at `node run.mjs`. **Release flow gotcha:** edit `src` → `npm run build` → commit `src` + `dist/index.js` → push, or clients run stale code.

---

## 9. Files changed this session (in `truecalling-mcp` only — app untouched)

- `src/util.ts` — `sanitizeWritable()`.
- `src/tools/search.ts` — guardWrite on enrich, raw opt-in on poll, drop raw on enrich start.
- `src/tools/candidates.ts` — sanitize patch/extra, strip raw contact, `get_candidate` opt-in raw, (earlier) `create_candidate`, `enrich_candidate` rewire.
- `src/tools/jobs.ts` — sanitize create/update, language guidance.
- `src/edge.ts` — transient retry.
- `tsup.config.ts`, `run.mjs`, `install.sh`, `install.ps1`, `.gitignore`, `package.json`, `README.md` — distribution model.
- `docs/mcp-audit.md` — this file.

---

## 10. Still needs manual config / decisions

- [ ] **Run Supabase security advisor** on prod (CTO's account) — RLS go/no-go.
- [ ] **Branch protection + org 2FA** on the MCP repo (auto-update RCE).
- [ ] Harden launcher git pull; consider signed release tags.
- [ ] Remove global `sslVerify false` from README; fix tool count 44→45.
- [ ] Decide which of the §7 gaps to build (recommend: 1–4 first — pure analysis tools, low risk, high recruiter value).
- [ ] Optional: `concise`/`detail` switch + lower `ai_score_top` ceiling.

## 11. Deliberately NOT touched

- **`truecalling-app`** (entire repo) — read-only by rule. No edge function, schema, or app file modified.
- Working tools' behavior/contracts — only additive (new flags default to old behavior) or strictly-internal hardening.
