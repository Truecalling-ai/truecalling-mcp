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
// Skill normalization — mirror of fullenrichService.ts normalizeSkillValue.
const SKILL_ALIASES: Record<string, string> = {
  d365: "Dynamics 365", dynamics365: "Dynamics 365",
  "d365 fo": "Dynamics 365 Finance & Operations", d365fo: "Dynamics 365 Finance & Operations",
  "f&o": "Dynamics 365 Finance & Operations", "d365 bc": "Dynamics 365 Business Central",
  d365bc: "Dynamics 365 Business Central", "business central": "Dynamics 365 Business Central",
  nodejs: "Node.js", "node.js": "Node.js", reactjs: "React", "react.js": "React",
  typescript: "TypeScript", javascript: "JavaScript", postgresql: "PostgreSQL", postgres: "PostgreSQL",
  aws: "AWS", gcp: "GCP", azure: "Azure", devops: "DevOps", "ci/cd": "CI/CD", cicd: "CI/CD",
  golang: "Go", csharp: "C#", cpp: "C++", "power bi": "Power BI", powerbi: "Power BI",
  graphql: "GraphQL", "rest api": "REST API",
};
function normalizeSkillValue(s: any): string {
  if (!s) return "";
  const raw =
    typeof s === "string"
      ? s.trim()
      : typeof s === "object"
        ? String(s.name ?? s.label ?? "").trim()
        : String(s).trim();
  return SKILL_ALIASES[raw.toLowerCase().trim()] ?? raw;
}
function yearsBetween(a: any, b: any): number {
  if (!a) return 0;
  const s = new Date(a).getTime();
  const e = b && b !== "Present" ? new Date(b).getTime() : Date.now();
  if (Number.isNaN(s)) return 0;
  const ms = e - s;
  return ms > 0 ? ms / (365.25 * 24 * 3600 * 1000) : 0;
}
function getTotalYears(p: any): number {
  if (typeof p?.total_experience_years === "number") return p.total_experience_years;
  if (typeof p?.experience_years === "number") return p.experience_years;
  const hist: any[] = p?.employment?.history ?? p?.employment?.all ?? [];
  if (hist.length)
    return Math.round(Math.min(hist.reduce((a: number, j: any) => a + yearsBetween(j?.start_at, j?.end_at), 0), 60) * 10) / 10;
  const cur = p?.employment?.current ?? {};
  return yearsBetween(cur.start_at, cur.end_at);
}
function normalizeEmployment(p: any): Array<{ title: string; company: string; start: string; end: string }> {
  const hist: any[] = p?.employment?.history ?? p?.employment?.all ?? [];
  const rows = hist.map((j: any) => ({
    title: String(j?.title ?? "").trim(),
    company: String(j?.company_name ?? j?.company?.name ?? j?.organization ?? "").trim(),
    start: j?.start_at ?? "",
    end: j?.end_at ?? "Present",
  }));
  if (!rows.length && p?.employment?.current) {
    const c = p.employment.current;
    rows.push({
      title: String(c?.title ?? "").trim(),
      company: String(c?.company_name ?? c?.company?.name ?? "").trim(),
      start: c?.start_at ?? "",
      end: "Present",
    });
  }
  return rows;
}
// EXACT replica of fepersonToCVObject(mapPerson(p)) so score-candidate returns
// the same compatibility score as the platform. Key ORDER matters: the lite
// scorer is deterministic (temp 0) but sensitive to the serialized CV.
function feToCv(p: any): Record<string, unknown> {
  return {
    name: String(p?.full_name ?? "").trim(),
    currentTitle: String(p?.employment?.current?.title ?? p?.title ?? "").trim(),
    location: [p?.location?.city, p?.location?.country].filter(Boolean).join(", "),
    totalExperienceYears: getTotalYears(p),
    skills: (Array.isArray(p?.skills) ? p.skills : []).map(normalizeSkillValue).filter(Boolean),
    linkedinUrl: p?.social_profiles?.professional_network?.url ?? "",
    experience: normalizeEmployment(p).map((e) => ({
      title: e.title,
      company: e.company,
      duration: [e.start, e.end].filter(Boolean).join("–"),
    })),
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
        ai_score: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "Stage 2: AI compatibility scoring (score-candidate edge) — this is the score the platform shows/sorts on. Costs 1 OpenAI call per candidate scored. Set false to return only the fast jdScore.",
          ),
        ai_score_top: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe("How many top-jdScore candidates to AI-score (caps the OpenAI cost), then re-rank by compatibility."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ jd_id, location, size, max_pages, expand_title, ai_score, ai_score_top }) => {
      const { data: jd, error: jdErr } = await supabase
        .from("job_descriptions")
        .select(
          "id,job_title,location,job_summary,job_description,key_responsibilities,expectation,requirements,qualifications,soft_skills",
        )
        .eq("id", jd_id)
        .maybeSingle();
      if (jdErr) return err(jdErr.message);
      if (!jd) return err(`JD ${jd_id} not found.`);
      if (!jd.job_title) return err("JD has no job_title.");

      // Derive the search params from the JD EXACTLY like the platform's
      // findCandidates (JobDescriptions.tsx) → extract-search-params edge:
      // titleKeywords (English), city, country, mustSkills, shouldSkills.
      const fallbackCity = jd.location ? String(jd.location).split(",")[0].trim() : "";
      const fallbackCountry =
        jd.location && String(jd.location).includes(",")
          ? String(jd.location).split(",").slice(1).join(",").trim()
          : "";
      const spText = [
        jd.job_summary, jd.job_description, jd.key_responsibilities, jd.expectation, jd.requirements, jd.qualifications,
      ]
        .filter(Boolean)
        .join("\n\n");
      let titleKeyword = String(jd.job_title);
      let city = fallbackCity;
      let country = fallbackCountry;
      let mustSkills: string[] = [];
      let shouldSkills: string[] = [];
      try {
        const sp = (await invokeEdge("extract-search-params", {
          jdText: spText,
          jobTitle: jd.job_title,
          language: "fr",
        })) as { result?: any };
        const r = sp?.result ?? {};
        if (r.titleKeywords) titleKeyword = String(r.titleKeywords);
        if (r.city) city = String(r.city);
        if (r.country) country = String(r.country);
        if (Array.isArray(r.mustSkills)) mustSkills = r.mustSkills.filter(Boolean);
        if (Array.isArray(r.shouldSkills)) shouldSkills = r.shouldSkills.filter(Boolean);
      } catch {
        // fall back to the JD's own fields below
      }
      if (!mustSkills.length) mustSkills = splitSkills(jd.requirements);
      if (!shouldSkills.length)
        shouldSkills = [...splitSkills(jd.qualifications), ...splitSkills(jd.soft_skills)];

      // Location: explicit override > extracted/JD city+country.
      const locValue =
        (location && location.trim()) || normalizeLocation([city, country].filter(Boolean).join(", "));

      // Expand the (English) title into synonyms — the platform does this too.
      let titles: string[] = [titleKeyword];
      if (expand_title !== false) {
        try {
          const exp = (await invokeEdge("expand-job-title", { title: titleKeyword })) as { titles?: string[] };
          if (Array.isArray(exp?.titles) && exp.titles.length) titles = exp.titles;
        } catch {
          // fall back to the single title
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
            cv: feToCv(p),
            aiScore: null as number | null,
            aiMatching: null as string[] | null,
          });
        }

        if (batch.length < 100) break; // exhausted
      }

      // Pre-rank by the fast skill-overlap jdScore.
      scored.sort((a, b) => b.jdScore - a.jdScore);

      // Stage 2 — AI compatibility scoring (score-candidate, lite). This is the
      // score the platform actually displays and sorts on. Bounded to the top
      // `ai_score_top` by jdScore to cap the OpenAI cost.
      let aiScoredCount = 0;
      if (ai_score !== false && scored.length) {
        const jdText = [jd.job_summary, jd.job_description, jd.key_responsibilities, jd.requirements]
          .filter(Boolean)
          .join("\n");
        const toScore = scored.slice(0, Math.min(ai_score_top, scored.length));
        const CONCURRENCY = 5;
        for (let i = 0; i < toScore.length; i += CONCURRENCY) {
          const batch = toScore.slice(i, i + CONCURRENCY);
          await Promise.all(
            batch.map(async (cand) => {
              try {
                const res = (await invokeEdge("score-candidate", {
                  cvContent: cand.cv,
                  jobDescription: jdText,
                  jobTitle: jd.job_title,
                  language: "fr",
                  lite: true,
                })) as { result?: { compatibilityScore?: number; matchingSkills?: string[] } };
                const sr = res?.result ?? (res as any);
                if (typeof sr?.compatibilityScore === "number") {
                  cand.aiScore = sr.compatibilityScore;
                  cand.aiMatching = sr.matchingSkills ?? [];
                  aiScoredCount++;
                }
              } catch {
                // leave aiScore null — falls back to jdScore in the final sort
              }
            }),
          );
        }
        // Re-rank the AI-scored head by compatibility score (then jdScore).
        toScore.sort((a, b) => (b.aiScore ?? -1) - (a.aiScore ?? -1) || b.jdScore - a.jdScore);
        for (let i = 0; i < toScore.length; i++) scored[i] = toScore[i];
      }

      const candidates = scored.slice(0, size).map((c) => ({
        score: c.aiScore ?? c.jdScore,
        aiScore: c.aiScore,
        jdScore: c.jdScore,
        fullName: c.fullName,
        title: c.title,
        company: c.company,
        location: c.location,
        linkedinUrl: c.linkedinUrl,
        matching: c.aiMatching ?? c.matchedMust,
      }));
      return ok({
        jd_id,
        job_title: jd.job_title,
        search_params: { title: titleKeyword, city, country, must: mustSkills, should: shouldSkills },
        expanded_titles: titles,
        location_filter: locValue || null,
        total_in_db: totalInDb,
        analyzed: scored.length,
        ai_scored: aiScoredCount,
        score_field: ai_score !== false ? "compatibility (AI) — same as the platform" : "jdScore (skill overlap)",
        returned: candidates.length,
        candidates,
      });
    },
  );
}
