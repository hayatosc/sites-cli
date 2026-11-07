// Deployment status polling (plan §5.4).

import { CliError, EXIT } from "./errors.ts";
import type { DeploymentRecord } from "./api-types.ts";
import type { CommandContext } from "./types.ts";
import { sleep } from "./util.ts";

export const ACTIVE_STATES = new Set(["pending", "publishing", "building"]);
export const TERMINAL_STATES = new Set(["succeeded", "failed", "error"]);

export interface PollOptions {
  projectId: string;
  deploymentId: string;
  timeoutSeconds: number;
  intervalSeconds?: number;
  log?: (text: string) => void;
}

function messageOf(record: DeploymentRecord): string | undefined {
  const value = record.failure_message;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function pollDeployment(
  ctx: CommandContext,
  options: PollOptions,
): Promise<DeploymentRecord> {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  const interval = Math.max(250, (options.intervalSeconds ?? 2) * 1000);
  let lastStatus: string | null = null;

  for (;;) {
    const record = await ctx.mcp().callTool<DeploymentRecord>("sites.get_deployment_status", {
      project_id: options.projectId,
      deployment_id: options.deploymentId,
    });
    const status = record.status ?? "unknown";
    if (status !== lastStatus) {
      options.log?.(status);
      lastStatus = status;
    }
    if (status === "succeeded") return record;
    if (status === "failed" || status === "error") {
      throw new CliError("DEPLOY_FAILED", `Deployment ${status}.`, {
        exitCode: EXIT.GENERAL,
        hint: "Run `sites logs --errors-only` to inspect the failure.",
        details: { failure_message: messageOf(record), deployment_id: options.deploymentId },
      });
    }
    if (Date.now() >= deadline) {
      throw new CliError(
        "DEPLOY_TIMEOUT",
        `Deployment did not finish within ${options.timeoutSeconds}s.`,
        {
          exitCode: EXIT.NETWORK,
          hint: `Run \`sites status ${options.deploymentId}\` to keep checking.`,
          details: { status, deployment_id: options.deploymentId },
        },
      );
    }
    await sleep(interval);
  }
}
