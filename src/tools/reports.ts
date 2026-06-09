import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { invokeEdge } from "../edge.js";
import { ok, guardWrite } from "../util.js";

export function registerReportsTools(server: McpServer): void {
  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    "send_candidate_report",
    {
      title: "Send a candidate report by email",
      description:
        "Calls `send-candidate-report` edge function. ⚠️ Sends a REAL email via SendGrid to recipient_email.",
      inputSchema: {
        candidate_id: z.string().uuid(),
        recipient_email: z.string().email(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ candidate_id, recipient_email }) => {
      const block = guardWrite("send_candidate_report");
      if (block) return block;
      const result = await invokeEdge("send-candidate-report", { candidateId: candidate_id, recipientEmail: recipient_email });
      return ok(result);
    },
  );
}
