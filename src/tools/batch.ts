import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { invokeEdge } from "../edge.js";
import { ok, guardWrite, authedRegisterTool } from "../util.js";

export function registerBatchTools(server: McpServer): void {
  const registerTool = authedRegisterTool(server);
  registerTool(
    "sweep_enrich_candidates",
    {
      title: "Run the candidate enrichment sweep",
      description:
        "Calls `sweep-enrich-candidates` edge function. ⚠️ Consumes FullEnrich credits ($). " +
        "Optional filters narrow the sweep to one JD or one batch.",
      inputSchema: {
        jd_id: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(500).default(50),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ jd_id, limit }) => {
      const block = guardWrite("sweep_enrich_candidates");
      if (block) return block;
      const result = await invokeEdge("sweep-enrich-candidates", { jdId: jd_id, limit });
      return ok(result);
    },
  );

  registerTool(
    "recalculate_scores",
    {
      title: "Recalculate AI compatibility scores",
      description:
        "Calls `recalculate-scores` edge function. Re-runs scoring for candidates of a JD (or all of the enterprise if jd_id is omitted). Consumes OpenAI tokens.",
      inputSchema: {
        jd_id: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ jd_id }) => {
      const block = guardWrite("recalculate_scores");
      if (block) return block;
      const result = await invokeEdge("recalculate-scores", { jdId: jd_id });
      return ok(result);
    },
  );

  registerTool(
    "compare_jd_candidate",
    {
      title: "Compare a JD and a candidate in depth",
      description:
        "Calls `compare-jd-candidate` edge function. Returns a fine-grained match analysis (skills overlap, gaps, recommendation).",
      inputSchema: {
        jd_id: z.string().uuid(),
        candidate_id: z.string().uuid(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ jd_id, candidate_id }) => {
      const result = await invokeEdge("compare-jd-candidate", { jdId: jd_id, candidateId: candidate_id });
      return ok(result);
    },
  );

  registerTool(
    "match_internal_jds",
    {
      title: "Match a candidate against internal JDs",
      description:
        "Calls `match-internal-jds` edge function. For a given candidate, returns ranked matches across all active JDs of the enterprise.",
      inputSchema: { candidate_id: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ candidate_id }) => {
      const result = await invokeEdge("match-internal-jds", { candidateId: candidate_id });
      return ok(result);
    },
  );
}
