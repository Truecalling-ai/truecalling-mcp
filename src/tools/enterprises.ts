import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { supabase } from "../supabase.js";
import { ok, err, authedRegisterTool } from "../util.js";

export function registerEnterprisesTools(server: McpServer): void {
  const registerTool = authedRegisterTool(server);
  registerTool(
    "get_my_enterprise",
    {
      title: "Get the authenticated user's enterprise",
      description:
        "Resolves the enterprise row for the user behind the current JWT (via enterprises_team.auth_user_id). " +
        "Useful as the first call to grab enterprise_id for subsequent queries.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      const { data: userData } = await supabase.auth.getUser();
      const authUserId = userData.user?.id;
      if (!authUserId) return err("No authenticated user.");
      const { data: member, error: memberErr } = await supabase
        .from("enterprises_team")
        .select("id,enterprise_id,role,full_name,email")
        .eq("auth_user_id", authUserId)
        .maybeSingle();
      if (memberErr) return err(memberErr.message);
      if (!member) return err("Authenticated user is not a member of any enterprise.");
      const { data: enterprise, error: entErr } = await supabase
        .from("enterprises")
        .select("*")
        .eq("id", member.enterprise_id)
        .maybeSingle();
      if (entErr) return err(entErr.message);
      return ok({ membership: member, enterprise });
    },
  );

  registerTool(
    "list_team_members",
    {
      title: "List team members of an enterprise",
      description: "Reads enterprises_team for the given enterprise_id.",
      inputSchema: { enterprise_id: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ enterprise_id }) => {
      const { data, error } = await supabase
        .from("enterprises_team")
        .select("id,full_name,email,role,auth_user_id")
        .eq("enterprise_id", enterprise_id);
      if (error) return err(error.message);
      return ok({ count: data?.length ?? 0, members: data ?? [] });
    },
  );

  registerTool(
    "get_enterprise_config",
    {
      title: "Get enterprise configuration",
      description:
        "Returns the enterprise's configuration block: emily tone, company context, WhatsApp from, country, logo, admin emails.",
      inputSchema: { enterprise_id: z.string().uuid() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ enterprise_id }) => {
      const { data, error } = await supabase
        .from("enterprises")
        .select(
          "id,enterprise_name,country,logo,whatsapp_from,emily_tone,emily_company_context,adm_company,adm_tc,email_suffix",
        )
        .eq("id", enterprise_id)
        .maybeSingle();
      if (error) return err(error.message);
      if (!data) return err(`Enterprise ${enterprise_id} not found.`);
      return ok(data);
    },
  );
}
