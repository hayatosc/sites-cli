// `sites access` (plan §4).

import type { CommandContext, CommandResult, DefineCommand } from "../types.ts";
import type { SiteRecord } from "../api-types.ts";
import { resolveProjectRef } from "../manifest.ts";
import { CliError, EXIT, usageError } from "../errors.ts";
import { integerOption } from "../args.ts";
import { sleep, stringListOption } from "../util.ts";

type AccessMode = "custom" | "public" | "workspace_all";

interface AccessData {
  project_id: string;
  access_mode: string;
  available_access_modes: string[];
  allowed_user_emails: string[];
}

function targetMode(ctx: CommandContext): AccessMode | null {
  const requested = [
    ctx.options.private ? "custom" : null,
    ctx.options.public ? "public" : null,
    ctx.options.workspace ? "workspace_all" : null,
  ].filter(Boolean) as AccessMode[];
  if (requested.length > 1) {
    throw usageError("USAGE_CONFLICTING_FLAGS", "Choose only one of --private, --public, or --workspace.");
  }
  return requested[0] ?? null;
}

function toData(projectId: string, site: SiteRecord): AccessData {
  return {
    project_id: projectId,
    access_mode: site.access_mode ?? "custom",
    available_access_modes: Array.isArray(site.available_access_modes)
      ? (site.available_access_modes as string[])
      : [],
    allowed_user_emails: Array.isArray(site.allowed_user_emails)
      ? (site.allowed_user_emails as string[])
      : [],
  };
}

export function registerAccessCommands(define: DefineCommand): void {
  define({
    path: ["access", "show"],
    flags: [],
    positionals: { min: 0, max: 0 },
    summary: "Show who can access the site",
    usage: "sites access show",
    run: async (ctx): Promise<CommandResult<AccessData>> => {
      const projectId = await resolveProjectRef(undefined, ctx.mcp(), ctx.root);
      const site = await ctx.mcp().callTool<SiteRecord>("sites.get_site", { project_id: projectId });
      return {
        data: toData(projectId, site),
        human: (value) => {
          ctx.stdout.write(`access: ${value.access_mode}\n`);
          if (value.allowed_user_emails.length) {
            ctx.stdout.write(`allowed emails: ${value.allowed_user_emails.join(", ")}\n`);
          }
          if (value.available_access_modes.length) {
            ctx.stdout.write(`available: ${value.available_access_modes.join(", ")}\n`);
          }
        },
      };
    },
  });

  define({
    path: ["access", "set"],
    flags: ["private", "public", "workspace", "allow-email", "wait", "timeout"],
    positionals: { min: 0, max: 0 },
    summary: "Change the site access mode",
    usage: "sites access set --private|--public|--workspace [--allow-email <addr>]… [--wait] [--timeout 120]",
    run: async (ctx): Promise<CommandResult<AccessData>> => {
      const mode = targetMode(ctx);
      if (!mode) {
        throw usageError("USAGE_MISSING_FLAG", "Pass one of --private, --public, or --workspace.", {
          hint: "Example: sites access set --public",
        });
      }
      const emails = stringListOption(ctx.options, "allow-email");
      if (mode === "public" && emails.length) {
        throw new CliError("USAGE_INVALID_COMBINATION", "--allow-email cannot be combined with --public.", {
          exitCode: EXIT.PREFLIGHT,
          hint: "Public sites are readable by anyone; remove --allow-email.",
        });
      }
      const timeout = integerOption(ctx.options, "timeout", { min: 1, max: 600, fallback: 120 });
      const projectId = await resolveProjectRef(undefined, ctx.mcp(), ctx.root);
      const args: Record<string, unknown> = { project_id: projectId, access_mode: mode };
      if (emails.length) args.allowed_user_emails = emails;
      await ctx.mcp().callTool("sites.update_site_access", args);

      let site = await ctx.mcp().callTool<SiteRecord>("sites.get_site", { project_id: projectId });
      if (ctx.options.wait && site.access_mode !== mode) {
        ctx.log(`waiting for access mode to become ${mode}`);
        const deadline = Date.now() + timeout * 1000;
        while (Date.now() < deadline) {
          await sleep(3000);
          site = await ctx.mcp().callTool<SiteRecord>("sites.get_site", { project_id: projectId });
          if (site.access_mode === mode) break;
        }
        if (site.access_mode !== mode) {
          throw new CliError("ACCESS_TIMEOUT", `Access mode is still ${site.access_mode ?? "unknown"}.`, {
            exitCode: EXIT.NETWORK,
            hint: "Propagation can take 40–60 seconds; retry with a longer --timeout.",
          });
        }
      }
      return {
        data: toData(projectId, site),
        human: (value) => {
          ctx.stdout.write(`access: ${value.access_mode}\n`);
          if (value.access_mode !== mode) {
            ctx.stdout.write(`要求 ${mode} は反映待ちです（40〜60秒）。\n`);
          }
        },
      };
    },
  });
}
