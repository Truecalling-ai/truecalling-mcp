import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { supabase, SESSION_FILE } from "../supabase.js";
import { invokeEdge } from "../edge.js";
import { ok, err, authedRegisterTool } from "../util.js";

// Disk cache for the LLM-derived search params (extract-search-params +
// expand-job-title run at temperature>0, so they vary run-to-run). Caching by
// JD makes repeat searches reproducible. Lives next to the session file.
const PARAMS_CACHE_FILE = join(dirname(SESSION_FILE), "search-params-cache.json");
function readParamsCache(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(PARAMS_CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeParamsCache(cache: Record<string, any>): void {
  try {
    writeFileSync(PARAMS_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // best-effort cache
  }
}

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
// Infer the [min,max] experience window from a JD — EXACT replica of
// AdvancedSearch.tsx inferYearsFromJD. A "Manager" title => 7-15 years, etc.
// This is why the platform surfaces senior profiles, not junior freelancers.
function inferYearsFromJD(jd: any): { min: number; max: number } | null {
  const text = [jd?.requirements, jd?.qualifications, jd?.job_description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const title = String(jd?.job_title ?? "").toLowerCase();
  const patterns = [
    /(\d+)\s*[àa-]\s*(\d+)\s*(ans|year|année)/i,
    /(\d+)\+\s*(ans|year|année)/i,
    /(?:minimum|au moins|minimum de|at least)\s*(\d+)\s*(ans|year|année)/i,
    /(\d+)\s*(ans?|years?)\s*(?:d.expérience|of experience|minimum|requis|required)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = m[2] !== undefined && /^\d+$/.test(m[2]) ? parseInt(m[2], 10) : null;
      if (!Number.isNaN(a)) {
        return { min: a, max: b !== null ? Math.min(b, 20) : Math.min(a + 4, 20) };
      }
    }
  }
  if (/\b(c[- ]?level|chief|ceo|cto|coo|cfo|cpo)\b/i.test(title)) return { min: 15, max: 20 };
  if (/\b(vp|vice.?president|vice président)\b/i.test(title)) return { min: 12, max: 20 };
  if (/\b(director|directeur)\b/i.test(title)) return { min: 10, max: 18 };
  if (/\b(manager|responsable|head of|chef de)\b/i.test(title)) return { min: 7, max: 15 };
  if (/\b(senior|sr\.?|expérimenté|confirmé|lead)\b/i.test(title)) return { min: 5, max: 12 };
  if (/\b(mid|intermediary|intermédiaire|confirmed|confirmé)\b/i.test(title)) return { min: 2, max: 6 };
  if (/\b(junior|jr\.?|débutant|entry.?level|stage|intern)\b/i.test(title)) return { min: 0, max: 2 };
  return null;
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

// Extract a clean contacts block from a FullEnrich enrich poll result so the
// tool returns usable emails/phones instead of the raw nested blob
// (FullEnrich puts them under data[].contact_info).
function extractFeContacts(pollResult: any): { status?: string; credits?: number; contacts: any[] } {
  const r = pollResult?.result ?? pollResult ?? {};
  const data: any[] = Array.isArray(r.data) ? r.data : Array.isArray(r.datas) ? r.datas : [];
  const contacts = data.map((d: any) => {
    const ci = d?.contact_info ?? d?.contact ?? {};
    const emailObjs = [
      ...(Array.isArray(ci.work_emails) ? ci.work_emails : []),
      ...(Array.isArray(ci.personal_emails) ? ci.personal_emails : []),
      ...(Array.isArray(ci.emails) ? ci.emails : []),
    ];
    const phoneObjs = [
      ...(Array.isArray(ci.phones) ? ci.phones : []),
      ...(Array.isArray(ci.mobile_phones) ? ci.mobile_phones : []),
    ];
    const emails = [...new Set(emailObjs.map((e: any) => e?.email ?? e).filter(Boolean))];
    const phones = [...new Set(phoneObjs.map((ph: any) => ph?.number ?? ph).filter(Boolean))];
    return {
      linkedin: d?.input?.professional_network_url ?? d?.input?.linkedin_url ?? null,
      full_name: d?.profile?.full_name ?? null,
      work_email: ci?.most_probable_work_email?.email ?? null,
      personal_email: ci?.most_probable_personal_email?.email ?? null,
      phone: ci?.most_probable_phone?.number ?? null,
      all_emails: emails,
      all_phones: phones,
    };
  });
  return { status: r.status ?? r.enrichment_status, credits: r.cost?.credits, contacts };
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
      const sr = (start as { result?: { enrichment_id?: string; id?: string } })?.result ?? (start as any);
      return ok({
        enrichment_id: sr?.enrichment_id ?? sr?.id ?? null,
        message: "Poll with fullenrich_poll(enrich_id, force_results=true) — typically 30-120s.",
        raw: start,
      });
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
      // Surface a clean contacts block (emails/phones); keep raw for anything else.
      return ok({ ...extractFeContacts(result), raw: result });
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
          .max(5000)
          .default(120)
          .describe("How many candidates (title-relevance order) to AI-score; caps the OpenAI cost. The platform scores its whole filtered pool — raise toward `analyzed` for full parity."),
        refresh: z
          .boolean()
          .optional()
          .default(false)
          .describe("Recompute and re-cache the derived search params (title expansion + extracted skills/location) for this JD instead of reusing the deterministic disk cache."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ jd_id, location, size, max_pages, expand_title, ai_score, ai_score_top, refresh }) => {
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

      // Derive the search params EXACTLY like the platform's findCandidates
      // (JobDescriptions.tsx -> extract-search-params edge) + expand-job-title.
      // Both run at temperature>0, so cache the result per JD on disk to make
      // repeat searches REPRODUCIBLE (pass refresh:true to recompute).
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

      const cacheKey = `${jd_id}|loc=${(location ?? "").trim().toLowerCase()}|exp=${expand_title !== false}`;
      const paramsCache = readParamsCache();
      let titleKeyword: string;
      let city: string;
      let country: string;
      let mustSkills: string[];
      let shouldSkills: string[];
      let titles: string[];
      let fromCache = false;
      const cached = refresh ? undefined : paramsCache[cacheKey];
      if (cached) {
        ({ titleKeyword, city, country, mustSkills, shouldSkills, titles } = cached);
        fromCache = true;
      } else {
        titleKeyword = String(jd.job_title);
        city = fallbackCity;
        country = fallbackCountry;
        mustSkills = [];
        shouldSkills = [];
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
        titles = [titleKeyword];
        if (expand_title !== false) {
          try {
            const exp = (await invokeEdge("expand-job-title", { title: titleKeyword })) as { titles?: string[] };
            if (Array.isArray(exp?.titles) && exp.titles.length) titles = exp.titles;
          } catch {
            // fall back to the single title
          }
        }
        paramsCache[cacheKey] = { titleKeyword, city, country, mustSkills, shouldSkills, titles };
        writeParamsCache(paramsCache);
      }

      // Location: explicit override > extracted/JD city+country.
      const locValue =
        (location && location.trim()) || normalizeLocation([city, country].filter(Boolean).join(", "));
      const titleKeywords = titles.join(", ");

      // Match the platform's FE search filter (fullenrichService.ts): send only
      // `must`, CAPPED at 3, and NEVER `should`. should is used purely for the
      // client-side overlap signal — putting it in the search body over-narrows
      // the pool so only near-identical mid-fit profiles (all ~85) are fetched.
      const MUST_CAP = 3;
      const skillFilters = mustSkills.slice(0, MUST_CAP).map(v3val).filter(Boolean);
      const baseBody: Record<string, unknown> = {
        limit: 100,
        current_position_titles: titles.map(v3val).filter(Boolean),
      };
      if (locValue) baseBody.person_locations = [v3val(locValue)].filter(Boolean);

      // 2. Paginate, light-title-filter, dedupe and score — like searchAndAdaptByJDMax.
      const seen = new Set<string>();
      let scored: any[] = [];
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
          // No title filter — the platform's searchPeopleWithRaw keeps every FE
          // result (FE already filtered by current_position_titles) and only
          // POST-SORTS by title relevance (done after this loop). Just dedupe.
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

      // Filter the pool by the experience window inferred from the JD, exactly
      // like AdvancedSearch (inferYearsFromJD -> feMinYears/feMaxYears): a
      // "Manager" title => 7-15 years. This is the BIGGEST divergence — without
      // it the pool drowns in junior/freelance profiles and the senior profiles
      // the platform ranks #1/#2 never get scored.
      const years = inferYearsFromJD(jd);
      if (years) {
        scored = scored.filter((c) => {
          const y = Number(c.cv?.totalExperienceYears ?? 0);
          return y >= years.min && (years.max >= 20 || y <= years.max);
        });
      }

      // Post-sort the whole pool by title-keyword relevance — exactly like the
      // platform's searchPeopleWithRaw (more matching title synonyms in the
      // person's title = earlier). This sets the order we AI-score in, so the
      // most title-relevant candidates are scored first (the platform scores all;
      // we bound the cost via ai_score_top).
      const titleTokens = titleKeywords
        .split(/[,\n;|]/)
        .map((tk) => tk.trim().toLowerCase())
        .filter(Boolean);
      if (titleTokens.length) {
        scored.sort(
          (a, b) =>
            titleTokens.filter((tk) => String(b.title ?? "").toLowerCase().includes(tk)).length -
            titleTokens.filter((tk) => String(a.title ?? "").toLowerCase().includes(tk)).length,
        );
      }

      // Stage 2 — AI compatibility scoring (score-candidate, lite) = the score
      // the platform shows and sorts on. Like AdvancedSearch ("Score ALL
      // candidates, no pre-ranking by keyword overlap"), score in FullEnrich
      // ARRIVAL order — NOT pre-ranked by jdScore, so a high-AI/low-overlap
      // profile is never excluded. ai_score_top bounds the OpenAI cost.
      let aiScoredCount = 0;
      if (ai_score !== false && scored.length) {
        const jdText = [jd.job_summary, jd.job_description, jd.key_responsibilities, jd.requirements]
          .filter(Boolean)
          .join("\n");
        const toScore = scored.slice(0, Math.min(ai_score_top, scored.length));
        const CONCURRENCY = 12;
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
                // leave aiScore null
              }
            }),
          );
        }
      }

      // Final sort: AI compatibility ONLY (null -> 0), like the platform
      // (AdvancedSearch sorts by getScore()?.score ?? 0). No jdScore fallback,
      // so the ordering matches even when only part of the pool is scored.
      scored.sort((a, b) => (b.aiScore ?? 0) - (a.aiScore ?? 0));

      const candidates = scored.slice(0, size).map((c) => ({
        score: c.aiScore ?? 0,
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
        params_cached: fromCache,
        years_filter: years,
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
