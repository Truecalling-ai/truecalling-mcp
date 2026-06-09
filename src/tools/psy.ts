import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { supabase } from "../supabase.js";
import { invokeEdge } from "../edge.js";
import { ok, err, guardWrite, authedRegisterTool } from "../util.js";

export function registerPsyTools(server: McpServer): void {
  const registerTool = authedRegisterTool(server);
  registerTool(
    "create_psy_assignment",
    {
      title: "Create a psychometric test assignment",
      description:
        "Creates a psy assignment for a candidate. Returns a token that the candidate uses to access /candidate-test in the UI.",
      inputSchema: {
        candidate_id: z.string().uuid(),
        lang: z.string().default("en").describe("BCP-47 language code (en, fr, es, de, pt, it, he)"),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ candidate_id, lang }) => {
      const block = guardWrite("create_psy_assignment");
      if (block) return block;
      const { data, error } = await supabase
        .from("psy_assignments")
        .insert({ candidate_id, lang, status: "pending" })
        .select("id,token,lang,status,created_at")
        .maybeSingle();
      if (error) return err(error.message);
      return ok(data ?? { created: true });
    },
  );

  registerTool(
    "list_psy_items",
    {
      title: "List psychometric items for a language",
      description: "Reads psy_items table for a given language. Returns the questions used by the candidate test wizard.",
      inputSchema: { lang: z.string().default("en") },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ lang }) => {
      const { data, error } = await supabase.from("psy_items").select("*").eq("lang", lang);
      if (error) return err(error.message);
      return ok({ count: data?.length ?? 0, items: data ?? [] });
    },
  );

  registerTool(
    "get_psy_submission",
    {
      title: "Get a psy submission by token",
      description:
        "Reads the submission row by token (the URL token sent to candidates). Returns answers, status, scores.",
      inputSchema: { token: z.string() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ token }) => {
      const { data, error } = await supabase
        .from("psy_assignments")
        .select("*, submissions:submissions(*)")
        .eq("token", token)
        .maybeSingle();
      if (error) return err(error.message);
      if (!data) return err(`No psy assignment found for token ${token}.`);
      return ok(data);
    },
  );

  registerTool(
    "psy_score",
    {
      title: "Score a psy submission via Azure",
      description:
        "Calls `psy-score` edge function. Submits answers to the external Azure scorer and stores the result.",
      inputSchema: {
        submission_id: z.string().uuid().describe("submissions.id"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ submission_id }) => {
      const result = await invokeEdge("psy-score", { submissionId: submission_id });
      return ok(result);
    },
  );
}
