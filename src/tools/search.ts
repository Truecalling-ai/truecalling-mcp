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

// ── FullEnrich JD-search helpers (mirror app's src/services/fullenrichService.ts) ──
const COUNTRY_MAP: Record<string, string> = {
  FR: "France", GB: "United Kingdom", UK: "United Kingdom", US: "United States",
  USA: "United States", BE: "Belgium", CH: "Switzerland", DE: "Germany", ES: "Spain",
  IT: "Italy", NL: "Netherlands", CA: "Canada", AU: "Australia", BR: "Brazil",
  PT: "Portugal", IL: "Israel", LU: "Luxembourg", MA: "Morocco", DZ: "Algeria",
  TN: "Tunisia", SN: "Senegal",
};
function normalizeLocation(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const up = s.toUpperCase();
  if (/^[A-Z]{2,3}$/.test(up)) return COUNTRY_MAP[up] ?? s;
  return s; // "Paris, France" / "France" — FullEnrich matches fuzzily
}
function v3val(value: string): { value: string; exact_match: boolean; exclude: boolean } | null {
  const v = String(value ?? "").trim();
  return v ? { value: v, exact_match: false, exclude: false } : null;
}
function normTok(s: string): string {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}
function matchLoose(profileSkills: string[], jdSkills: string[]): string[] {
  const pn = profileSkills.map(normTok);
  return jdSkills.filter((j) => {
    const jn = normTok(j);
    return jn ? pn.some((p) => p.includes(jn) || jn.includes(p)) : false;
  });
}
function feMapPerson(p: any) {
  const cur = p?.employment?.current ?? {};
  const skills = Array.isArray(p?.skills)
    ? p.skills.map((x: any) => (typeof x === "string" ? x : x?.name ?? x?.label ?? "")).filter(Boolean)
    : [];
  return {
    fullName: p?.full_name || [p?.first_name, p?.last_name].filter(Boolean).join(" "),
    title: cur?.title ?? p?.title ?? "",
    company: cur?.company?.name ?? "",
    location: [p?.location?.city, p?.location?.country].filter(Boolean).join(", "),
    linkedinUrl: p?.social_profiles?.professional_network?.url ?? p?.linkedin_url ?? "",
    skills: skills as string[],
  };
}
function fePickPeople(raw: any): any[] {
  return Array.isArray(raw?.result?.people) ? raw.result.people
    : Array.isArray(raw?.people) ? raw.people
    : Array.isArray(raw?.results) ? raw.results
    : Array.isArray(raw) ? raw : [];
}
const TITLE_NOISE = new Set([
  "senior", "junior", "lead", "principal", "staff", "associate", "sr", "jr", "mid",
  "head", "chief", "director", "manager", "officer", "specialist", "expert", "consultant",
  "the", "of", "and", "de", "du", "le", "la", "les", "en", "et", "pour",
]);
function passesLightTitleFilter(person: any, titleKeywords: string): boolean {
  if (!titleKeywords) return true;
  const jdWords = titleKeywords
    .toLowerCase()
    .replace(/[^a-z0-9\séèêàâùûîôç]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !TITLE_NOISE.has(w));
  if (jdWords.length === 0) return true;
  const cur = person?.employment?.current;
  const personTitle = String(cur?.title || person?.headline || person?.title || "").toLowerCase();
  if (!personTitle) return false;
  return jdWords.some((w) => personTitle.includes(w));
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
      title: "Source candidates for a JD (FullEnrich — aligned with the platform)",
      description:
        "Replicates the app's searchAndAdaptByJDMax for a job description: LLM-expands the title (expand-job-title), " +
        "searches FullEnrich across up to `max_pages` pages (100/page) filtered by person_locations (JD location, " +
        "overridable) and person_skills (requirements/qualifications), applies the light title filter, dedupes, " +
        "scores every profile against the JD skills, and returns the top `size`. FullEnrich search is free (credits " +
        "only on enrichment); deep runs are slower, so lower max_pages if your client times out.",
      inputSchema: {
        jd_id: z.string().uuid(),
        location: z
          .string()
          .optional()
          .describe("Override the location filter (defaults to the JD's location). E.g. 'France', 'Paris, France'."),
        size: z.number().int().min(1).max(100).default(25).describe("How many top candidates to return"),
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(50)
          .describe("FullEnrich pages to analyze (100 profiles each). Platform uses 50; lower for faster runs."),
        expand_title: z
          .boolean()
          .optional()
          .default(true)
          .describe("LLM-expand the JD title into synonyms before searching (like the platform)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ jd_id, location, size, max_pages, expand_title }) => {
      const { data: jd, error: jdErr } = await supabase
        .from("job_descriptions")
        .select("id,job_title,location,requirements,qualifications,soft_skills")
        .eq("id", jd_id)
        .maybeSingle();
      if (jdErr) return err(jdErr.message);
      if (!jd) return err(`JD ${jd_id} not found.`);
      if (!jd.job_title) return err("JD has no job_title.");

      const mustSkills = splitSkills(jd.requirements);
      const shouldSkills = [...splitSkills(jd.qualifications), ...splitSkills(jd.soft_skills)];
      const locValue = normalizeLocation(location ?? jd.location ?? "");

      // 1. Expand the title into synonyms (the platform does this before searching).
      let titles: string[] = [String(jd.job_title)];
      if (expand_title !== false) {
        try {
          const exp = (await invokeEdge("expand-job-title", { title: jd.job_title })) as { titles?: string[] };
          if (Array.isArray(exp?.titles) && exp.titles.length) titles = exp.titles;
        } catch {
          // fall back to the raw title
        }
      }
      const titleKeywords = titles.join(", ");

      const skillFilters = [...mustSkills, ...shouldSkills].map(v3val).filter(Boolean);
      const baseBody: Record<string, unknown> = {
        limit: 100,
        current_position_titles: titles.map(v3val).filter(Boolean),
      };
      if (locValue) baseBody.person_locations = [v3val(locValue)].filter(Boolean);

      // 2. Paginate, light-title-filter, dedupe and score — like searchAndAdaptByJDMax.
      const seen = new Set<string>();
      const scored: any[] = [];
      let totalInDb: number | null = null;
      let retryWithoutSkills = false;

      for (let page = 0; page < max_pages; page++) {
        const body: Record<string, unknown> = { ...baseBody, offset: page * 100 };
        if (!retryWithoutSkills && skillFilters.length) body.person_skills = skillFilters;
        let raw: any;
        try {
          raw = await invokeEdge("fullenrich-proxy", { action: "search", body });
        } catch {
          break;
        }
        let batch = fePickPeople(raw);
        if (page === 0 && batch.length === 0 && skillFilters.length && !retryWithoutSkills) {
          retryWithoutSkills = true;
          const noSkills = { ...body };
          delete (noSkills as Record<string, unknown>).person_skills;
          try {
            raw = await invokeEdge("fullenrich-proxy", { action: "search", body: noSkills });
          } catch {
            break;
          }
          batch = fePickPeople(raw);
        }
        if (page === 0) totalInDb = raw?.result?.metadata?.total ?? raw?.metadata?.total ?? null;

        for (const p of batch) {
          if (!passesLightTitleFilter(p, titleKeywords)) continue;
          const key = String(p?.id || p?.linkedin_url || p?.full_name || "").trim();
          if (key && seen.has(key)) continue;
          if (key) seen.add(key);
          const m = feMapPerson(p);
          const matchedMust = matchLoose(m.skills, mustSkills);
          const matchedShould = matchLoose(m.skills, shouldSkills);
          const total = mustSkills.length + shouldSkills.length;
          const jdScore =
            total > 0 ? Math.round(((matchedMust.length + matchedShould.length) / total) * 100) : 50;
          scored.push({
            jdScore,
            fullName: m.fullName,
            title: m.title,
            company: m.company,
            location: m.location,
            linkedinUrl: m.linkedinUrl,
            matchedMust,
          });
        }

        if (batch.length < 100) break; // exhausted
      }

      scored.sort((a, b) => b.jdScore - a.jdScore);
      return ok({
        jd_id,
        job_title: jd.job_title,
        expanded_titles: titles,
        location_filter: locValue || null,
        total_in_db: totalInDb,
        analyzed: scored.length,
        returned: Math.min(scored.length, size),
        candidates: scored.slice(0, size),
      });
    },
  );
}
