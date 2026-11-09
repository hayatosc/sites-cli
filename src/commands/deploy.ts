// `sites deploy`, `sites status`, and `sites logs` (plan §5).

import { runDeploy } from "../deploy.ts";
import { CliError, EXIT } from "../errors.ts";
import { readManifest, readState } from "../manifest.ts";
import type { CommandContext, CommandResult, DefineCommand } from "../types.ts";
import type { DeploymentRecord, WorkerLogsResult } from "../api-types.ts";
import { integerOption } from "../args.ts";
import { colorEnabled, paint } from "../output.ts";
import { registerCleanup, sleep } from "../util.ts";

const ACTIVE = new Set(["pending", "publishing", "building"]);

interface StatusData {
  deployment_id: string;
  status: string;
  url: string | null;
  failure_message: string | null;
  env_set_revision: number | null;
}

interface LogEvent {
  id?: string;
  timestamp?: string;
  level?: string;
  message?: string;
  stack?: string;
  [key: string]: unknown;
}

interface LogsData {
  events: LogEvent[];
  errors_only: boolean;
}

function requireProject(ctx: CommandContext): string {
  const manifest = readManifest(ctx.root).manifest;
  if (!manifest.project_id) {
    throw new CliError("PREFLIGHT_NO_PROJECT", "hosting.json has no project_id.", {
      exitCode: EXIT.PREFLIGHT,
      hint: "Run `sites create <slug>` first.",
    });
  }
  return manifest.project_id;
}

function toStatus(record: DeploymentRecord): StatusData {
  return {
    deployment_id: (record.id ?? record.deployment_id ?? "") as string,
    status: record.status ?? "unknown",
    url: record.url ?? null,
    failure_message: record.failure_message ?? null,
    env_set_revision: record.env_set_revision ?? null,
  };
}

function parseSince(value: string): number {
  const match = /^(\d+)([mhd])$/.exec(value);
  if (!match) {
    throw new CliError("USAGE_INVALID_VALUE", `Invalid --since value: ${value}`, {
      exitCode: EXIT.USAGE,
      hint: "Use a duration such as 30m, 2h, or 1d.",
    });
  }
  const amount = Number(match[1]);
  const minutes = amount * (match[2] === "d" ? 1440 : match[2] === "h" ? 60 : 1);
  if (!Number.isSafeInteger(minutes) || minutes <= 0) {
    throw new CliError("USAGE_INVALID_VALUE", `Invalid --since value: ${value}`, {
      exitCode: EXIT.USAGE,
    });
  }
  return minutes;
}

function messageOf(event: LogEvent): string {
  if (event.message) return event.message;
  const source = event.source as { message?: string; exception?: { stack?: string } } | undefined;
  return source?.message ?? source?.exception?.stack ?? JSON.stringify(event);
}

export function registerDeployCommands(define: DefineCommand): void {
  define({
    path: ["deploy"],
    nativeDryRun: true,
    flags: [
      "dry-run",
      "prebuilt",
      "force",
      "no-build-script",
      "message",
      "tag",
      "private",
      "public",
      "workspace",
      "env-file",
      "secrets-file",
      "no-source-sync",
      "allow-dirty",
      "allow-unsupported",
      "timeout",
    ],
    positionals: { min: 0, max: 0 },
    summary: "Build, upload, and deploy the current site",
    usage:
      "sites deploy [--dry-run] [--prebuilt] [--message <text>] [--private|--public|--workspace] [--force] [--timeout 300]",
    run: async (ctx): Promise<CommandResult<Awaited<ReturnType<typeof runDeploy>>>> => {
      const data = await runDeploy(ctx);
      return {
        data,
        human: (value) => {
          if (value.dry_run) {
            ctx.stdout.write(`Dry run OK (${value.kind ?? "site"}).\n`);
            return;
          }
          const lines = [
            `Deployed ${value.project_id}`,
            `URL: ${value.url ? paint(value.url, "32", colorEnabled(ctx.stdout, ctx.options, ctx.env)) : "(pending)"}`,
            `Version: ${value.version_number ?? "-"} (${value.version_id ?? "-"})`,
            `Deployment: ${value.deployment_id ?? "-"} ${value.status}`,
          ];
          if (value.access_mode) lines.push(`Access: ${value.access_mode}`);
          ctx.stdout.write(lines.join("\n") + "\n");
        },
      };
    },
  });

  define({
    path: ["status"],
    flags: ["watch", "interval", "timeout"],
    positionals: { min: 0, max: 1, names: ["deployment_id"] },
    summary: "Show deployment status",
    usage: "sites status [<deployment_id>] [--watch] [--interval 3] [--timeout 300]",
    run: async (ctx): Promise<CommandResult<StatusData>> => {
      const projectId = requireProject(ctx);
      const deploymentId = ctx.positionals[0] ?? readState(ctx.root).last_deployment_id;
      if (!deploymentId) {
        throw new CliError("PREFLIGHT_NO_DEPLOYMENT", "No deployment id is available.", {
          exitCode: EXIT.PREFLIGHT,
          hint: "Run `sites deploy` first or pass a deployment id.",
        });
      }
      const interval = integerOption(ctx.options, "interval", { min: 1, max: 300, fallback: 3 });
      const timeout = integerOption(ctx.options, "timeout", { min: 1, max: 86_400, fallback: 300 });
      const watch = Boolean(ctx.options.watch);
      const deadline = Date.now() + timeout * 1000;
      let current = toStatus(
        await ctx.mcp().callTool<DeploymentRecord>("sites.get_deployment_status", {
          project_id: projectId,
          deployment_id: deploymentId,
        }),
      );
      while (watch && ACTIVE.has(current.status)) {
        if (Date.now() >= deadline) {
          throw new CliError("DEPLOY_TIMEOUT", `Status did not settle within ${timeout}s.`, {
            exitCode: EXIT.NETWORK,
            details: { deployment_id: deploymentId, status: current.status },
          });
        }
        ctx.log(current.status);
        await sleep(Math.min(interval * 1000, Math.max(0, deadline - Date.now())));
        current = toStatus(
          await ctx.mcp().callTool<DeploymentRecord>("sites.get_deployment_status", {
            project_id: projectId,
            deployment_id: deploymentId,
          }),
        );
      }
      const failed = current.status === "failed" || current.status === "error";
      return {
        data: current,
        ...(failed ? { exitCode: EXIT.GENERAL } : {}),
        human: (value) => {
          ctx.stdout.write(`Deployment: ${value.deployment_id}\n`);
          ctx.stdout.write(`Status: ${value.status}\n`);
          if (value.url) ctx.stdout.write(`URL: ${value.url}\n`);
          if (value.failure_message) ctx.stdout.write(`Failure: ${value.failure_message}\n`);
        },
      };
    },
  });

  define({
    path: ["logs"],
    flags: ["since", "limit", "errors-only", "all", "follow"],
    positionals: { min: 0, max: 0 },
    summary: "Show recent worker logs",
    usage: "sites logs [--since 30m] [--limit 100] [--errors-only|--all] [--follow]",
    run: async (ctx): Promise<CommandResult<LogsData>> => {
      const projectId = requireProject(ctx);
      const sinceMinutes = parseSince(
        typeof ctx.options.since === "string" ? ctx.options.since : "30m",
      );
      const limit = integerOption(ctx.options, "limit", { min: 1, max: 1000, fallback: 100 });
      const errorsOnly = Boolean(ctx.options["errors-only"]) && !ctx.options.all;
      const follow = Boolean(ctx.options.follow);
      const baseInterval = Number(ctx.env.SITES_LOG_INTERVAL_MS ?? 5000);
      if (follow && (!Number.isFinite(baseInterval) || baseInterval < 1))
        throw new CliError("USAGE_INVALID_VALUE", "SITES_LOG_INTERVAL_MS must be positive.", {
          exitCode: EXIT.USAGE,
        });
      let stopped = false;
      if (follow)
        registerCleanup(() => {
          stopped = true;
        });
      const events: LogEvent[] = [];
      const seen = new Set<string>();

      const fetchOnce = async (): Promise<void> => {
        const result = await ctx.mcp().callTool<WorkerLogsResult>("sites.get_site_worker_logs", {
          project_id: projectId,
          since_minutes: sinceMinutes,
          limit,
          errors_only: errorsOnly,
        });
        for (const raw of result.events ?? []) {
          const event = raw as LogEvent;
          const key = `${event.id ?? ""}|${event.timestamp ?? ""}|${event.level ?? ""}|${messageOf(event)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (!follow) events.push(event);
          if (seen.size > limit * 10) {
            const oldest = seen.keys().next().value;
            if (oldest !== undefined) seen.delete(oldest);
          }
          if (ctx.json && follow) ctx.stdout.write(JSON.stringify(event) + "\n");
          if (!ctx.json) {
            ctx.stdout.write(
              `${event.timestamp ?? "-"} ${event.level ?? "info"} ${messageOf(event)}\n`,
            );
          }
        }
      };

      await fetchOnce();
      if (follow) {
        let interval = baseInterval;
        while (!stopped) {
          await sleep(interval);
          if (stopped) break;
          try {
            await fetchOnce();
            interval = baseInterval;
          } catch (error) {
            if (error instanceof CliError && error.code === "RATE_LIMITED") {
              interval = Math.min(interval * 2, 60_000);
              ctx.log(`rate limited; polling again in ${Math.round(interval / 1000)}s`);
              continue;
            }
            throw error;
          }
        }
      }

      return {
        data: { events, errors_only: errorsOnly },
        ...(follow ? { raw: "" } : {}),
        human: (value) => {
          if (!value.events.length) ctx.stdout.write("No log events.\n");
        },
      };
    },
  });
}
