import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { invokeEdge } from "../edge.js";
import { ok, authedRegisterTool } from "../util.js";

// AI analysis / generation tools. Each wraps one truecalling-app edge function
// that returns a `{ result: ... }` envelope and has no DB side effects (pure
// generation). They cost LLM credits but mutate nothing, so they stay
// readOnlyHint:true and are not gated by TC_MCP_READONLY.
export function registerAnalysisTools(server: McpServer): void {
  const registerTool = authedRegisterTool(server);

  registerTool(
    "generate_interview_questions",
    {
      title: "Generate interview questions for a candidate × role",
      description:
        "Calls the `generate-interview-questions` edge function: from a job title + an EXISTING compatibility score + " +
        "matching/missing skills, returns a structured interview-prep plan { behavioralQuestions, technicalQuestions, " +
        "recruiterFocusAreas }. It does NOT recompute the score — pass one from score_candidate/compare_jd_candidate. " +
        "Write the language to match the role/candidate, not the chat.",
      inputSchema: {
        job_title: z.string().describe("The role being interviewed for."),
        score: z.number().min(0).max(100).optional().describe("Existing compatibility score (0-100)."),
        candidate_name: z.string().optional(),
        matching_skills: z.array(z.string()).optional().default([]),
        missing_skills: z.array(z.string()).optional().default([]),
        language: z.string().optional().describe("2-letter code (en, fr, …). Defaults to the role language."),
        provider: z.string().optional().describe("LLM provider override (default openai)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async ({ job_title, score, candidate_name, matching_skills, missing_skills, language, provider }) => {
      const res = await invokeEdge<{ result?: unknown }>("generate-interview-questions", {
        jobTitle: job_title,
        score,
        candidateName: candidate_name,
        matchingSkills: matching_skills,
        missingSkills: missing_skills,
        language,
        provider,
      });
      return ok(res?.result ?? res);
    },
  );

  registerTool(
    "analyze_cv_standalone",
    {
      title: "Analyze a CV on its own (no JD needed)",
      description:
        "Calls the `analyze-cv-standalone` edge function: evaluates a CV's intrinsic quality (score, skills, soft " +
        "skills, gaps, improvement points, work history, total years) plus deterministic resilience & " +
        "digital-reputation scores — no job description required. Useful to vet a raw CV before create_candidate. " +
        "cv_content may be plain text or a structured CV object.",
      inputSchema: {
        cv_content: z
          .union([z.string(), z.record(z.unknown())])
          .describe("Raw CV text, or a structured CV object."),
        language: z.string().optional(),
        provider: z.string().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async ({ cv_content, language, provider }) => {
      const res = await invokeEdge<{ result?: unknown }>("analyze-cv-standalone", {
        cvContent: cv_content,
        language,
        provider,
      });
      return ok(res?.result ?? res);
    },
  );

  registerTool(
    "generate_score_explanation",
    {
      title: "Explain an existing candidate score in plain language",
      description:
        "Calls the `generate-score-explanation` edge function: writes a narrative explanation of an ALREADY-computed " +
        "score (it does not recalculate). compatibility_score is required; the more context you pass (summary, " +
        "strengths/weaknesses, recommendation), the better the explanation. Pairs with score_candidate.",
      inputSchema: {
        compatibility_score: z.number().min(0).max(100),
        resilience_score: z.number().optional(),
        digital_reputation_score: z.number().optional(),
        comparison_summary: z.string().optional(),
        strengths: z.array(z.string()).optional().default([]),
        weaknesses: z.array(z.string()).optional().default([]),
        recommendation: z.string().optional(),
        job_title: z.string().optional(),
        candidate_name: z.string().optional(),
        language: z.string().optional(),
        provider: z.string().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async (a) => {
      const res = await invokeEdge<{ result?: unknown }>("generate-score-explanation", {
        compatibilityScore: a.compatibility_score,
        resilienceScore: a.resilience_score,
        digitalReputationScore: a.digital_reputation_score,
        comparisonSummary: a.comparison_summary,
        strengths: a.strengths,
        weaknesses: a.weaknesses,
        recommendation: a.recommendation,
        jobTitle: a.job_title,
        candidateName: a.candidate_name,
        language: a.language,
        provider: a.provider,
      });
      return ok(res?.result ?? res);
    },
  );

  registerTool(
    "interpret_psychometric",
    {
      title: "Interpret a candidate's psychometric profile",
      description:
        "Calls the `interpret-psychometric` edge function: turns a psychometric profile (dream job, motivations, " +
        "competencies, CV gaps) into { profileSummary, careerAlignment, keyStrengths, developmentAreas, " +
        "suggestedRoles, actionPlan }. Complements psy_score (which produces the raw scores).",
      inputSchema: {
        dream_job: z.string().optional(),
        motivations: z.array(z.unknown()).optional().describe("Only the first 5 are used."),
        competencies: z.array(z.unknown()).optional().describe("Only the first 5 are used."),
        cv_gaps: z.array(z.unknown()).optional(),
        language: z.string().optional(),
        provider: z.string().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async ({ dream_job, motivations, competencies, cv_gaps, language, provider }) => {
      const res = await invokeEdge<{ result?: unknown }>("interpret-psychometric", {
        dreamjob: dream_job,
        motivations,
        competencies,
        cvGaps: cv_gaps,
        language,
        provider,
      });
      return ok(res?.result ?? res);
    },
  );
}
