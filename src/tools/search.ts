import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { supabase } from "../supabase.js";
import { invokeEdge } from "../edge.js";
import { ok, err, authedRegisterTool } from "../util.js";

// FullEnrich v2 wants each filter as { value, exact_match, exclude }. Let callers
// pass plain strings (e.g. "Community Manager") and wrap them automatically.
const FE_FILTER_KEYS = [
  "current_position_titles",
  "past_position_titles",
  "person_locations",
  "person_skills",
  "person_seniority",
  "current_company_names",
];
function normalizeFeBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const k of FE_FILTER_KEYS) {
    const v = out[k];
    if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        typeof item === "string" ? { value: item, exact_match: false, exclude: false } : item,
      );
    }
  }
  return out;
}

// Split a JD text/array field into skill-ish tokens for the sourcing search.
function splitSkills(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v !== "string") return [];
  return v
    .split(/[\n;,•·]+/)
    .map((s) => s.replace(/^[\s\-–*]+/, "").trim())
    .filter((s) => s.length > 1 && s.length < 60);
}

export function registerSearchTools(server: McpServer): void {
  const registerTool = authedRegisterTool(server);
  registerTool(
    "fullenrich_search",
    {
      title: "Search profiles via FullEnrich",
      description:
        "Calls the `fullenrich-proxy` edge function with action='search'. " +
        "Use filters like current_position_titles, person_locations, person_skills, person_seniority, current_company_names. " +
        "Filter values may be plain strings (auto-wrapped to {value,exact_match,exclude}) or full objects. " +
        "Returns up to `limit` profiles (max 100 per page).",
      inputSchema: {
        body: z
          .record(z.unknown())
          .describe(
            "FullEnrich v2 /people/search body. Common keys: limit, offset, current_position_titles, person_locations, person_skills, person_seniority, current_company_names. Filter values can be plain strings.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ body }) => {
      const result = await invokeEdge("fullenrich-proxy", {
        action: "search",
        body: normalizeFeBody(body),
      });
      return ok(result);
    },
  );

  registerTool(
    "fullenrich_enrich_linkedin",
    {
      title: "Enrich a LinkedIn URL (emails + phones)",
      description:
        "Starts a FullEnrich enrich job for one LinkedIn URL. Returns the enrichment_id — you'll need to poll with " +
        "`fullenrich_proxy_poll` (or just wait, typical 5-15s). Costs FullEnrich credits.",
      inputSchema: { linkedin_url: z.string() },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ linkedin_url }) => {
      const start = await invokeEdge<{ result?: { enrichment_id?: string; id?: string } } | Record<string, unknown>>(
        "fullenrich-proxy",
        {
          action: "enrich_start",
          body: {
            name: "TrueCalling MCP enrichment",
            data: [
              {
                linkedin_url,
                enrich_fields: ["contact.work_emails", "contact.personal_emails", "contact.phones"],
                custom: {},
              },
            ],
          },
        },
      );
      return ok(start);
    },
  );

  registerTool(
    "fullenrich_poll",
    {
      title: "Poll a FullEnrich enrichment job",
      description:
        "Polls a FullEnrich bulk-enrich job by ID. Set force_results=true to get partial results even if not FINISHED.",
      inputSchema: {
        enrich_id: z.string().describe("Job id returned by fullenrich_enrich_linkedin"),
        force_results: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ enrich_id, force_results }) => {
      const result = await invokeEdge("fullenrich-proxy", {
        action: "enrich_poll",
        enrichId: enrich_id,
        forceResults: force_results,
      });
      return ok(result);
    },
  );

  registerTool(
    "search_candidates_pdl",
    {
      title: "Search candidates via People Data Labs",
      description:
        "Calls the `search-candidates-pdl` edge function. The edge REQUIRES `jobTitle` and " +
        "currently filters by title only — it ignores location server-side, so pass `location` to " +
        "filter the returned profiles client-side. Use `filters` to forward any extra fields verbatim.",
      inputSchema: {
        jobTitle: z.string().min(2).describe("Job title to search for (required by the edge function)"),
        location: z
          .string()
          .optional()
          .describe("Location substring used to filter results client-side (the edge ignores location)"),
        size: z.number().int().min(1).max(100).default(25),
        filters: z
          .record(z.unknown())
          .optional()
          .describe("Extra fields forwarded verbatim to the edge function (e.g. seniority, skills)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ jobTitle, location, size, filters }) => {
      const result = (await invokeEdge("search-candidates-pdl", {
        jobTitle,
        size,
        ...(filters ?? {}),
      })) as any;
      if (!location) return ok(result);
      // The edge ignores location, so filter the returned profiles here.
      const profiles: any[] | undefined = Array.isArray(result)
        ? result
        : result?.candidates ?? result?.data ?? result?.results ?? result?.profiles;
      if (!Array.isArray(profiles)) return ok(result);
      const needle = location.toLowerCase();
      const matched = profiles.filter((c) => {
        const hay = [c?.location_name, c?.location_country, c?.job_company_location_name, c?.location]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(needle);
      });
      return ok({ count: matched.length, filtered_by_location: location, candidates: matched });
    },
  );

  registerTool(
    "search_jd_candidates",
    {
      title: "Source candidates for a JD (real FullEnrich pipeline)",
      description:
        "Runs the SAME sourcing pipeline as the app — the `jd-search-background` edge function — for a job " +
        "description: it expands the title (LLM), searches FullEnrich, scores each profile against the JD, and " +
        "caches the results in jd_search_cache. Looks the JD up by id for enterprise_id / job_title / skills, kicks " +
        "off the background search, then polls for up to `wait_seconds`. If it is still running, call " +
        "get_jd_search_results(jd_id) to fetch the rest.",
      inputSchema: {
        jd_id: z.string().uuid(),
        location: z
          .string()
          .optional()
          .describe("Location filter for FullEnrich (defaults to the JD's location). E.g. 'France', 'Paris'."),
        language: z.string().optional().describe("BCP-47 language for title expansion (default 'fr')"),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(120)
          .default(45)
          .describe("How long to poll jd_search_cache for results before returning"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ jd_id, location, language, wait_seconds }) => {
      const { data: jd, error: jdErr } = await supabase
        .from("job_descriptions")
        .select("id,enterprise_id,job_title,location,requirements,qualifications,soft_skills")
        .eq("id", jd_id)
        .maybeSingle();
      if (jdErr) return err(jdErr.message);
      if (!jd) return err(`JD ${jd_id} not found.`);
      if (!jd.enterprise_id || !jd.job_title) return err("JD is missing enterprise_id or job_title.");

      const mustSkills = splitSkills(jd.requirements);
      const shouldSkills = [...splitSkills(jd.qualifications), ...splitSkills(jd.soft_skills)];

      // Kick off the same background pipeline the app uses (returns 202 immediately).
      await invokeEdge("jd-search-background", {
        enterprise_id: jd.enterprise_id,
        job_id: jd.id,
        job_title: jd.job_title,
        must_skills: mustSkills,
        should_skills: shouldSkills,
        location: location ?? jd.location ?? undefined,
        language: language ?? "fr",
      });

      // Poll jd_search_cache until the run is done or we run out of time.
      const deadline = Date.now() + wait_seconds * 1000;
      let cache: { status?: string; total_count?: number; results?: unknown } | null = null;
      do {
        await new Promise((r) => setTimeout(r, 2500));
        const { data } = await supabase
          .from("jd_search_cache")
          .select("status,total_count,results")
          .eq("enterprise_id", jd.enterprise_id)
          .eq("job_id", jd.id)
          .maybeSingle();
        cache = data;
      } while ((!cache || cache.status !== "done") && Date.now() < deadline);

      const candidates = Array.isArray(cache?.results) ? cache.results : [];
      return ok({
        jd_id,
        job_title: jd.job_title,
        status: cache?.status ?? "pending",
        analyzed: cache?.total_count ?? candidates.length,
        returned: candidates.length,
        candidates,
        note:
          cache?.status === "done"
            ? undefined
            : "Still running — call get_jd_search_results(jd_id) again shortly for the full set.",
      });
    },
  );

  registerTool(
    "get_jd_search_results",
    {
      title: "Get cached candidate-search results for a JD",
      description:
        "Reads jd_search_cache for a JD (populated by search_jd_candidates or the app's background search). " +
        "Returns the search status and the scored candidates.",
      inputSchema: { jd_id: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ jd_id }) => {
      const { data: jd, error: jdErr } = await supabase
        .from("job_descriptions")
        .select("id,enterprise_id,job_title")
        .eq("id", jd_id)
        .maybeSingle();
      if (jdErr) return err(jdErr.message);
      if (!jd) return err(`JD ${jd_id} not found.`);
      const { data: cache, error: cErr } = await supabase
        .from("jd_search_cache")
        .select("status,total_count,results,updated_at")
        .eq("enterprise_id", jd.enterprise_id)
        .eq("job_id", jd.id)
        .maybeSingle();
      if (cErr) return err(cErr.message);
      if (!cache) {
        return ok({
          jd_id,
          status: "none",
          candidates: [],
          note: "No search has been run for this JD yet — call search_jd_candidates first.",
        });
      }
      const candidates = Array.isArray(cache.results) ? cache.results : [];
      return ok({
        jd_id,
        job_title: jd.job_title,
        status: cache.status,
        analyzed: cache.total_count,
        returned: candidates.length,
        updated_at: cache.updated_at,
        candidates,
      });
    },
  );
}
