import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../supabase.js";
import { invokeEdge } from "../edge.js";
import { ok, err, guardWrite, authedRegisterTool } from "../util.js";

export function registerReportsTools(server: McpServer): void {
  const registerTool = authedRegisterTool(server);
  registerTool(
    "generate_candidate_pdf",
    {
      title: "Generate a candidate PDF report",
      description:
        "Calls `generate-candidate-pdf` edge function. Builds a PDF profile of the candidate (CV + analysis + scores). Returns a storage URL.",
      inputSchema: { candidate_id: z.string().uuid() },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ candidate_id }) => {
      const block = guardWrite("generate_candidate_pdf");
      if (block) return block;
      const result = await invokeEdge("generate-candidate-pdf", { candidateId: candidate_id });
      return ok(result);
    },
  );

  registerTool(
    "generate_cv",
    {
      title: "Generate a re-formatted CV for a candidate",
      description: "Calls `generate-cv` edge function. Re-builds a clean CV (PDF) from the candidate's parsed data.",
      inputSchema: { candidate_id: z.string().uuid() },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ candidate_id }) => {
      const block = guardWrite("generate_cv");
      if (block) return block;
      const result = await invokeEdge("generate-cv", { candidateId: candidate_id });
      return ok(result);
    },
  );

  registerTool(
    "send_candidate_report",
    {
      title: "Send a candidate report by email",
      description:
        "Calls `send-candidate-report` edge function. ⚠️ Sends a REAL email via SendGrid. The edge needs the report's " +
        "`pdfUrl` — generate it first with generate_candidate_pdf and pass its URL as pdf_url (or pass submission_id to " +
        "resolve the PDF + email + name from a psychometric submission). candidate_id is used only to fill the " +
        "candidate's name in the email.",
      inputSchema: {
        recipient_email: z.string().email(),
        pdf_url: z
          .string()
          .optional()
          .describe("Report PDF URL from generate_candidate_pdf. Required unless submission_id is given."),
        submission_id: z
          .string()
          .optional()
          .describe("Resolve pdf_url + recipient + name from a submission instead of passing pdf_url."),
        candidate_id: z.string().uuid().optional().describe("Used only to fill the candidate name in the email."),
        candidate_name: z.string().optional(),
        language: z.string().optional().describe("Email template language (en, fr, …)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ recipient_email, pdf_url, submission_id, candidate_id, candidate_name, language }) => {
      const block = guardWrite("send_candidate_report");
      if (block) return block;
      if (!pdf_url && !submission_id)
        return err("Provide pdf_url (from generate_candidate_pdf) or submission_id — the report PDF is required.");
      let name = candidate_name;
      if (!name && candidate_id) {
        const { data: cand } = await db()
          .from("candidates")
          .select("candidate_name")
          .eq("id", candidate_id)
          .maybeSingle();
        name = (cand as Record<string, any> | null)?.candidate_name ?? undefined;
      }
      const result = await invokeEdge("send-candidate-report", {
        pdfUrl: pdf_url,
        recipientEmail: recipient_email,
        candidateName: name,
        language,
        submissionId: submission_id,
      });
      return ok(result);
    },
  );
}
