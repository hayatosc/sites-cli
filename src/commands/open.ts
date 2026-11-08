// `sites open` and `sites delete` (plan §4).

import { spawn } from "node:child_process";
import type { CommandResult, DefineCommand } from "../types.ts";
import type { SiteRecord } from "../api-types.ts";
import { readManifest, resolveProjectRef, writeManifest } from "../manifest.ts";
import { CliError, EXIT } from "../errors.ts";
import { stringOption } from "../util.ts";
import { confirmDestructive } from "../prompt.ts";

function siteUrl(site: SiteRecord): string | null {
  const candidate =
    site.url ?? site.current_live_url ?? site.expected_url ?? site.current_preview_url;
  return candidate ?? null;
}

function withPath(base: string, suffix: string | undefined): string {
  if (!suffix) return base;
  const extra = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return new URL(extra, base).toString();
}

function launch(url: string): boolean {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

interface OpenData {
  project_id: string;
  url: string;
  opened: boolean;
  printed: boolean;
}

export function registerOpenDeleteCommands(define: DefineCommand): void {
  define({
    path: ["open"],
    flags: ["path", "print"],
    positionals: { min: 0, max: 1, names: ["project_id|slug"] },
    summary: "Open the site in a browser",
    usage: "sites open [<project_id|slug>] [--path /foo] [--print]",
    run: async (ctx): Promise<CommandResult<OpenData>> => {
      const projectId = await resolveProjectRef(ctx.positionals[0], ctx.mcp(), ctx.root);
      const site = await ctx
        .mcp()
        .callTool<SiteRecord>("sites.get_site", { project_id: projectId });
      const base = siteUrl(site);
      if (!base) {
        throw new CliError("NOT_FOUND_URL", "The site has no URL yet.", {
          exitCode: EXIT.PREFLIGHT,
          hint: "Deploy the site first, or add a custom domain.",
        });
      }
      const url = withPath(base, stringOption(ctx.options, "path"));
      const printed = Boolean(ctx.options.print);
      const opened = printed ? false : launch(url);
      return {
        data: { project_id: projectId, url, opened, printed },
        raw: printed ? url + "\n" : undefined,
        human: (value) => {
          ctx.stdout.write(value.url + "\n");
        },
      };
    },
  });

  define({
    path: ["delete"],
    flags: ["yes", "force"],
    positionals: { min: 0, max: 1, names: ["project_id|slug"] },
    summary: "Delete a site permanently",
    usage: "sites delete [<project_id|slug>] [--force]",
    run: async (ctx): Promise<CommandResult<{ project_id: string; was_deleted: boolean }>> => {
      const projectId = await resolveProjectRef(ctx.positionals[0], ctx.mcp(), ctx.root);
      const site = await ctx
        .mcp()
        .callTool<SiteRecord>("sites.get_site", { project_id: projectId });
      const label = site.slug ?? projectId;
      if (!(await confirmDestructive(ctx, `site ${label}`, Boolean(ctx.options.force)))) {
        throw new CliError("CANCELLED", "Delete cancelled.", { exitCode: EXIT.INTERRUPT });
      }
      const result = await ctx
        .mcp()
        .callTool<{ project_id?: string; was_deleted?: boolean }>("sites.delete_site", {
          project_id: projectId,
        });
      try {
        const manifest = readManifest(ctx.root).manifest;
        if (manifest.project_id === projectId) {
          writeManifest(ctx.root, { ...manifest, project_id: null });
        }
      } catch {
        // No local manifest: nothing to clear.
      }
      ctx.success(`Deleted site ${result.project_id ?? projectId}`);
      return {
        data: {
          project_id: result.project_id ?? projectId,
          was_deleted: Boolean(result.was_deleted),
        },
        human: (value) => {
          ctx.stdout.write(`Deleted ${value.project_id}.\n`);
        },
      };
    },
  });
}
