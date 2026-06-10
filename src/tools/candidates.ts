import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { supabase } from "../supabase.js";
import { invokeEdge } from "../edge.js";
import { ok, err, guardWrite, authedRegisterTool } from "../util.js";

const CANDIDATE_COLUMNS =
  "id,candidate_name,email,telephone,linkedin,linkedin_url,location,country,job_title," +
  "status,compatibility_score,jd_match_score,matching_skills,missing_skills," +
  "job_description_id,enterprise_id,needs_enrichment,profile_pic,created_at,updated_at";

// Port of the app's fullenrichService.normalizeLinkedIn — used as the dedupe
// key (linkedin_norm) so a profile saved via the MCP collides with the same
// person saved from the web app.
function normalizeLinkedIn(input: string): string {
  let s = (input || "").trim().replace(/^@/, "").split("?")[0].replace(/\/+$/, "");
  if (!s) return "";
  if (/^\/in\//i.test(s)) s = `https://www.linkedin.com${s}`;
  if (/linkedin\.com/i.test(s) && !/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, "")}`;
  s = s.replace(/^https?:\/\/(www\.)?linkedin\.com/i, "https://www.linkedin.com");
  const m = s.match(/^(https:\/\/www\.linkedin\.com\/in\/[^/?#]+)/i);
  return m ? m[1] : s;
}

// Resolve the caller's enterprise from enterprises_team (same source as
// get_my_enterprise). Returns null id when ambiguous so the tool can ask for
// an explicit enterprise_id.
async function resolveEnterpriseId(): Promise<{ id?: string; error?: string }> {
  const { data: userData } = await supabase.auth.getUser();
  const authUserId = userData.user?.id;
  if (!authUserId) return { error: "No authenticated user." };
  const { data: members, error } = await supabase
    .from("enterprises_team")
    .select("enterprise_id")
    .eq("auth_user_id", authUserId);
  if (error) return { error: error.message };
  const ids = [...new Set((members ?? []).map((m) => m.enterprise_id))];
  if (ids.length === 0) return { error: "Your account is not a member of any enterprise." };
  if (ids.length > 1)
    return { error: "You belong to multiple enterprises — pass enterprise_id explicitly (see get_my_enterprise)." };
  return { id: ids[0] };
}

export function registerCandidatesTools(server: McpServer): void {
  const registerTool = authedRegisterTool(server);

  registerTool(
    "create_candidate",
    {
      title: "Create / import a candidate (e.g. a sourced LinkedIn profile)",
      description:
        "Insert a NEW candidate into api.candidates — the missing step that turns a sourced FullEnrich/LinkedIn " +
        "profile into a real pipeline candidate you can then enrich_candidate, score_candidate, emily_chat and " +
        "send_whatsapp. Mirrors the web app's 'add to pipeline' insert. Only candidate_name is required " +
        "(enterprise_id defaults to your enterprise). Link it to a job with job_description_id. " +
        "Deduplicates by normalized LinkedIn within the enterprise: if the person is already in the pipeline it " +
        "returns the existing id (created:false) instead of making a duplicate. Returns the candidate id.",
      inputSchema: {
        candidate_name: z.string().min(1),
        enterprise_id: z.string().uuid().optional().describe("Defaults to your enterprise if omitted."),
        job_description_id: z.string().uuid().optional().describe("JD to attach this candidate to."),
        linkedin_url: z.string().optional(),
        job_title: z.string().optional(),
        location: z.string().optional(),
        current_company: z.string().optional(),
        email: z.string().optional(),
        telephone: z.array(z.string()).optional(),
        status: z.string().optional().default("sourced"),
        source: z.string().optional().default("mcp"),
        extra: z
          .record(z.unknown())
          .optional()
          .describe("Any extra candidate columns (e.g. compatibility_score, matching_skills)."),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({
      candidate_name,
      enterprise_id,
      job_description_id,
      linkedin_url,
      job_title,
      location,
      current_company,
      email,
      telephone,
      status,
      source,
      extra,
    }) => {
      const block = guardWrite("create_candidate");
      if (block) return block;

      let entId = enterprise_id;
      if (!entId) {
        const r = await resolveEnterpriseId();
        if (r.error) return err(r.error);
        entId = r.id;
      }

      const liNorm = linkedin_url ? normalizeLinkedIn(linkedin_url) : "";

      // Dedupe by LinkedIn within the enterprise (the app does the same).
      if (liNorm) {
        const { data: dup } = await supabase
          .from("candidates")
          .select("id")
          .eq("enterprise_id", entId)
          .eq("linkedin_norm", liNorm)
          .maybeSingle();
        const dupId = (dup as { id?: string } | null)?.id;
        if (dupId)
          return ok({
            id: dupId,
            created: false,
            note: "A candidate with this LinkedIn already exists for the enterprise — returning the existing id.",
          });
      }

      const row: Record<string, unknown> = {
        candidate_name,
        enterprise_id: entId,
        job_description_id: job_description_id ?? null,
        linkedin_url: linkedin_url ?? null,
        linkedin: linkedin_url ?? null,
        linkedin_norm: liNorm || null,
        job_title: job_title ?? null,
        location: location ?? null,
        current_company: current_company ?? null,
        email: email ?? null,
        telephone: telephone && telephone.length ? telephone : null,
        status: status ?? "sourced",
        source: source ?? "mcp",
        ...(extra ?? {}),
      };
      const { data, error } = await supabase.from("candidates").insert(row).select(CANDIDATE_COLUMNS).maybeSingle();
      if (error) return err(error.message);
      const created = data as { id?: string } | null;
      return ok({ id: created?.id, created: true, candidate: created });
    },
  );

  registerTool(
    "list_candidates",
    {
      title: "List candidates",
      description:
        "List TrueCalling candidates filtered by job_description_id, status, search query, or with pagination. " +
        "Returns id, candidate_name, email, status, compatibility_score, JD link, etc. " +
        "Respects RLS — only candidates the authenticated user can see are returned.",
      inputSchema: {
        job_description_id: z.string().uuid().optional().describe("Filter by JD UUID"),
        status: z.string().optional().describe("Pipeline status (e.g. 'new', 'screening', 'interview', 'hired')"),
        search: z.string().optional().describe("Substring match on candidate_name OR job_title (ilike %search%)"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ job_description_id, status, search, limit, offset }) => {
      let q = supabase.from("candidates").select(CANDIDATE_COLUMNS).range(offset, offset + limit - 1);
      if (job_description_id) q = q.eq("job_description_id", job_description_id);
      if (status) q = q.eq("status", status);
      if (search) {
        // Search name AND job_title so e.g. "SAP" matches "Consultant SAP" even
        // when it isn't in the candidate's name. .or() takes a raw filter string
        // with no value parameterization, so strip the chars that are structural
        // in PostgREST filters to avoid breaking/altering the query.
        const term = search.replace(/[,()*\\]/g, "").trim();
        q = q.or(`candidate_name.ilike.%${term}%,job_title.ilike.%${term}%`);
      }
      const { data, error } = await q;
      if (error) return err(error.message);
      return ok({ count: data?.length ?? 0, candidates: data ?? [] });
    },
  );

  registerTool(
    "get_candidate",
    {
      title: "Get candidate by id",
      description:
        "Fetch one candidate with full detail (CV analysis, fullenrich_contact, scores). " +
        "Returns null if not found or RLS hides the row.",
      inputSchema: { id: z.string().uuid().describe("Candidate UUID") },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ id }) => {
      const { data, error } = await supabase.from("candidates").select("*").eq("id", id).maybeSingle();
      if (error) return err(error.message);
      if (!data) return err(`Candidate ${id} not found (or hidden by RLS). Try list_candidates() first.`);
      return ok(data);
    },
  );

  registerTool(
    "update_candidate",
    {
      title: "Update candidate fields",
      description:
        "Partial update on a candidate row. Pass only the fields to change in `patch`. " +
        "Common fields: email, telephone, linkedin_url, location, job_title, status, needs_enrichment, candidate_name. " +
        "Persisted in Supabase — visible immediately in the TrueCalling UI.",
      inputSchema: {
        id: z.string().uuid(),
        patch: z.record(z.unknown()).describe("Object with the column→value pairs to update"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ id, patch }) => {
      const block = guardWrite("update_candidate");
      if (block) return block;
      const { data, error } = await supabase.from("candidates").update(patch).eq("id", id).select().maybeSingle();
      if (error) return err(error.message);
      return ok(data ?? { id, updated: true });
    },
  );

  registerTool(
    "update_candidate_status",
    {
      title: "Move candidate in pipeline",
      description:
        "Update the pipeline status of a candidate (kanban column). " +
        "Common statuses: 'new', 'screening', 'interview', 'offer', 'hired', 'rejected'.",
      inputSchema: {
        id: z.string().uuid(),
        status: z.string().describe("New pipeline status"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ id, status }) => {
      const block = guardWrite("update_candidate_status");
      if (block) return block;
      const { data, error } = await supabase
        .from("candidates")
        .update({ status })
        .eq("id", id)
        .select("id,status")
        .maybeSingle();
      if (error) return err(error.message);
      return ok(data ?? { id, status });
    },
  );

  registerTool(
    "delete_candidate",
    {
      title: "Soft-delete a candidate",
      description:
        "Soft-delete: marks the candidate as deleted/archived. Reversible by an admin in Supabase. " +
        "If a hard delete is needed, do it directly in Supabase Studio.",
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ id }) => {
      const block = guardWrite("delete_candidate");
      if (block) return block;
      const { data, error } = await supabase
        .from("candidates")
        .update({ status: "deleted" })
        .eq("id", id)
        .select("id,status")
        .maybeSingle();
      if (error) return err(error.message);
      return ok(data ?? { id, deleted: true });
    },
  );

  registerTool(
    "score_candidate",
    {
      title: "AI-score a candidate against their JD",
      description:
        "Re-runs the AI scoring pipeline (calls `score-candidate` edge function). " +
        "Updates compatibility_score, jd_match_score, matching_skills, missing_skills in DB. " +
        "Costs OpenAI tokens; ~5-15s latency.",
      inputSchema: { id: z.string().uuid().describe("Candidate UUID") },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ id }) => {
      const block = guardWrite("score_candidate");
      if (block) return block;
      const result = await invokeEdge("score-candidate", { candidateId: id });
      return ok(result);
    },
  );

  registerTool(
    "enrich_candidate",
    {
      title: "Enrich a candidate via FullEnrich",
      description:
        "Runs FullEnrich enrichment (email/phone discovery) for ONE candidate by id, then stores the result on the " +
        "candidate (email, telephone, fullenrich_contact). Consumes FullEnrich credits ($). Uses the user-callable " +
        "`fullenrich-proxy` enrich path — NOT the service-role `sweep-enrich-candidates` cron (which 401s for users).",
      inputSchema: {
        id: z.string().uuid(),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(180)
          .default(90)
          .describe("How long to poll FullEnrich for the result before returning."),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ id, wait_seconds }) => {
      const block = guardWrite("enrich_candidate");
      if (block) return block;
      const { data: cand, error: cErr } = await supabase
        .from("candidates")
        .select("id,candidate_name,linkedin_url,linkedin_norm,linkedin")
        .eq("id", id)
        .maybeSingle();
      if (cErr) return err(cErr.message);
      if (!cand) return err(`Candidate ${id} not found.`);
      const linkedin = cand.linkedin_url || cand.linkedin_norm || cand.linkedin;
      if (!linkedin) return err("Candidate has no LinkedIn URL to enrich.");

      const start = (await invokeEdge("fullenrich-proxy", {
        action: "enrich_start",
        body: {
          name: "TrueCalling MCP enrichment",
          data: [
            {
              linkedin_url: linkedin,
              enrich_fields: ["contact.work_emails", "contact.personal_emails", "contact.phones"],
              custom: {},
            },
          ],
        },
      })) as any;
      const sr = start?.result ?? start;
      const enrichmentId = sr?.enrichment_id ?? sr?.id;
      if (!enrichmentId) return err(`FullEnrich returned no enrichment_id: ${JSON.stringify(start).slice(0, 200)}`);

      const deadline = Date.now() + wait_seconds * 1000;
      let contact: Record<string, unknown> = {};
      let status = "";
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        const poll = (await invokeEdge("fullenrich-proxy", {
          action: "enrich_poll",
          enrichId: enrichmentId,
          forceResults: true,
        })) as any;
        const d = poll?.result ?? poll ?? {};
        status = d.status ?? d.enrichment_status ?? "";
        const datas = Array.isArray(d.data) ? d.data : Array.isArray(d.datas) ? d.datas : [];
        const ci = datas[0]?.contact_info ?? datas[0]?.contact ?? {};
        const emails = [...(ci.work_emails ?? []), ...(ci.personal_emails ?? []), ...(ci.emails ?? [])]
          .map((e: any) => e?.email ?? e)
          .filter(Boolean);
        const phones = [...(ci.phones ?? []), ...(ci.mobile_phones ?? [])]
          .map((ph: any) => ph?.number ?? ph)
          .filter(Boolean);
        if (emails.length || phones.length) {
          contact = {
            work_email: ci.most_probable_work_email?.email ?? null,
            personal_email: ci.most_probable_personal_email?.email ?? null,
            phone: ci.most_probable_phone?.number ?? null,
            all_emails: [...new Set(emails)],
            all_phones: [...new Set(phones)],
            raw: ci,
          };
          break;
        }
        if (/finished|done|complete/i.test(String(status))) break;
      }

      const email = (contact.work_email ?? contact.personal_email ?? null) as string | null;
      const phones = (contact.all_phones ?? []) as string[];
      if (email || phones.length) {
        const { error: uErr } = await supabase
          .from("candidates")
          .update({
            ...(email ? { email } : {}),
            ...(phones.length ? { telephone: phones } : {}),
            fullenrich_contact: contact.raw ?? contact,
            needs_enrichment: false,
          })
          .eq("id", id);
        if (uErr)
          return ok({ candidate_id: id, enrichment_id: enrichmentId, status, contact, db_update_error: uErr.message });
      }
      return ok({ candidate_id: id, enrichment_id: enrichmentId, status, contact });
    },
  );

  registerTool(
    "extract_cv",
    {
      title: "Extract structured data from a CV URL",
      description:
        "Calls `extract-cv` edge function. Input: a public URL to a PDF/image CV (or base64). " +
        "Returns structured CV (name, contact, experience, skills, education).",
      inputSchema: {
        cv_url: z.string().url().optional().describe("Public URL to the CV file"),
        cv_base64: z.string().optional().describe("Base64-encoded CV content (alternative to cv_url)"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ cv_url, cv_base64 }) => {
      if (!cv_url && !cv_base64) return err("Provide either cv_url or cv_base64");
      const result = await invokeEdge("extract-cv", { cvUrl: cv_url, cvBase64: cv_base64 });
      return ok(result);
    },
  );

  registerTool(
    "parse_cv_file",
    {
      title: "Parse a CV file (multipart-like payload)",
      description:
        "Calls `parse-cv-file` edge function. Pass a public storage URL or base64. " +
        "Difference with extract_cv: this one does OCR + parsing in one go (PDF/JPG/PNG).",
      inputSchema: {
        file_url: z.string().url().optional(),
        file_base64: z.string().optional(),
        filename: z.string().optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ file_url, file_base64, filename }) => {
      if (!file_url && !file_base64) return err("Provide either file_url or file_base64");
      const result = await invokeEdge("parse-cv-file", { fileUrl: file_url, fileBase64: file_base64, filename });
      return ok(result);
    },
  );

  registerTool(
    "lookup_linkedin_profile",
    {
      title: "Lookup a LinkedIn profile (PDL + Apollo)",
      description:
        "Calls `lookup-linkedin-profile` edge function. Returns full profile " +
        "(employment, education, skills, location, photo) for the given LinkedIn URL. " +
        "Combines People Data Labs + Apollo photo.",
      inputSchema: { linkedin_url: z.string().describe("LinkedIn profile URL (any common format)") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ linkedin_url }) => {
      const result = await invokeEdge("lookup-linkedin-profile", { linkedinUrl: linkedin_url });
      return ok(result);
    },
  );
}
