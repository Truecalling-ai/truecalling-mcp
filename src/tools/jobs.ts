import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { supabase } from "../supabase.js";
import { invokeEdge } from "../edge.js";
import { ok, err, guardWrite } from "../util.js";

const JD_COLUMNS =
  "id,enterprise_id,team_leader_id,job_title,job_summary,key_responsibilities," +
  "location,remote,salary_min,salary_max,ai_traits,is_active,created_at,updated_at";

export function registerJobsTools(server: McpServer): void {
  server.registerTool(
    "list_jds",
    {
      title: "List job descriptions",
      description:
        "List JDs visible to the authenticated user. Filter by is_active or title substring.",
      inputSchema: {
        is_active: z.boolean().optional().describe("Filter active/inactive JDs"),
        search: z.string().optional().describe("Substring on job_title (ilike)"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ is_active, search, limit, offset }) => {
      let q = supabase.from("job_descriptions").select(JD_COLUMNS).range(offset, offset + limit - 1);
      if (is_active !== undefined) q = q.eq("is_active", is_active);
      if (search) q = q.ilike("job_title", `%${search}%`);
      const { data, error } = await q;
      if (error) return err(error.message);
      return ok({ count: data?.length ?? 0, jds: data ?? [] });
    },
  );

  server.registerTool(
    "get_jd",
    {
      title: "Get JD by id",
      description: "Full JD record including ai_traits and key_responsibilities.",
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ id }) => {
      const { data, error } = await supabase.from("job_descriptions").select("*").eq("id", id).maybeSingle();
      if (error) return err(error.message);
      if (!data) return err(`JD ${id} not found.`);
      return ok(data);
    },
  );

  server.registerTool(
    "create_jd",
    {
      title: "Create a job description",
      description:
        "Insert a new JD. enterprise_id is required (defaults to the authenticated user's enterprise if you fetch it via get_my_enterprise first).",
      inputSchema: {
        payload: z
          .record(z.unknown())
          .describe(
            "Object with at minimum: enterprise_id, job_title. Optional: job_summary, key_responsibilities, location, remote, salary_min/max, ai_traits, is_active, team_leader_id.",
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ payload }) => {
      const block = guardWrite("create_jd");
      if (block) return block;
      const { data, error } = await supabase.from("job_descriptions").insert(payload).select().maybeSingle();
      if (error) return err(error.message);
      return ok(data ?? { created: true });
    },
  );

  server.registerTool(
    "update_jd",
    {
      title: "Update JD fields",
      description: "Partial update on a JD. Pass the fields to change in `patch`.",
      inputSchema: {
        id: z.string().uuid(),
        patch: z.record(z.unknown()),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ id, patch }) => {
      const block = guardWrite("update_jd");
      if (block) return block;
      const { data, error } = await supabase.from("job_descriptions").update(patch).eq("id", id).select().maybeSingle();
      if (error) return err(error.message);
      return ok(data ?? { id, updated: true });
    },
  );

  server.registerTool(
    "parse_job_text",
    {
      title: "Parse a raw job offer text into structured JD fields",
      description:
        "Calls `parse-job-text` edge function. Input: raw text (copy-paste from a job board). " +
        "Returns structured fields: job_title, job_summary, key_responsibilities, ai_traits, etc.",
      inputSchema: {
        text: z.string().min(20).describe("Raw job description text"),
        language: z.string().optional().describe("BCP-47 code (e.g. 'fr', 'en'). Auto-detected if omitted."),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ text, language }) => {
      const result = await invokeEdge("parse-job-text", { text, language });
      return ok(result);
    },
  );

  server.registerTool(
    "expand_job_title",
    {
      title: "Expand a job title into synonyms / related titles",
      description:
        "Calls `expand-job-title` edge function. Useful before launching a candidate search " +
        "(e.g. 'frontend dev' → ['React developer', 'JS engineer', 'UI engineer']).",
      inputSchema: { title: z.string().min(2) },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ title }) => {
      const result = await invokeEdge("expand-job-title", { title });
      return ok(result);
    },
  );
}
