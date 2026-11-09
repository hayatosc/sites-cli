// `sites open` and `sites delete` (plan §4).

import { spawnCommand } from "../subprocess.ts";
import type { CommandResult, DefineCommand } from "../types.ts";
import type { SiteRecord } from "../api-types.ts";
import { readManifest, resolveProjectRef, writeManifest, writeState } from "../manifest.ts";
import { CliError, EXIT } from "../errors.ts";
import { stringOption } from "../util.ts";
import { confirmDestructive } from "../prompt.ts";

function siteUrl(site: SiteRecord): string | null {
  const candidate =
    site.url ?? site.current_live_url ?? site.expected_url ?? site.current_preview_url;
  return candidate ?? null;
}

function withPath(base: string, suffix: string | undefined): string {
  const origin = new URL(base);
  const extra = suffix ? (suffix.startsWith("/") ? suffix : `/${suffix}`) : "";
  const target = extra ? new URL(extra, origin) : origin;
  if (!["http:", "https:"].includes(origin.protocol) || target.origin !== origin.origin) {
    throw new CliError(
      "USAGE_INVALID_PATH",
      "The URL must be HTTP(S) and --path must stay on the site's origin.",
      { exitCode: EXIT.USAGE },
    );
  }
  return target.toString();
}

async function launch(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    // Use a native URL handler on Windows, never cmd.exe/start: query-string
    // metacharacters must remain URL data rather than shell instructions.
    const child = spawnCommand(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
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
      const opened = printed ? false : await launch(url);
      if (!printed && !opened)
        throw new CliError("BROWSER_OPEN_FAILED", "Could not start the browser opener.", {
          hint: "Use --print to print the URL without opening a browser.",
        });
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
      const manifest = (() => {
        try {
          return readManifest(ctx.root).manifest;
        } catch {
          return null;
        }
      })();
      if (result.was_deleted && manifest?.project_id === projectId) {
        writeManifest(ctx.root, { ...manifest, project_id: null });
        writeState(ctx.root, {});
      }
      if (result.was_deleted) ctx.success(`Deleted site ${result.project_id ?? projectId}`);
      return {
        data: {
          project_id: result.project_id ?? projectId,
          was_deleted: Boolean(result.was_deleted),
        },
        human: (value) => {
          ctx.stdout.write(
            `${value.was_deleted ? "Deleted" : "Not deleted:"} ${value.project_id}.\n`,
          );
        },
      };
    },
  });
}
