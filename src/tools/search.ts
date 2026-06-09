import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { invokeEdge } from "../edge.js";
import { ok, authedRegisterTool } from "../util.js";

export function registerSearchTools(server: McpServer): void {
  const registerTool = authedRegisterTool(server);
  registerTool(
    "fullenrich_search",
    {
      title: "Search profiles via FullEnrich",
      description:
        "Calls the `fullenrich-proxy` edge function with action='search'. " +
        "Use filters like current_position_titles, person_locations, person_skills, person_seniority, current_company_names. " +
        "Returns up to `limit` profiles (max 100 per page).",
      inputSchema: {
        body: z
          .record(z.unknown())
          .describe(
            "FullEnrich v2 /people/search body. Common keys: limit, offset, current_position_titles, person_locations, person_skills, person_seniority, current_company_names.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ body }) => {
      const result = await invokeEdge("fullenrich-proxy", { action: "search", body });
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
}
