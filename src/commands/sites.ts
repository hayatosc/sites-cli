// `sites list` and `sites info` (plan §4).

import type { CommandResult, DefineCommand } from "../types.ts";
import type {
  CustomDomainRecord,
  ListCustomDomainsResult,
  ListSitesResult,
  ListVersionsResult,
  SiteRecord,
  SiteVersionRecord,
} from "../api-types.ts";
import { resolveProjectRef } from "../manifest.ts";
import { CliError, usageError } from "../errors.ts";
import { integerOption } from "../args.ts";
import { stringOption } from "../util.ts";
import { outputStyle, renderTable } from "../output.ts";

interface ListedSite {
  project_id?: string;
  slug?: string;
  title?: string;
  access_mode?: string;
  updated_at?: string;
}

interface ListData {
  items: ListedSite[];
  cursor: string | null;
}

interface InfoData {
  project_id?: string;
  slug?: string;
  title?: string;
  url: string | null;
  access_mode?: string;
  created_at?: string;
  updated_at?: string;
  latest_version_number: number | null;
  latest_version_id: string | null;
  custom_domains: Array<{ hostname?: string; status?: string }>;
  mcp_connection?: Record<string, unknown> | null;
}

export function registerSiteCommands(define: DefineCommand): void {
  define({
    path: ["list"],
    flags: ["limit", "cursor", "role", "all"],
    positionals: { min: 0, max: 0 },
    summary: "List your sites",
    usage: "sites list [--limit 20] [--cursor <cursor>] [--role owner|editor|viewer] [--all]",
    run: async (ctx): Promise<CommandResult<ListData>> => {
      const limit = integerOption(ctx.options, "limit", { min: 1, max: 100, fallback: 20 });
      const role = stringOption(ctx.options, "role");
      if (role !== undefined && !["owner", "editor", "viewer"].includes(role)) {
        throw usageError("USAGE_INVALID_ROLE", `Invalid --role value: ${role}`, {
          hint: "Use owner, editor, or viewer.",
        });
      }

      const items: ListedSite[] = [];
      let cursor = stringOption(ctx.options, "cursor");
      let lastCursor: string | null = null;
      const pageLimit = ctx.options.all ? 100 : limit;
      const seen = new Set<string>();
      if (cursor) seen.add(cursor);

      for (let page = 0; page < 50; page += 1) {
        const args: Record<string, unknown> = { limit: pageLimit };
        if (cursor) args.cursor = cursor;
        if (role) args.role = role;
        const result = await ctx.mcp().callTool<ListSitesResult>("sites.list_sites", args);
        for (const item of result.items ?? []) {
          items.push({
            project_id: item.id ?? item.project_id,
            slug: item.slug,
            title: item.title,
            access_mode: item.access_mode,
            updated_at: item.updated_at,
          });
        }
        lastCursor = result.cursor ?? null;
        if (!ctx.options.all || !lastCursor) break;
        if (seen.has(lastCursor))
          throw new CliError(
            "PAGINATION_STALLED",
            "The site cursor repeated; refusing an infinite --all loop.",
          );
        if (page === 49)
          throw new CliError(
            "PAGINATION_LIMIT",
            "More than 50 pages were returned; continue with --cursor.",
            { details: { cursor: lastCursor } },
          );
        seen.add(lastCursor);
        cursor = lastCursor;
      }

      return {
        data: { items, cursor: lastCursor },
        human: (value) => {
          const style = outputStyle(ctx);
          if (!value.items.length) {
            ctx.stdout.write(style.dim("No sites.") + "\n");
            return;
          }
          renderTable(
            ctx.stdout,
            ["SLUG", "PROJECT_ID", "ACCESS", "UPDATED"].map(style.heading),
            value.items.map((item) => [
              item.slug ?? "",
              style.id(item.project_id ?? ""),
              item.access_mode ?? "",
              style.dim(item.updated_at ?? ""),
            ]),
          );
        },
      };
    },
  });

  define({
    path: ["info"],
    flags: ["mcp"],
    positionals: { min: 0, max: 1, names: ["project_id|slug"] },
    summary: "Show site details",
    usage: "sites info [<project_id|slug>] [--mcp]",
    run: async (ctx): Promise<CommandResult<InfoData>> => {
      const projectId = await resolveProjectRef(ctx.positionals[0], ctx.mcp(), ctx.root);
      const site = await ctx.mcp().callTool<SiteRecord>("sites.get_site", {
        project_id: projectId,
        ...(ctx.options.mcp ? { include_mcp_connection: true } : {}),
      });
      const [versions, domains] = await Promise.all([
        ctx
          .mcp()
          .callTool<ListVersionsResult>("sites.list_site_versions", {
            project_id: projectId,
            limit: 1,
          })
          .catch(() => ({ items: [] as SiteVersionRecord[] })),
        ctx
          .mcp()
          .callTool<ListCustomDomainsResult>("sites.list_custom_domains", { project_id: projectId })
          .catch(() => ({ items: [] as CustomDomainRecord[] })),
      ]);
      const latest = (versions.items ?? [])[0] ?? null;

      const data: InfoData = {
        project_id: site.id ?? projectId,
        slug: site.slug,
        title: site.title,
        url: site.url ?? site.current_live_url ?? site.expected_url ?? null,
        access_mode: site.access_mode,
        created_at: site.created_at,
        updated_at: site.updated_at,
        latest_version_number: site.latest_version_number ?? latest?.version_number ?? null,
        latest_version_id: latest?.id ?? null,
        custom_domains: (domains.items ?? []).map((domain) => ({
          hostname: domain.hostname,
          status: domain.status,
        })),
        ...(ctx.options.mcp ? { mcp_connection: site.mcp_connection ?? null } : {}),
      };

      return {
        data,
        human: (value) => {
          const style = outputStyle(ctx);
          const lines = [
            `${style.label("Site:")} ${value.title ?? value.slug} (${value.slug})`,
            `${style.label("ID:")} ${style.id(value.project_id ?? "-")}`,
            `${style.label("URL:")} ${value.url ? style.url(value.url) : style.dim("not deployed")}`,
            `${style.label("Access:")} ${value.access_mode ?? "unknown"}`,
            `${style.label("Latest version:")} ${value.latest_version_number ?? "-"}`,
          ];
          if (value.custom_domains.length) {
            lines.push(
              `${style.label("Custom domains:")} ${value.custom_domains.map((d) => `${d.hostname ?? ""} (${style.status(d.status ?? "")})`).join(", ")}`,
            );
          }
          ctx.stdout.write(lines.join("\n") + "\n");
        },
      };
    },
  });
}
