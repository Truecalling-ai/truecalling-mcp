import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { invokeEdge } from "../edge.js";
import { ok } from "../util.js";

export function registerSearchTools(server: McpServer): void {
  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    "search_candidates_pdl",
    {
      title: "Search candidates via People Data Labs",
      description:
        "Calls `search-candidates-pdl` edge function. Free-form query passed to PDL's elastic-like search.",
      inputSchema: {
        query: z.record(z.unknown()).describe("PDL search query DSL"),
        size: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, size }) => {
      const result = await invokeEdge("search-candidates-pdl", { query, size });
      return ok(result);
    },
  );
}
