// `sites list` and `sites info` (plan §4).

import type { CommandContext, CommandResult, DefineCommand } from "../types.ts";
import type {
  CustomDomainRecord,
  ListCustomDomainsResult,
  ListSitesResult,
  ListVersionsResult,
  SiteRecord,
  SiteVersionRecord,
} from "../api-types.ts";
import { resolveProjectRef } from "../manifest.ts";
import { usageError } from "../errors.ts";
import { integerOption, } from "../args.ts";
import { stringOption } from "../util.ts";

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

function renderTable(ctx: CommandContext, header: string[], rows: string[][]): void {
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => row[index].length)));
  const render = (row: string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
  ctx.stdout.write([render(header), ...rows.map(render)].join("\n") + "\n");
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
        cursor = lastCursor;
      }

      return {
        data: { items, cursor: lastCursor },
        human: (value) => {
          if (!value.items.length) {
            ctx.stdout.write("サイトがありません。\n");
            return;
          }
          renderTable(
            ctx,
            ["SLUG", "PROJECT_ID", "ACCESS", "UPDATED"],
            value.items.map((item) => [
              item.slug ?? "",
              item.project_id ?? "",
              item.access_mode ?? "",
              item.updated_at ?? "",
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
        ctx.mcp()
          .callTool<ListVersionsResult>("sites.list_site_versions", { project_id: projectId, limit: 1 })
          .catch(() => ({ items: [] as SiteVersionRecord[] })),
        ctx.mcp()
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
          const lines = [
            `サイト: ${value.title ?? value.slug} (${value.slug})`,
            `ID: ${value.project_id}`,
            `URL: ${value.url ?? "未デプロイ"}`,
            `公開範囲: ${value.access_mode ?? "不明"}`,
            `最新バージョン: ${value.latest_version_number ?? "-"}`,
          ];
          if (value.custom_domains.length) {
            lines.push(
              `カスタムドメイン: ${value.custom_domains.map((d) => `${d.hostname ?? ""} (${d.status ?? ""})`).join(", ")}`,
            );
          }
          ctx.stdout.write(lines.join("\n") + "\n");
        },
      };
    },
  });
}
