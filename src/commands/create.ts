// `sites create` (plan §4.2).

import { CliError, EXIT } from "../errors.ts";
import type { CommandContext, CommandResult, DefineCommand } from "../types.ts";
import { readManifest, writeManifest } from "../manifest.ts";
import { booleanOption, stringOption } from "../util.ts";
import type { CreateSiteResult, SourceCredential } from "../api-types.ts";

interface CreateData {
  project_id: string;
  slug: string;
  access_mode: string;
  url: string | null;
  source: { remote_url: string; branch: string } | null;
  dry_run?: boolean;
}

const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

function requestedAccess(ctx: CommandContext): "custom" | "public" | "workspace_all" {
  const values = [
    ctx.options.private ? "custom" : null,
    ctx.options.public ? "public" : null,
    ctx.options.workspace ? "workspace_all" : null,
  ].filter(Boolean) as Array<"custom" | "public" | "workspace_all">;
  if (values.length > 1) {
    throw new CliError(
      "USAGE_CONFLICTING_FLAGS",
      "Choose only one of --private, --public, or --workspace.",
      {
        exitCode: EXIT.USAGE,
      },
    );
  }
  return values[0] ?? "custom";
}

export function registerCreateCommands(define: DefineCommand): void {
  define({
    path: ["create"],
    nativeDryRun: true,
    flags: ["title", "private", "public", "workspace", "dry-run"],
    positionals: { min: 1, max: 1, names: ["slug"] },
    summary: "Create a new site",
    usage: "sites create <slug> [--title <title>] [--private|--public|--workspace] [--dry-run]",
    run: async (ctx): Promise<CommandResult<CreateData>> => {
      const slug = ctx.positionals[0];
      if (!SLUG_PATTERN.test(slug)) {
        throw new CliError("USAGE_INVALID_SLUG", `Invalid slug: ${slug}`, {
          exitCode: EXIT.USAGE,
          hint: "Use lowercase letters, digits, and hyphens, starting with a letter.",
        });
      }
      const manifest = readManifest(ctx.root).manifest;
      if (manifest.project_id) {
        throw new CliError("PREFLIGHT_PROJECT_EXISTS", "This project already has a site.", {
          exitCode: EXIT.PREFLIGHT,
          details: { project_id: manifest.project_id },
        });
      }
      const title = stringOption(ctx.options, "title") ?? slug;
      const accessMode = requestedAccess(ctx);

      if (booleanOption(ctx.options, "dry-run")) {
        return {
          data: {
            project_id: "(dry-run)",
            slug,
            access_mode: accessMode,
            url: null,
            source: null,
            dry_run: true,
          },
          human: (value) => {
            ctx.stdout.write(`Would create site ${value.slug} (${value.access_mode})\n`);
          },
        };
      }

      const client = ctx.mcp();
      await client.initialize();
      const availability = await client.callTool<{ slug?: string; available?: boolean }>(
        "sites.check_slug_availability",
        { slug },
      );
      if (availability.available === false) {
        throw new CliError("CONFLICT_SLUG_USED", `Slug is already in use: ${slug}`, {
          exitCode: EXIT.CONFLICT,
          hint: "Choose a different slug.",
        });
      }
      const created = await client.callTool<CreateSiteResult>("sites.create_site", { title, slug });
      const projectId = created.id ?? created.project_id;
      if (!projectId) {
        throw new CliError("INTERNAL_ERROR", "create_site returned no project id.");
      }
      let credential: SourceCredential | null = created.source_repository_credential ?? null;
      if (!credential) {
        credential = await client.callTool<SourceCredential>(
          "sites.create_source_repository_write_credential",
          {
            project_id: projectId,
          },
        );
      }
      if (accessMode !== "custom") {
        await client.callTool("sites.update_site_access", {
          project_id: projectId,
          access_mode: accessMode,
        });
      }
      writeManifest(ctx.root, { ...manifest, project_id: projectId });
      ctx.success(`Created site ${slug}`);

      const data: CreateData = {
        project_id: projectId,
        slug,
        access_mode: accessMode,
        url: created.expected_url ?? created.url ?? null,
        source: credential?.remote_url
          ? { remote_url: credential.remote_url, branch: credential.branch || "main" }
          : null,
      };
      return {
        data,
        human: (value) => {
          ctx.stdout.write(`Created site ${value.slug} (${value.project_id})\n`);
          if (value.url) ctx.stdout.write(`URL: ${value.url}\n`);
          ctx.stdout.write(`Access: ${value.access_mode}\n`);
          ctx.stdout.write("Next: sites deploy\n");
        },
      };
    },
  });
}
