import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { supabase } from "../supabase.js";
import { invokeEdge } from "../edge.js";
import { ok, err, guardWrite } from "../util.js";

export function registerEmilyTools(server: McpServer): void {
  server.registerTool(
    "emily_chat",
    {
      title: "Chat with Emily (recruiter AI assistant)",
      description:
        "Calls `emily-chat` edge function. Sends a message to Emily and gets her response in the enterprise's configured tone.",
      inputSchema: {
        message: z.string().min(1),
        candidate_id: z.string().uuid().optional().describe("Context: discuss a specific candidate"),
        thread_id: z.string().optional().describe("Continue an existing conversation"),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ message, candidate_id, thread_id }) => {
      const result = await invokeEdge("emily-chat", { message, candidateId: candidate_id, threadId: thread_id });
      return ok(result);
    },
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    "send_whatsapp",
    {
      title: "Send a WhatsApp message to a candidate",
      description:
        "Calls `send-whatsapp` edge function. ⚠️ Sends a REAL message via Twilio — costs money and the candidate will see it.",
      inputSchema: {
        candidate_id: z.string().uuid(),
        message: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ candidate_id, message }) => {
      const block = guardWrite("send_whatsapp");
      if (block) return block;
      const result = await invokeEdge("send-whatsapp", { candidateId: candidate_id, message });
      return ok(result);
    },
  );

  server.registerTool(
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
      const { data, error } = await supabase
        .from("whatsapp_messages")
        .select("id,direction,body,status,sent_at,twilio_sid")
        .eq("candidate_id", candidate_id)
        .order("sent_at", { ascending: false })
        .limit(limit);
      if (error) return err(error.message);
      return ok({ count: data?.length ?? 0, messages: data ?? [] });
    },
  );

  server.registerTool(
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
      let q = supabase
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
}
