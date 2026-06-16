import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../supabase.js";
import { invokeEdge } from "../edge.js";
import { ok, err, guardWrite, authedRegisterTool } from "../util.js";

export function registerEmilyTools(server: McpServer): void {
  const registerTool = authedRegisterTool(server);
  registerTool(
    "emily_chat",
    {
      title: "Draft an Emily outreach message for a candidate",
      description:
        "Calls `emily-chat`: Emily DRAFTS a recruiter outreach message (WhatsApp or email) for a candidate, in the " +
        "enterprise's configured tone. (This is message generation, not a chat-reply loop.) Pass candidate_id and the " +
        "tool fills name / title / location / skills / role from the candidate row and JD; or pass candidate_name " +
        "directly. Returns { message, subject }. enterprise_id (for the Emily tone) is derived from the candidate.",
      inputSchema: {
        candidate_id: z.string().uuid().optional().describe("Derive the candidate's name + context from their row."),
        candidate_name: z.string().optional().describe("Required if candidate_id is not given."),
        job_title: z.string().optional().describe("Role offered; defaults to the candidate's JD title."),
        channel: z.enum(["whatsapp", "email"]).optional().default("whatsapp"),
        language: z.string().optional().describe("2-letter code (en, fr, …). Defaults to the enterprise default."),
        enterprise_id: z.string().uuid().optional().describe("For the Emily tone; derived from the candidate if omitted."),
      },
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async ({ candidate_id, candidate_name, job_title, channel, language, enterprise_id }) => {
      let name = candidate_name;
      let title: string | undefined;
      let location: string | undefined;
      let skills: string[] | undefined;
      let jobTitle = job_title;
      let entId = enterprise_id;
      if (candidate_id) {
        const { data: cand } = await db()
          .from("candidates")
          .select("candidate_name,job_title,location,enterprise_id,job_description_id,matching_skills")
          .eq("id", candidate_id)
          .maybeSingle();
        const c = cand as Record<string, any> | null;
        if (c) {
          name = name ?? c.candidate_name;
          title = c.job_title ?? undefined;
          location = c.location ?? undefined;
          entId = entId ?? c.enterprise_id;
          skills = Array.isArray(c.matching_skills) ? c.matching_skills : undefined;
          if (!jobTitle && c.job_description_id) {
            const { data: jd } = await db()
              .from("job_descriptions")
              .select("job_title")
              .eq("id", c.job_description_id)
              .maybeSingle();
            jobTitle = (jd as Record<string, any> | null)?.job_title ?? undefined;
          }
        }
      }
      if (!name) return err("Provide candidate_id (to look up the name) or candidate_name.");
      const result = await invokeEdge("emily-chat", {
        candidateName: name,
        candidateTitle: title,
        candidateLocation: location,
        candidateSkills: skills,
        jobTitle,
        channel,
        language,
        enterpriseId: entId,
      });
      return ok(result);
    },
  );

  registerTool(
    "emily_analyze",
    {
      title: "Emily — analyze a piece of text",
      description:
        "Calls `emily-analyze` edge function. Used for sentiment / intent / category classification of a candidate message.",
      inputSchema: { text: z.string().min(1) },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ text }) => {
      const result = await invokeEdge("emily-analyze", { text });
      return ok(result);
    },
  );

  registerTool(
    "emily_score_screening",
    {
      title: "Emily — score a candidate's screening answers",
      description:
        "Calls `emily-score-screening` edge function. Computes a screening score from candidate's chat history.",
      inputSchema: { candidate_id: z.string().uuid() },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ candidate_id }) => {
      const result = await invokeEdge("emily-score-screening", { candidateId: candidate_id });
      return ok(result);
    },
  );

  registerTool(
    "send_whatsapp",
    {
      title: "Message / first-contact a candidate on WhatsApp",
      description:
        "✅ THE tool to MESSAGE or CONTACT a candidate. Use it whenever the user asks to 'send a message', 'contact', " +
        "'reach out to', 'relancer' or 'do first contact' for a candidate — that always means this WhatsApp send. " +
        "Calls the `send-whatsapp` edge (Twilio). ⚠️ Sends a REAL message — costs money and the candidate sees it. " +
        "FIRST CONTACT IS AUTOMATIC: on the first message to a candidate, WhatsApp forbids free text, so the edge sends " +
        "the enterprise's APPROVED template — your `message` is ignored then and only delivered once the candidate has " +
        "REPLIED (24h session open). So `message` is OPTIONAL: to just trigger first contact, call with ONLY " +
        "`candidate_id`. enterprise_id + recipient phone are derived from the candidate row (pass enterprise_id / to to " +
        "override). Do NOT pass channel/language/job_title/subject — they aren't params. After a successful send a DB " +
        "trigger moves the candidate to Accepted/waiting.",
      inputSchema: {
        candidate_id: z.string().uuid(),
        message: z
          .string()
          .optional()
          .describe(
            "Free-text body. OPTIONAL — ignored on first contact (the approved template is sent instead), and only " +
              "delivered once the candidate has replied within the 24h window. Omit it to just do first contact.",
          ),
        enterprise_id: z.string().uuid().optional().describe("Override; defaults to the candidate's enterprise_id."),
        to: z.string().optional().describe("Override recipient phone; defaults to the candidate's telephone[0]."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ candidate_id, message, enterprise_id, to }) => {
      const block = guardWrite("send_whatsapp");
      if (block) return block;
      const { data: cand, error: cErr } = await db()
        .from("candidates")
        .select("id,candidate_name,enterprise_id,telephone,job_description_id,job_title")
        .eq("id", candidate_id)
        .maybeSingle();
      if (cErr) return err(cErr.message);
      if (!cand) return err(`Candidate ${candidate_id} not found.`);
      const c = cand as Record<string, any>;
      const entId = enterprise_id ?? c.enterprise_id;
      const phone = to ?? (Array.isArray(c.telephone) ? c.telephone[0] : c.telephone);
      if (!entId) return err("Could not resolve the candidate's enterprise_id — pass enterprise_id explicitly.");
      if (!phone) return err("Candidate has no phone number; enrich it first or pass `to` explicitly.");
      const result = await invokeEdge("send-whatsapp", {
        enterpriseId: entId,
        candidateId: candidate_id,
        to: phone,
        body: message, // the edge's free-text field is `body`, not `message`
        candidateName: c.candidate_name ?? undefined,
        jobDescriptionId: c.job_description_id ?? undefined,
        jobTitle: c.job_title ?? undefined,
      });
      return ok(result);
    },
  );

  registerTool(
    "list_whatsapp_messages",
    {
      title: "List WhatsApp messages for a candidate",
      description: "Reads from whatsapp_messages table, newest first.",
      inputSchema: {
        candidate_id: z.string().uuid(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ candidate_id, limit }) => {
      const { data, error } = await db()
        .from("whatsapp_messages")
        .select("id,direction,body,status,sent_at,twilio_sid")
        .eq("candidate_id", candidate_id)
        .order("sent_at", { ascending: false })
        .limit(limit);
      if (error) return err(error.message);
      return ok({ count: data?.length ?? 0, messages: data ?? [] });
    },
  );

  registerTool(
    "list_wa_contacts",
    {
      title: "List WhatsApp contacts (wa_contacts table)",
      description:
        "Reads wa_contacts — the per-phone candidate state for WhatsApp conversations (stage, language, opt-out, etc.).",
      inputSchema: {
        enterprise_id: z.string().uuid().optional(),
        job_description_id: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ enterprise_id, job_description_id, limit }) => {
      let q = db()
        .from("wa_contacts")
        .select("id,phone,candidate_id,job_description_id,conversation_stage,language,opt_out")
        .limit(limit);
      if (enterprise_id) q = q.eq("enterprise_id", enterprise_id);
      if (job_description_id) q = q.eq("job_description_id", job_description_id);
      const { data, error } = await q;
      if (error) return err(error.message);
      return ok({ count: data?.length ?? 0, contacts: data ?? [] });
    },
  );

  registerTool(
    "generate_writer",
    {
      title: "Draft an outreach email for a candidate (cold / follow-up)",
      description:
        "Calls the `generate-writer` edge function: generates a personalized outreach email (cold_email | followup | " +
        "custom) for a candidate and PERSISTS it (outreach_samples/history). Returns a flat { success, text, model, " +
        "tokensUsed, cost, messageVersion, sampleId }. Requires candidate_id, candidate_name, enterprise_id. " +
        "Server-side it needs NVIDIA_NIM_API_KEY + SUPABASE_DB_URL (else 5xx). Costs LLM credits and writes rows, so " +
        "it honors TC_MCP_READONLY.",
      inputSchema: {
        candidate_id: z.string().uuid(),
        candidate_name: z.string(),
        enterprise_id: z.string().uuid(),
        job_title: z.string().optional(),
        company_name: z.string().optional(),
        context: z.string().optional().describe("Extra context to ground the email."),
        content_type: z.enum(["cold_email", "followup", "custom"]).optional().default("cold_email"),
        max_tokens: z.number().int().min(50).max(2000).optional().default(500),
        language: z.string().optional().describe("en, fr, de, es (default en)."),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (a) => {
      const block = guardWrite("generate_writer");
      if (block) return block;
      const res = await invokeEdge("generate-writer", {
        candidateId: a.candidate_id,
        candidateName: a.candidate_name,
        enterpriseId: a.enterprise_id,
        jobTitle: a.job_title,
        companyName: a.company_name,
        context: a.context,
        contentType: a.content_type,
        maxTokens: a.max_tokens,
        language: a.language,
      });
      return ok(res);
    },
  );
}
