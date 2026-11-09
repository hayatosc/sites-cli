// `sites env` (plan §4).

import fs from "node:fs";
import path from "node:path";
import type { CommandContext, CommandResult, DefineCommand } from "../types.ts";
import type { EnvironmentEntry, EnvironmentResult } from "../api-types.ts";
import { projectIdFromManifest, resolveProjectRef } from "../manifest.ts";
import { CliError, EXIT, usageError } from "../errors.ts";
import { booleanOption, stringOption } from "../util.ts";
import { readEnvFile } from "../env-file.ts";
import { confirmDestructive } from "../prompt.ts";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface EnvListData {
  project_id: string;
  revision: number | null;
  entries: Array<{ key: string; type: string; is_secret: boolean; value: string | null }>;
}

interface EnvValueData {
  project_id: string;
  key: string;
  value: string | null;
  is_secret: boolean;
  type: string;
}

function entriesOf(result: EnvironmentResult): EnvironmentEntry[] {
  const alternative = (result as { variables?: EnvironmentEntry[] }).variables;
  return result.entries ?? alternative ?? [];
}

function requireKey(raw: string | undefined): string {
  if (!raw) {
    throw usageError("USAGE_MISSING_ARGUMENT", "Pass an environment variable name.", {
      hint: "Example: sites env get API_URL",
    });
  }
  if (!KEY_PATTERN.test(raw)) {
    throw usageError("USAGE_INVALID_VALUE", `Invalid environment variable name: ${raw}`);
  }
  return raw;
}

function parseAssignment(raw: string | undefined): { key: string; value: string } {
  if (!raw) {
    throw usageError("USAGE_MISSING_ARGUMENT", "Pass KEY=VALUE.", {
      hint: "Example: sites env set API_URL=https://example.test",
    });
  }
  const equal = raw.indexOf("=");
  if (equal <= 0) {
    throw usageError("USAGE_INVALID_VALUE", "Pass KEY=VALUE.", {
      hint: "Example: sites env set API_URL=https://example.test",
    });
  }
  const key = raw.slice(0, equal);
  if (!KEY_PATTERN.test(key)) {
    throw usageError("USAGE_INVALID_VALUE", `Invalid environment variable name: ${key}`);
  }
  return { key, value: raw.slice(equal + 1) };
}

function table(ctx: CommandContext, header: string[], rows: string[][]): void {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index].length)),
  );
  const render = (row: string[]): string =>
    row
      .map((cell, index) => cell.padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  ctx.stdout.write([render(header), ...rows.map(render)].join("\n") + "\n");
}

export function registerEnvCommands(define: DefineCommand): void {
  define({
    path: ["env", "list"],
    flags: [],
    positionals: { min: 0, max: 0 },
    summary: "List environment variables",
    usage: "sites env list",
    run: async (ctx): Promise<CommandResult<EnvListData>> => {
      const projectId = await resolveProjectRef(undefined, ctx.mcp(), ctx.root);
      const environment = await ctx.mcp().callTool<EnvironmentResult>("sites.get_environment", {
        project_id: projectId,
      });
      const entries = entriesOf(environment).map((entry) => ({
        key: entry.key ?? "",
        type: entry.type ?? "envvar",
        is_secret: Boolean(entry.is_secret),
        value: entry.is_secret ? null : (entry.value ?? null),
      }));
      return {
        data: { project_id: projectId, revision: environment.revision ?? null, entries },
        human: (value) => {
          if (!value.entries.length) {
            ctx.stdout.write("No environment variables.\n");
            return;
          }
          table(
            ctx,
            ["KEY", "TYPE", "VALUE"],
            value.entries.map((entry) => [
              entry.key,
              entry.is_secret ? "secret" : entry.type,
              entry.is_secret ? "(secret)" : (entry.value ?? ""),
            ]),
          );
          if (value.revision !== null) ctx.stdout.write(`revision: ${value.revision}\n`);
        },
      };
    },
  });

  define({
    path: ["env", "get"],
    flags: [],
    positionals: { min: 1, max: 1, names: ["KEY"] },
    summary: "Show one environment variable",
    usage: "sites env get <KEY>",
    run: async (ctx): Promise<CommandResult<EnvValueData>> => {
      const key = requireKey(ctx.positionals[0]);
      const projectId = await resolveProjectRef(undefined, ctx.mcp(), ctx.root);
      const environment = await ctx.mcp().callTool<EnvironmentResult>("sites.get_environment", {
        project_id: projectId,
      });
      const entry = entriesOf(environment).find((item) => item.key === key);
      if (!entry) {
        throw new CliError("ENV_NOT_FOUND", `Environment variable ${key} is not set.`, {
          exitCode: EXIT.PREFLIGHT,
          hint: "Run `sites env list` to see the current variables.",
        });
      }
      if (entry.is_secret) {
        throw new CliError(
          "ENV_SECRET_NOT_READABLE",
          `${key} is a secret and cannot be read back.`,
          {
            exitCode: EXIT.PREFLIGHT,
            hint: "Secrets are write-only; set a new value with `sites env set KEY=VALUE --secret`.",
          },
        );
      }
      return {
        data: {
          project_id: projectId,
          key,
          value: entry.value ?? null,
          is_secret: false,
          type: entry.type ?? "envvar",
        },
        human: (value) => {
          ctx.stdout.write(`${value.value ?? ""}\n`);
        },
      };
    },
  });

  define({
    path: ["env", "set"],
    flags: ["secret"],
    positionals: { min: 1, max: 1, names: ["KEY=VALUE"] },
    summary: "Set an environment variable",
    usage: "sites env set <KEY>=<VALUE> [--secret]",
    run: async (ctx): Promise<CommandResult<EnvValueData>> => {
      const assignment = parseAssignment(ctx.positionals[0]);
      const secret = booleanOption(ctx.options, "secret");
      const projectId = await resolveProjectRef(undefined, ctx.mcp(), ctx.root);
      await ctx.mcp().callTool("sites.update_environment_variables", {
        project_id: projectId,
        set_values: [
          { key: assignment.key, value: assignment.value, is_secret: secret, type: "envvar" },
        ],
      });
      ctx.success(`Set ${assignment.key}`);
      return {
        data: {
          project_id: projectId,
          key: assignment.key,
          value: secret ? null : assignment.value,
          is_secret: secret,
          type: "envvar",
        },
        human: (value) => {
          ctx.stdout.write(
            `Set ${value.key}${value.is_secret ? " (secret)" : ""}. It will apply on the next deploy.\n`,
          );
        },
      };
    },
  });

  define({
    path: ["env", "unset"],
    flags: ["force"],
    positionals: { min: 1, max: 1, names: ["KEY"] },
    summary: "Remove an environment variable",
    usage: "sites env unset <KEY> [--force]",
    run: async (ctx): Promise<CommandResult<{ project_id: string; removed: string }>> => {
      const key = requireKey(ctx.positionals[0]);
      const projectId = await resolveProjectRef(undefined, ctx.mcp(), ctx.root);
      if (
        !(await confirmDestructive(
          ctx,
          `environment variable ${key}`,
          booleanOption(ctx.options, "force"),
          "removes",
        ))
      ) {
        throw new CliError("CANCELLED", "Environment removal cancelled.", {
          exitCode: EXIT.INTERRUPT,
        });
      }
      await ctx.mcp().callTool("sites.update_environment_variables", {
        project_id: projectId,
        remove: [key],
      });
      ctx.success(`Removed ${key}`);
      return {
        data: { project_id: projectId, removed: key },
        human: (value) => {
          ctx.stdout.write(`Removed ${value.removed}. It will apply on the next deploy.\n`);
        },
      };
    },
  });

  define({
    path: ["env", "pull"],
    flags: ["out"],
    positionals: { min: 0, max: 0 },
    summary: "Write environment variables to a .env file",
    usage: "sites env pull [--out .env]",
    run: async (
      ctx,
    ): Promise<
      CommandResult<{ project_id: string; out: string; keys: string[]; secrets_skipped: number }>
    > => {
      const projectId = await resolveProjectRef(undefined, ctx.mcp(), ctx.root);
      const environment = await ctx.mcp().callTool<EnvironmentResult>("sites.get_environment", {
        project_id: projectId,
      });
      const entries = entriesOf(environment);
      const out = stringOption(ctx.options, "out") ?? ".env";
      const absolute = path.isAbsolute(out) ? out : path.join(ctx.root, out);
      const lines: string[] = [];
      let secretsSkipped = 0;
      for (const entry of entries) {
        if (!entry.key) continue;
        if (entry.is_secret) {
          secretsSkipped += 1;
          lines.push(`# ${entry.key} (secret, value not readable; set it with sites env set)`);
        } else {
          lines.push(`${requireKey(entry.key)}=${JSON.stringify(entry.value ?? "")}`);
        }
      }
      const temporary = `${absolute}.${process.pid}.tmp`;
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(temporary, lines.length ? lines.join("\n") + "\n" : "", {
        mode: 0o600,
        flag: "wx",
      });
      try {
        fs.renameSync(temporary, absolute);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      return {
        data: {
          project_id: projectId,
          out,
          keys: entries.map((entry) => entry.key ?? "").filter(Boolean),
          secrets_skipped: secretsSkipped,
        },
        human: (value) => {
          ctx.stdout.write(`Wrote ${value.keys.length} keys to ${value.out}.\n`);
          if (value.secrets_skipped) {
            ctx.stdout.write(
              `Left ${value.secrets_skipped} secret values as comments because they cannot be read back.\n`,
            );
          }
        },
      };
    },
  });

  define({
    path: ["env", "push"],
    nativeDryRun: true,
    flags: ["env-file", "dry-run"],
    positionals: { min: 0, max: 0 },
    summary: "Upload variables from a .env file",
    usage: "sites env push [--env-file .env] [--dry-run]",
    run: async (
      ctx,
    ): Promise<CommandResult<{ project_id: string | null; keys: string[]; dry_run: boolean }>> => {
      const file = stringOption(ctx.options, "env-file") ?? ".env";
      const entries = readEnvFile(ctx.root, file);
      const dryRun = booleanOption(ctx.options, "dry-run");
      const projectId = dryRun
        ? projectIdFromManifest(ctx.root)
        : await resolveProjectRef(undefined, ctx.mcp(), ctx.root);
      if (!dryRun && entries.length) {
        await ctx.mcp().callTool("sites.update_environment_variables", {
          project_id: projectId,
          set_values: entries.map((entry) => ({ ...entry, is_secret: false, type: "envvar" })),
        });
      }
      if (!dryRun) ctx.success(`Updated ${entries.length} environment keys`);
      return {
        data: { project_id: projectId, keys: entries.map((entry) => entry.key), dry_run: dryRun },
        human: (value) => {
          if (value.dry_run) {
            ctx.stdout.write(`Dry run: would update ${value.keys.length} keys.\n`);
          } else {
            ctx.stdout.write(
              `Updated ${value.keys.length} keys. They will apply on the next deploy.\n`,
            );
          }
        },
      };
    },
  });
}
