// `sites versions` (plan §4).

import type { CommandContext, CommandResult, DefineCommand } from "../types.ts";
import type {
  DeploymentRecord,
  ListVersionsResult,
  SiteRecord,
  SiteVersionRecord,
} from "../api-types.ts";
import { readState, resolveProjectRef, writeState } from "../manifest.ts";
import { runDeploy } from "../deploy.ts";
import { confirmDestructive } from "../prompt.ts";
import { CliError, EXIT, usageError } from "../errors.ts";
import { integerOption } from "../args.ts";
import { stringOption } from "../util.ts";
import { renderTable } from "../output.ts";

interface VersionSummary {
  version_id: string;
  version_number: number | null;
  commit_sha: string | null;
  deployment_id: string | null;
  created_at: string | null;
}

interface VersionListData {
  items: VersionSummary[];
  cursor: string | null;
}

interface VersionShowData extends VersionSummary {
  project_id: string;
  version: Record<string, unknown>;
  deployment: DeploymentRecord | null;
}

interface RollbackData {
  project_id: string;
  version_id: string;
  deployment_id: string | null;
  status: string;
  url: string | null;
  access_mode: string;
}

function summarize(version: SiteVersionRecord): VersionSummary {
  return {
    version_id: version.id ?? "",
    version_number: version.version_number ?? null,
    commit_sha: version.source?.commit_sha ?? null,
    deployment_id: version.deployment_id ?? null,
    created_at: version.created_at ?? null,
  };
}

async function previousVersion(ctx: CommandContext, projectId: string): Promise<string> {
  const state = readState(ctx.root);
  if (!state.last_deployment_id) {
    throw usageError(
      "PREFLIGHT_UNKNOWN_ACTIVE_VERSION",
      "The active deployment is not recorded locally.",
      {
        hint: "Pass an explicit version_id from `sites versions list` instead of --previous.",
      },
    );
  }
  const active = await ctx.mcp().callTool<DeploymentRecord>("sites.get_deployment_status", {
    project_id: projectId,
    deployment_id: state.last_deployment_id,
  });
  const activeId = active.version_id;
  if (active.status !== "succeeded" || !activeId) {
    throw usageError(
      "PREFLIGHT_UNKNOWN_ACTIVE_VERSION",
      "The active version cannot be established from the recorded deployment.",
      {
        hint: "Check `sites status` or pass an explicit version_id.",
      },
    );
  }
  let foundActive = false;
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 50; page++) {
    const result = await ctx.mcp().callTool<ListVersionsResult>("sites.list_site_versions", {
      project_id: projectId,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const version of result.items ?? []) {
      if (version.id === activeId) {
        foundActive = true;
        continue;
      }
      if (!foundActive || !version.id || !version.deployment_id) continue;
      const deployment = await ctx.mcp().callTool<DeploymentRecord>("sites.get_deployment_status", {
        project_id: projectId,
        deployment_id: version.deployment_id,
      });
      if (deployment.status === "succeeded") return version.id;
    }
    cursor = result.cursor ?? undefined;
    if (!cursor) break;
    if (seen.has(cursor)) throw new CliError("PAGINATION_STALLED", "The version cursor repeated.");
    seen.add(cursor);
  }
  throw new CliError("NOT_FOUND_VERSION", "No earlier successfully deployed version was found.", {
    hint: "Pass an explicit version_id from `sites versions list`.",
  });
}

export function registerVersionCommands(define: DefineCommand): void {
  define({
    path: ["versions", "create"],
    nativeDryRun: true,
    flags: [
      "prebuilt",
      "no-build-script",
      "message",
      "tag",
      "no-source-sync",
      "allow-dirty",
      "allow-unsupported",
    ],
    positionals: { min: 0, max: 0 },
    summary: "Upload a version without deploying it",
    usage: "sites versions create [--prebuilt] [--dry-run] [--tag <tag>] [--message <text>]",
    run: async (ctx) => ({ data: await runDeploy(ctx, { uploadOnly: true }) }),
  });
  define({
    path: ["versions", "list"],
    flags: ["limit", "cursor"],
    positionals: { min: 0, max: 0 },
    summary: "List site versions",
    usage: "sites versions list [--limit 20] [--cursor <cursor>]",
    run: async (ctx): Promise<CommandResult<VersionListData>> => {
      const limit = integerOption(ctx.options, "limit", { min: 1, max: 100, fallback: 20 });
      const projectId = await resolveProjectRef(undefined, ctx.mcp(), ctx.root);
      const args: Record<string, unknown> = { project_id: projectId, limit };
      const cursor = stringOption(ctx.options, "cursor");
      if (cursor) args.cursor = cursor;
      const result = await ctx.mcp().callTool<ListVersionsResult>("sites.list_site_versions", args);
      const items = (result.items ?? []).map(summarize);
      return {
        data: { items, cursor: result.cursor ?? null },
        human: (value) => {
          if (!value.items.length) {
            ctx.stdout.write("No versions.\n");
            return;
          }
          renderTable(
            ctx.stdout,
            ["VERSION_ID", "NUMBER", "COMMIT", "CREATED"],
            value.items.map((item) => [
              item.version_id,
              item.version_number === null ? "" : String(item.version_number),
              item.commit_sha?.slice(0, 12) ?? "",
              item.created_at ?? "",
            ]),
          );
        },
      };
    },
  });

  define({
    path: ["versions", "show"],
    flags: [],
    positionals: { min: 1, max: 1, names: ["version_id"] },
    summary: "Show a version",
    usage: "sites versions show <version_id>",
    run: async (ctx): Promise<CommandResult<VersionShowData>> => {
      const versionId = ctx.positionals[0];
      const projectId = await resolveProjectRef(undefined, ctx.mcp(), ctx.root);
      const version = await ctx.mcp().callTool<SiteVersionRecord>("sites.get_site_version", {
        project_id: projectId,
        version_id: versionId,
      });
      let deployment: DeploymentRecord | null = null;
      if (version.deployment_id) {
        try {
          deployment = await ctx.mcp().callTool<DeploymentRecord>("sites.get_deployment_status", {
            project_id: projectId,
            deployment_id: version.deployment_id,
          });
        } catch {
          deployment = null;
        }
      }
      return {
        data: {
          ...summarize(version),
          project_id: projectId,
          version: version as Record<string, unknown>,
          deployment,
        },
        human: (value) => {
          ctx.stdout.write(`version: ${value.version_id}\n`);
          ctx.stdout.write(`number: ${value.version_number ?? "-"}\n`);
          ctx.stdout.write(`commit: ${value.commit_sha ?? "-"}\n`);
          ctx.stdout.write(`deployment: ${value.deployment_id ?? "-"}\n`);
          if (value.deployment?.status) ctx.stdout.write(`status: ${value.deployment.status}\n`);
          if (value.deployment?.url) ctx.stdout.write(`url: ${value.deployment.url}\n`);
        },
      };
    },
  });

  define({
    path: ["versions", "rollback"],
    flags: ["previous", "force"],
    positionals: { min: 0, max: 1, names: ["version_id|--previous"] },
    summary: "Redeploy an existing version",
    usage: "sites versions rollback <version_id|--previous> [--force]",
    run: async (ctx): Promise<CommandResult<RollbackData>> => {
      let versionId = ctx.positionals[0] ?? "";
      if (ctx.options.previous && versionId) {
        throw usageError(
          "USAGE_UNEXPECTED_ARGUMENT",
          "Pass either a version_id or --previous, not both.",
        );
      }
      if (!versionId && !ctx.options.previous) {
        throw usageError("USAGE_MISSING_ARGUMENT", "Pass a version_id or --previous.", {
          hint: "Run `sites versions list` to find a version.",
        });
      }
      const projectId = await resolveProjectRef(undefined, ctx.mcp(), ctx.root);
      if (ctx.options.previous) versionId = await previousVersion(ctx, projectId);
      const site = await ctx
        .mcp()
        .callTool<SiteRecord>("sites.get_site", { project_id: projectId });
      if (
        !(await confirmDestructive(
          ctx,
          `site ${projectId} to version ${versionId}`,
          Boolean(ctx.options.force),
          "rolls back",
        ))
      ) {
        throw new CliError("CANCELLED", "Rollback cancelled.", { exitCode: EXIT.INTERRUPT });
      }
      const accessMode = site.access_mode ?? "custom";
      const tool =
        accessMode === "custom" ? "sites.deploy_private_site_version" : "sites.deploy_site_version";
      const deployment = await ctx.mcp().callTool<DeploymentRecord>(tool, {
        project_id: projectId,
        version_id: versionId,
      });
      const deploymentId = (deployment.id ?? deployment.deployment_id ?? null) as string | null;
      if (deploymentId) {
        const state = readState(ctx.root);
        writeState(ctx.root, {
          ...state,
          last_deployment_id: deploymentId,
          ...(deployment.status === "succeeded" ? { last_version_id: versionId } : {}),
          updated_at: new Date().toISOString(),
        });
      }
      ctx.success(`Rollback requested for ${versionId}`);
      return {
        data: {
          project_id: projectId,
          version_id: versionId,
          deployment_id: deploymentId,
          status: deployment.status ?? "pending",
          url: deployment.url ?? null,
          access_mode: accessMode,
        },
        human: (value) => {
          ctx.stdout.write(`Rollback requested for ${value.version_id}\n`);
          ctx.stdout.write(`deployment: ${value.deployment_id ?? "-"} (${value.status})\n`);
          if (value.url) ctx.stdout.write(`url: ${value.url}\n`);
        },
      };
    },
  });
}
